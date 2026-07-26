import childProcess from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { EventEmitter } from "node:events"
import { resolveModelConfig } from "./auth.js"
import { killTree } from "./kill-tree.js"

const MAX_TOOL_TURNS = 1000
const MAX_OUTPUT_CHARS = 12000

function extractTextContent(message) {
  if (!message) return ""
  if (typeof message.content === "string") return message.content
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => {
        if (typeof part === "string") return part
        if (part && typeof part === "object" && typeof part.text === "string") return part.text
        return ""
      })
      .join("")
      .trim()
  }
  return ""
}

const ACTION_TYPES = new Set(["tool", "edit", "write", "final"])

// Models frequently emit Windows paths (e.g. minicode\server\index.js) inside
// JSON string values without escaping the backslashes. Sequences like \s or \i
// are illegal JSON escapes, so JSON.parse rejects the whole object and the
// action is lost. Double up any backslash that is not part of a valid JSON
// escape so the string parses back to what the model intended.
function repairJsonEscapes(text) {
  return text.replace(/\\(?!["\\/bfnrtu])/g, "\\\\")
}

// Parse JSON, retrying with escape repair when the raw text fails.
function tryParseJson(text) {
  try {
    return JSON.parse(text)
  } catch {}
  try {
    return JSON.parse(repairJsonEscapes(text))
  } catch {}
  return undefined
}

// Scan for the first balanced {...} that parses as JSON and looks like one of
// our actions. This tolerates models that wrap the JSON in reasoning/prose, add
// trailing commentary, or emit several action objects in one message.
function extractFirstAction(text) {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < text.length; i++) {
      const ch = text[i]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === "\\") escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === "{") depth++
      else if (ch === "}") {
        depth--
        if (depth === 0) {
          const obj = tryParseJson(text.slice(start, i + 1))
          if (obj && typeof obj === "object" && ACTION_TYPES.has(obj.type)) return obj
          break // this "{" didn't yield a valid action; try the next one
        }
      }
    }
  }
  return null
}

// Heuristic: the model clearly meant to emit an action (it wrote a "type":
// "<action>" key) but parseJsonAction returned nothing, so the JSON is broken.
function looksLikeAction(text) {
  return /"type"\s*:\s*"(?:tool|edit|write|final)"/.test(text)
}

function parseJsonAction(text) {
  const trimmed = text.trim()
  const whole = tryParseJson(trimmed)
  if (whole !== undefined) return whole
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fence) {
    const fenced = tryParseJson(fence[1])
    if (fenced !== undefined) return fenced
  }
  return extractFirstAction(trimmed)
}

