import childProcess from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { EventEmitter } from "node:events"
import { randomUUID } from "node:crypto"
import { stripVTControlCharacters } from "node:util"
import { resolveModelConfig } from "./auth.js"
import { killTree } from "./kill-tree.js"
import { httpErrorInfo, redactSecrets } from "./http-error.js"

const MAX_TOOL_TURNS = 1000
const MAX_OUTPUT_CHARS = 12000
const AZURE_MODEL_FALLBACK_CHAIN = [
  "gpt-5.6-sol",
  "gpt-6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-6-luna",
]
const MISSING_DEPLOYMENT_CODES = new Set(["deploymentnotfound", "model_not_found", "modelnotfound"])

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

function extractResponsesText(response) {
  if (typeof response?.output_text === "string" && response.output_text) return response.output_text
  if (!Array.isArray(response?.output)) return ""
  return response.output
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .filter((part) => part?.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim()
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

// PowerShell's formatter right-pads output lines with spaces to a fixed nominal
// width when stdout is a pipe rather than a real console. Strip that trailing
// padding so lines aren't ragged. Only trailing whitespace before line breaks
// (and at the very end) is removed, so real output is preserved.
function trimLinePadding(text) {
  if (process.platform !== "win32") return text
  return text.replace(/[ \t]+(?=\r?\n)/g, "").replace(/[ \t]+$/, "")
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

function runShellCommand(command, { cwd, onData, signal, env }) {
  return new Promise((resolve) => {
    const isWindows = process.platform === "win32"
    const file = isWindows ? "pwsh.exe" : "bash"
    const args = isWindows ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-lc", command]
    const proc = childProcess.spawn(file, args, {
      cwd,
      env: env ?? process.env,
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
      const text = trimLinePadding(chunk.toString())
      output += text
      onData?.(text)
    }
    proc.stdout.on("data", append)
    proc.stderr.on("data", append)

    proc.on("exit", (code) => armFallback(typeof code === "number" ? code : 1))
    proc.on("close", (code) => finish(code))
    proc.on("error", (error) => {
      const message = isWindows && error.code === "ENOENT"
        ? "PowerShell 7 (pwsh) is required on Windows. Install it and make pwsh.exe available on PATH."
        : error.message
      output = `${output}\n${message}`.trim()
      finish(1)
    })
  })
}

function modelFailureError(message, { model, code, status, requestId, cause, secret }) {
  const error = new Error(message, cause ? { cause } : undefined)
  model = redactSecrets(model ?? "", [secret])
  code = redactSecrets(code ?? "", [secret])
  requestId = redactSecrets(requestId ?? "", [secret])
  error.modelFailure = {
    model: /^[a-zA-Z0-9_.-]{1,100}$/.test(model ?? "") ? model : "unknown",
    code: /^[a-zA-Z0-9_.-]{1,100}$/.test(code ?? "") ? code : "model_request_failed",
    ...(status ? { httpStatus: status } : {}),
    ...(/^[a-zA-Z0-9_.-]{1,200}$/.test(requestId ?? "") ? { requestId } : {}),
  }
  return error
}

async function callModel(config, messages, systemPrompt, signal, initiator = "user", onWarning = message => console.warn(message)) {
  const isResponses = config.api === "responses"
  const start = AZURE_MODEL_FALLBACK_CHAIN.indexOf(config.model)
  const supportsFallback = isResponses && config.provider !== "github-copilot" && start !== -1
  const models = supportsFallback ? AZURE_MODEL_FALLBACK_CHAIN.slice(start) : [config.model]
  const failures = []
  for (const [index, model] of models.entries()) {
    let apiKey
    let response
    let timeoutFailure
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted()
      apiKey = config.getAccessToken ? await config.getAccessToken() : config.apiKey
      try {
        response = await fetch(config.endpoint, {
          method: "POST",
          signal,
          headers: {
            ...config.headers,
            ...(config.provider === "github-copilot" ? { "x-initiator": initiator, "X-Request-Id": randomUUID() } : {}),
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(
            isResponses
              ? {
                  model,
                  instructions: systemPrompt,
                  input: messages,
                }
              : {
                  model,
                  ...(config.provider === "github-copilot" ? {} : { temperature: 0.2 }),
                  messages: systemPrompt ? [{ role: "system", content: systemPrompt }, ...messages] : messages,
                },
          ),
        })
        break
      } catch (error) {
        if (signal?.aborted) throw error
        const code = error?.cause?.code ?? error?.code
        const detail = redactSecrets(code ? `${error.message} (${code})` : error?.message || String(error), [apiKey])
        const failure = modelFailureError(`Model request could not reach ${config.endpoint}: ${detail}`, { model, code, cause: error, secret: apiKey })
        if (!supportsFallback || code !== "UND_ERR_HEADERS_TIMEOUT") throw failure
        if (attempt === 0) {
          onWarning(`[minicode] Model ${model} headers timed out (UND_ERR_HEADERS_TIMEOUT); retrying once.`)
          continue
        }
        timeoutFailure = `Model ${model} failed after one retry: ${failure.message}`
      }
    }
    if (timeoutFailure) {
      failures.push(timeoutFailure)
      signal?.throwIfAborted()
      if (index + 1 < models.length) {
        onWarning(`[minicode] Model ${model} headers timed out (UND_ERR_HEADERS_TIMEOUT) after one retry; trying ${models[index + 1]}.`)
        continue
      }
      throw modelFailureError(`Model fallback exhausted (${models.join(" -> ")}):\n${failures.join("\n")}`, { model, code: "UND_ERR_HEADERS_TIMEOUT", secret: apiKey })
    }

    if (!response.ok) {
      const { detail, code } = await httpErrorInfo(response, [apiKey])
      const failure = `Model request failed (${response.status}) at ${config.endpoint} [model: ${model}]:\n${detail}`
      // Only skip missing deployments after an earlier model has triggered fallback.
      const missing = index > 0 && response.status === 404 && MISSING_DEPLOYMENT_CODES.has(code?.toLowerCase())
      if (models.length > 1 && (response.status === 429 || missing)) {
        failures.push(failure)
        signal?.throwIfAborted()
        const reason = missing ? "deployment is unavailable (HTTP 404)" : "rate limited (HTTP 429)"
        if (index + 1 < models.length) {
          onWarning(`[minicode] Model ${model} ${reason}; trying ${models[index + 1]}.`)
          continue
        }
        throw modelFailureError(`Model fallback exhausted (${models.join(" -> ")}):\n${failures.join("\n")}`, { model, code: code ?? "rate_limit_exceeded", status: response.status, secret: apiKey })
      }
      throw modelFailureError(failure, {
        model, code: code ?? `http_${response.status}`, status: response.status, secret: apiKey,
        requestId: response.headers?.get?.("x-request-id") ?? response.headers?.get?.("apim-request-id"),
      })
    }

    const data = await response.json()
    const text = isResponses ? extractResponsesText(data) : extractTextContent(data?.choices?.[0]?.message)
    if (!text) throw new Error("Model returned an empty response.")
    config.model = model
    return text
  }
}

/** One plain completion with no tool loop and no system prompt. */
export function callModelOnce(config, messages) {
  return callModel({ ...config }, messages, undefined, undefined)
}

/**
 * A conversational agent bound to one web pane. Conversation history persists
 * for the lifetime of the session.
 */
export class AgentSession extends EventEmitter {
  constructor({ id, cwd, env, instructions = "", tools = [], modelConfigProvider = resolveModelConfig }) {
    super()
    this.id = id
    this.kind = "agent"
    this.cwd = cwd
    this.env = env
    this.modelConfigProvider = modelConfigProvider
    this.tools = new Map()
    for (const tool of tools) {
      if (!/^[a-z][a-z0-9_]*$/.test(tool.name) || this.tools.has(tool.name)
        || typeof tool.description !== "string" || typeof tool.execute !== "function") {
        throw new Error("Invalid or duplicate harness tool")
      }
      this.tools.set(tool.name, tool)
    }
    this.busy = false
    this.closed = false
    this.messages = []
    this.controller = null
    // Each submitted prompt owns one run. Invalidating the run on Ctrl+C
    // prevents a late model response or tool completion from resuming work
    // after the browser has returned to its prompt.
    this.activeRun = null
    this.nextRunId = 0
    this.systemPrompt = [
      "You are a practical coding agent.",
      `You are running inside the local working directory ${cwd} and can read and modify project files.`,
      "For coding tasks, inspect files first before answering.",
      "Use non-destructive read commands like Get-ChildItem, Get-Content, and git --no-pager status/log/diff.",
      "Do not claim you cannot access files when the tools below can read them.",
      "Respond ONLY with one JSON object, one of:",
      '{"type":"tool","command":"<shell command>","reason":"<short reason>"}',
      ...(tools.length ? [
        '{"type":"tool","name":"<harness tool name>","arguments":{},"reason":"<short reason>"}',
        `Available harness tools (use their exact argument schemas): ${JSON.stringify(tools.map(({ name, description, parameters }) => ({ name, description, parameters })))}`,
      ] : []),
      '{"type":"write","path":"<file path>","content":"<full new file contents>","reason":"<short reason>"}',
      '{"type":"edit","path":"<file path>","find":"<exact text to replace>","replace":"<new text>","reason":"<short reason>"}',
      '{"type":"final","message":"<final user-facing response>"}',
      'For a task you cannot complete, return {"type":"final","message":"<blocker and required next step>","error":"<short failure reason>"} instead of claiming success.',
      "To change files, ALWAYS prefer the write/edit actions over shell commands — they take plain strings and need no shell escaping.",
      "Paths are relative to the working directory. For edit, 'find' must appear exactly once (set \"all\":true to replace every occurrence).",
      ...(process.platform === "win32" ? [
        "Shell commands already execute directly in PowerShell 7 (pwsh.exe -NoProfile -NonInteractive -Command). Do not wrap them in another pwsh/powershell command or switch to Windows PowerShell 5.1.",
        "Escape quotes inside PowerShell strings with a backtick (`\"), never a backslash.",
      ] : ["Shell commands already execute in bash -lc; use Bash syntax."]),
      // Scheduled tasks outlive the session, so keep every one Minicode creates in one folder the
      // user can review and clean up, and make sure the user hears about it.
      "If you create a Windows scheduled task, register it in the \\Minicode\\ task folder (for example Register-ScheduledTask -TaskPath '\\Minicode\\' -TaskName '<descriptive name>' ...), never in the root folder or another one,",
      "and say in your final message that you created it, its full path, its schedule, and how to remove it (Unregister-ScheduledTask -TaskPath '\\Minicode\\' -TaskName '<name>').",
      "No markdown. No code fences.",
    ].join(" ")
    if (instructions) this.systemPrompt += `\n\n${instructions}`
  }

  #emitOutput(data, stream = "stdout") {
    this.emit("output", { stream, data })
    if (this.activeRun && this.#isActive(this.activeRun)) {
      this.#emitActivity({
        ...this.activeRun.activity,
        kind: stream === "stderr" ? "error" : stream === "command" ? "tool_result" : "model_action",
        summary: data,
      })
    }
  }

  #emitActivity(activity) {
    if (this.listenerCount("activity") === 0) return
    const secrets = Object.entries(this.env ?? {})
      .filter(([key, value]) => /token|secret|password|api_key/i.test(key) && typeof value === "string")
      .map(([, value]) => value)
    const summary = redactSecrets(stripVTControlCharacters(activity.summary), secrets)
    this.emit("activity", { ...activity, summary: summary.length > 12000
      ? `${summary.slice(0, 11970)}\n[message truncated]` : summary })
  }

  #isActive(run) {
    return !this.closed && this.activeRun === run && !run.controller.signal.aborted
  }

  #throwIfInactive(run) {
    if (!this.#isActive(run)) throw new Error("aborted")
  }

  async write(line) {
    const prompt = line.trim()
    if (!prompt || this.closed) return
    if (this.busy) {
      this.#emitOutput("\u001b[33mAgent is still working; wait for it to finish.\u001b[0m\r\n", "stderr")
      return
    }

    const run = {
      id: ++this.nextRunId,
      controller: new AbortController(),
      // An interrupted prompt is rolled back from model context. Its commands
      // may already have changed files, but its unfinished task cannot steer
      // the next user request.
      messageStart: this.messages.length,
    }
    this.activeRun = run
    this.busy = true
    this.controller = run.controller
    const signal = run.controller.signal
    const result = { exitCode: 0 }

    try {
      if (!this.config) {
        const config = await this.modelConfigProvider()
        this.#throwIfInactive(run)
        this.config = config
      }
      this.#throwIfInactive(run)
      const modelConfig = { ...this.config }
      this.messages.push({ role: "user", content: prompt })
      this.#emitActivity({ kind: "prompt", action: "prompt", summary: prompt })

      for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
        this.#throwIfInactive(run)
        const raw = await callModel(modelConfig, this.messages, this.systemPrompt, signal, turn === 0 ? "user" : "agent",
          message => this.#emitOutput(`\u001b[33m${message}\u001b[0m\r\n`, "stderr"))
        this.#throwIfInactive(run)
        const action = parseJsonAction(raw)
        run.activity = {
          turn: turn + 1,
          action: action?.type ?? "output",
          target: action?.type === "tool" ? action.name ?? "shell" : action?.path,
        }

        if (!action || typeof action !== "object" || action.type === "final") {
          if (!action && looksLikeAction(raw)) {
            // The model tried to emit an action but the JSON was unparseable.
            // Surface it loudly in red and feed the error back so it can retry.
            this.#emitOutput("\u001b[31mCould not parse model action as JSON:\u001b[0m\r\n", "stderr")
            this.#emitOutput(`\u001b[31m${raw.replace(/\n/g, "\r\n")}\u001b[0m\r\n`, "stderr")
            this.#throwIfInactive(run)
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
              result.exitCode = 1
              result.error = "Stopped after max tool turns"
              this.#emitOutput("\u001b[31mStopped after max tool turns.\u001b[0m\r\n", "stderr")
            }
            continue
          }
          const message = action?.type === "final" && typeof action.message === "string" ? action.message : raw
          if (action?.type === "final" && typeof action.error === "string" && action.error.trim()) {
            result.exitCode = 1
            result.error = action.error.trim()
          }
          this.#throwIfInactive(run)
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
            this.#throwIfInactive(run)
            this.#emitOutput(`\u001b[90m${summary}\u001b[0m\r\n`)
          } catch (error) {
            this.#throwIfInactive(run)
            ok = false
            summary = error.message
            this.#emitOutput(`\u001b[31m${summary}\u001b[0m\r\n`, "stderr")
          }
          this.#throwIfInactive(run)
          this.messages.push(
            { role: "assistant", content: raw },
            {
              role: "user",
              content: ["TOOL_RESULT", `action: ${label}`, `ok: ${ok}`, `result: ${summary}`].join("\n"),
            },
          )
          if (turn === MAX_TOOL_TURNS - 1) {
            result.exitCode = 1
            result.error = "Stopped after max tool turns"
            this.#emitOutput("\u001b[31mStopped after max tool turns.\u001b[0m\r\n", "stderr")
          }
          continue
        }

        if (action.type === "tool" && Object.hasOwn(action, "name")) {
          const label = `harness tool ${action.name}`
          this.#emitOutput(`# ${label}\r\n`)
          let summary, ok = true
          try {
            const tool = this.tools.get(action.name)
            if (!tool) throw new Error(`Harness tool is not enabled: ${action.name}`)
            if (Object.hasOwn(action, "command") || !action.arguments
              || typeof action.arguments !== "object" || Array.isArray(action.arguments)) {
              throw new Error("Harness tools require an arguments object and cannot include a shell command")
            }
            summary = JSON.stringify(await tool.execute(action.arguments, { signal }))
            this.#throwIfInactive(run)
            this.#emitOutput(`${summary}\r\n`, "command")
            this.#emitOutput(`# ${label} completed\r\n`)
          } catch (error) {
            this.#throwIfInactive(run)
            ok = false
            summary = error.message
            this.#emitOutput(`${summary}\r\n`, "stderr")
          }
          this.messages.push(
            { role: "assistant", content: raw },
            { role: "user", content: ["TOOL_RESULT", `action: ${label}`, `ok: ${ok}`, `result: ${truncate(summary)}`].join("\n") },
          )
          if (turn === MAX_TOOL_TURNS - 1) {
            result.exitCode = 1
            result.error = "Stopped after max tool turns"
          }
          continue
        }

        if (action.type !== "tool" || typeof action.command !== "string" || !action.command.trim()) {
          this.#emitOutput(`\u001b[36m${raw.replace(/\n/g, "\r\n")}\u001b[0m\r\n`)
          break
        }

        const command = action.command.trim()
        this.#emitOutput(`\u001b[33m$ ${command}\u001b[0m\r\n`)
        const shellResult = await runShellCommand(command, {
          cwd: this.cwd,
          env: this.config.azureConfigDir
            ? { ...(this.env ?? process.env), AZURE_CONFIG_DIR: this.config.azureConfigDir }
            : this.env,
          signal,
          // A killed process can flush buffered output after Ctrl+C. Do not
          // let output from an invalidated run appear in the next prompt.
          onData: (chunk) => {
            // Tag captured command output with its own stream so the UI can
            // tint just these lines (not the "$ command" or "exit code" lines).
            if (this.#isActive(run)) this.#emitOutput(chunk.replace(/\r?\n/g, "\r\n"), "command")
          },
        })
        this.#throwIfInactive(run)
        this.#emitOutput(`\u001b[90mexit code: ${shellResult.code}\u001b[0m\r\n`)

        this.messages.push(
          { role: "assistant", content: raw },
          {
            role: "user",
            content: [
              "TOOL_RESULT",
              `command: ${command}`,
              `exitCode: ${shellResult.code}`,
              `output:\n${truncate(shellResult.output) || "<empty>"}`,
            ].join("\n"),
          },
        )

        if (turn === MAX_TOOL_TURNS - 1) {
          result.exitCode = 1
          result.error = "Stopped after max tool turns"
          this.#emitOutput("\u001b[31mStopped after max tool turns.\u001b[0m\r\n", "stderr")
        }
      }
    } catch (error) {
      result.exitCode = signal.aborted ? 130 : 1
      result.error = signal.aborted ? "cancelled" : error.message
      if (!signal.aborted && error.modelFailure) {
        result.modelFailure = { ...error.modelFailure, occurredAt: new Date().toISOString(), contextCharacters: this.systemPrompt.length + JSON.stringify(this.messages).length }
      }
      // Ctrl+C already restored the prompt. Suppress delayed cancellation
      // output from the abandoned run so it cannot corrupt the next turn.
      if (this.#isActive(run)) {
        const message = signal.aborted ? "cancelled" : error.message
        this.#emitOutput(`\u001b[31m${message}\u001b[0m\r\n`, "stderr")
      }
    } finally {
      // An old async operation may finish after a new prompt has started;
      // only its owning run is allowed to alter session state or emit done.
      if (this.activeRun === run) {
        this.busy = false
        this.controller = null
        this.activeRun = null
        this.emit("done", result)
      }
    }
    return result
  }

  // Forget the conversation so far so the model context stops growing without
  // bound. Does not touch the system prompt or the current turn.
  clearContext() {
    this.messages.length = 0
  }

  interrupt() {
    const run = this.activeRun
    if (!run) return

    // Release the pane immediately. Abort fetches and kill any current tool,
    // then invalidate this run so late async completions cannot issue another
    // tool call, append to context, or change the busy state of a newer run.
    this.activeRun = null
    this.busy = false
    this.controller = null
    this.messages.length = run.messageStart
    run.controller.abort()
    this.emit("done", { exitCode: 130 })
  }

  dispose() {
    this.closed = true
    const run = this.activeRun
    this.activeRun = null
    this.controller = null
    run?.controller.abort()
  }
}