function truncate(value, max = MAX_OUTPUT_CHARS) {
  if (!value) return ""
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n...<truncated>`
}

// Resolve a model-supplied path against the session cwd and refuse to escape it.
function resolveInside(cwd, target) {
  if (typeof target !== "string" || !target.trim()) throw new Error("missing path")
  const resolved = path.resolve(cwd, target)
  const rel = path.relative(cwd, resolved)
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`path escapes working directory: ${target}`)
  }
  return resolved
}

async function writeFileAction(cwd, action) {
  const file = resolveInside(cwd, action.path)
  const content = typeof action.content === "string" ? action.content : ""
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content, "utf8")
  return `wrote ${content.length} chars to ${path.relative(cwd, file)}`
}

async function editFileAction(cwd, action) {
  const file = resolveInside(cwd, action.path)
  if (typeof action.find !== "string" || action.find === "") throw new Error("'find' is required")
  const replaceRaw = typeof action.replace === "string" ? action.replace : ""
  const original = await fs.readFile(file, "utf8")

  // Models usually emit "\n"; source files are often CRLF. Match against the
  // file's own line-ending style so edits don't silently fail to apply.
  const eol = original.includes("\r\n") ? "\r\n" : "\n"
  const toEol = (s) => s.replace(/\r\n/g, "\n").replace(/\n/g, eol)
  let find = action.find
  let replace = replaceRaw
  if (!original.includes(find) && original.includes(toEol(find))) {
    find = toEol(find)
    replace = toEol(replaceRaw)
  }

  const count = original.split(find).length - 1
  if (count === 0) throw new Error("'find' text not found; edit not applied")
  if (count > 1 && !action.all) {
    throw new Error(`'find' matched ${count} times; make it unique or set "all": true`)
  }
  const updated = action.all ? original.split(find).join(replace) : original.replace(find, replace)
  await fs.writeFile(file, updated, "utf8")
  const applied = action.all ? count : 1
  return `edited ${path.relative(cwd, file)} (${applied} replacement${applied === 1 ? "" : "s"})`
}

function runShellCommand(command, { cwd, onData, signal }) {
  return new Promise((resolve) => {
    const isWindows = process.platform === "win32"
    const file = isWindows ? "powershell.exe" : "bash"
    const args = isWindows ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-lc", command]
    const proc = childProcess.spawn(file, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: !isWindows, // own process group on POSIX so we can signal the tree
    })

    let output = ""
    let timedOut = false
    let settled = false

    // proc.kill() only signals the top-level shell. Commands that spawn their
    // own children (nested powershell, node, dev servers, …) would otherwise
    // survive, keep the stdout/stderr pipes open, and 'close' would never fire —
    // wedging the whole tool loop. Kill the entire process tree instead.
    const kill = () => {
      if (!proc.killed) killTree(proc.pid)
    }

    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(fallback)
      signal?.removeEventListener("abort", abort)
      resolve({
        code: typeof code === "number" ? code : 1,
        output: timedOut ? `${output}\nCommand timed out after 120s.` : output,
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, 120000)

    // Safety net: if the tree is killed but a grandchild keeps a pipe open so
    // 'close' never arrives, still resolve shortly after the process exits.
    let fallback = null
    const armFallback = (code) => {
      if (fallback) return
      fallback = setTimeout(() => finish(code), 1000)
    }

    const abort = () => kill()
    signal?.addEventListener("abort", abort, { once: true })

    const append = (chunk) => {
      const text = chunk.toString()
      output += text
      onData?.(text)
    }
    proc.stdout.on("data", append)
    proc.stderr.on("data", append)

    proc.on("exit", (code) => armFallback(typeof code === "number" ? code : 1))
    proc.on("close", (code) => finish(code))
    proc.on("error", (error) => {
      output = `${output}\n${error.message}`.trim()
      finish(1)
    })
  })
}

async function callModel(config, messages, systemPrompt, signal) {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.2,
      messages: systemPrompt ? [{ role: "system", content: systemPrompt }, ...messages] : messages,
    }),
  })

  if (!response.ok) {
    throw new Error(`Model request failed (${response.status}): ${await response.text()}`)
  }

  const data = await response.json()
  const text = extractTextContent(data?.choices?.[0]?.message)
  if (!text) throw new Error("Model returned an empty response.")
  return text
}

/** One plain completion with no tool loop and no system prompt. */
export function callModelOnce(config, messages) {
  return callModel(config, messages, undefined, undefined)
}

/**
 * A conversational agent bound to one web pane. Conversation history persists
 * for the lifetime of the session.
 */
export class AgentSession extends EventEmitter {
  constructor({ id, cwd }) {
    super()
    this.id = id
    this.kind = "agent"
    this.cwd = cwd
    this.busy = false
    this.closed = false
    this.messages = []
    this.controller = null
    this.systemPrompt = [
      "You are a practical coding agent.",
      `You are running inside the local working directory ${cwd} and can read and modify project files.`,
      "For coding tasks, inspect files first before answering.",
      "Use non-destructive read commands like Get-ChildItem, Get-Content, and git --no-pager status/log/diff.",
      "Do not claim you cannot access files when the tools below can read them.",
      "Respond ONLY with one JSON object, one of:",
      '{"type":"tool","command":"<shell command>","reason":"<short reason>"}',
      '{"type":"write","path":"<file path>","content":"<full new file contents>","reason":"<short reason>"}',
      '{"type":"edit","path":"<file path>","find":"<exact text to replace>","replace":"<new text>","reason":"<short reason>"}',
      '{"type":"final","message":"<final user-facing response>"}',
      "To change files, ALWAYS prefer the write/edit actions over shell commands — they take plain strings and need no shell escaping.",
      "Paths are relative to the working directory. For edit, 'find' must appear exactly once (set \"all\":true to replace every occurrence).",
      "For shell commands: they are already executed via powershell.exe -Command, so NEVER wrap a command in another 'powershell -Command'.",
      "Escape quotes inside PowerShell strings with a backtick (`\"), never a backslash, and avoid && (this is Windows PowerShell 5.1).",
      "No markdown. No code fences.",
    ].join(" ")
  }

  #emitOutput(data, stream = "stdout") {
    this.emit("output", { stream, data })
  }

  async write(line) {
    const prompt = line.trim()
    if (!prompt || this.closed) return
    if (this.busy) {
      this.#emitOutput("\u001b[33mAgent is still working; wait for it to finish.\u001b[0m\r\n", "stderr")
      return
    }

    this.busy = true
    this.controller = new AbortController()
    const signal = this.controller.signal

    try {
      if (!this.config) this.config = await resolveModelConfig()
      this.messages.push({ role: "user", content: prompt })

      for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
        if (signal.aborted) throw new Error("aborted")
        const raw = await callModel(this.config, this.messages, this.systemPrompt, signal)
        const action = parseJsonAction(raw)

        if (!action || typeof action !== "object" || action.type === "final") {
          if (!action && looksLikeAction(raw)) {
            // The model tried to emit an action but the JSON was unparseable.
            // Surface it loudly in red and feed the error back so it can retry.
            this.#emitOutput("\u001b[31mCould not parse model action as JSON:\u001b[0m\r\n", "stderr")
            this.#emitOutput(`\u001b[31m${raw.replace(/\n/g, "\r\n")}\u001b[0m\r\n`, "stderr")
            this.messages.push(
              { role: "assistant", content: raw },
              {
                role: "user",
                content: [
                  "TOOL_RESULT",
                  "ok: false",
                  "result: Your previous message was not valid JSON and could not be parsed.",
                  "Respond with exactly ONE valid JSON action object and nothing else.",
                  "Remember to escape backslashes in Windows paths (write \\\\ for each \\).",
                ].join("\n"),
              },
            )
            if (turn === MAX_TOOL_TURNS - 1) {
              this.#emitOutput("\u001b[31mStopped after max tool turns.\u001b[0m\r\n", "stderr")
            }
            continue
          }
          const message = action?.type === "final" && typeof action.message === "string" ? action.message : raw
          this.messages.push({ role: "assistant", content: raw })
          this.#emitOutput(`\u001b[36m${message.replace(/\n/g, "\r\n")}\u001b[0m\r\n`)
          break
        }

        if (action.type === "write" || action.type === "edit") {
          const label =
            action.type === "write"
              ? `write ${action.path}`
              : `edit ${action.path}`
          this.#emitOutput(`\u001b[33m# ${label}\u001b[0m\r\n`)
          let summary
          let ok = true
          try {
            summary =
              action.type === "write"
                ? await writeFileAction(this.cwd, action)
                : await editFileAction(this.cwd, action)
            this.#emitOutput(`\u001b[90m${summary}\u001b[0m\r\n`)
          } catch (error) {
            ok = false
            summary = error.message
            this.#emitOutput(`\u001b[31m${summary}\u001b[0m\r\n`, "stderr")
          }
          this.messages.push(
            { role: "assistant", content: raw },
            {
              role: "user",
              content: ["TOOL_RESULT", `action: ${label}`, `ok: ${ok}`, `result: ${summary}`].join("\n"),
            },
          )
          if (turn === MAX_TOOL_TURNS - 1) {
            this.#emitOutput("\u001b[31mStopped after max tool turns.\u001b[0m\r\n", "stderr")
          }
          continue
        }

        if (action.type !== "tool" || typeof action.command !== "string" || !action.command.trim()) {
          this.#emitOutput(`\u001b[36m${raw.replace(/\n/g, "\r\n")}\u001b[0m\r\n`)
          break
        }

        const command = action.command.trim()
        this.#emitOutput(`\u001b[33m$ ${command}\u001b[0m\r\n`)
        const result = await runShellCommand(command, {
          cwd: this.cwd,
          signal,
          onData: (chunk) => this.#emitOutput(chunk.replace(/\r?\n/g, "\r\n")),
        })
        this.#emitOutput(`\u001b[90mexit code: ${result.code}\u001b[0m\r\n`)

        this.messages.push(
          { role: "assistant", content: raw },
          {
            role: "user",
            content: [
              "TOOL_RESULT",
              `command: ${command}`,
              `exitCode: ${result.code}`,
              `output:\n${truncate(result.output) || "<empty>"}`,
            ].join("\n"),
          },
        )

        if (turn === MAX_TOOL_TURNS - 1) {
          this.#emitOutput("\u001b[31mStopped after max tool turns.\u001b[0m\r\n", "stderr")
        }
      }
    } catch (error) {
      const message = signal.aborted ? "cancelled" : error.message
      this.#emitOutput(`\u001b[31m${message}\u001b[0m\r\n`, "stderr")
    } finally {
      this.busy = false
      this.controller = null
      this.emit("done", { exitCode: 0 })
    }
  }

  // Forget the conversation so far so the model context stops growing without
  // bound. Does not touch the system prompt or the current turn.
  clearContext() {
    this.messages.length = 0
  }

  interrupt() {
    this.controller?.abort()
  }

  dispose() {
    this.closed = true
    this.controller?.abort()
  }
}
