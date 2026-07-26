import childProcess from "node:child_process"
import { EventEmitter } from "node:events"
import { resolveModelConfig } from "./auth.js"

const MAX_TOOL_TURNS = 10
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

function parseJsonAction(text) {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {}
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fence) {
    try {
      return JSON.parse(fence[1])
    } catch {}
  }
  return null
}

function truncate(value, max = MAX_OUTPUT_CHARS) {
  if (!value) return ""
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n...<truncated>`
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
    })

    let output = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, 120000)

    const abort = () => proc.kill()
    signal?.addEventListener("abort", abort, { once: true })

    const append = (chunk) => {
      const text = chunk.toString()
      output += text
      onData?.(text)
    }
    proc.stdout.on("data", append)
    proc.stderr.on("data", append)

    proc.on("close", (code) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      resolve({
        code: typeof code === "number" ? code : 1,
        output: timedOut ? `${output}\nCommand timed out after 120s.` : output,
      })
    })
    proc.on("error", (error) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      resolve({ code: 1, output: `${output}\n${error.message}`.trim() })
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
      "You can run shell commands to complete user requests.",
      `You are running inside the local working directory ${cwd} and can read project files.`,
      "For coding tasks, inspect files first using shell commands before answering.",
      "Use non-destructive read commands like Get-ChildItem, Get-Content, and git --no-pager status/log/diff.",
      "Do not claim you cannot access files when shell commands can read them.",
      "Respond ONLY with one JSON object:",
      '{"type":"tool","command":"<shell command>","reason":"<short reason>"}',
      "or",
      '{"type":"final","message":"<final user-facing response>"}',
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
          const message = action?.type === "final" && typeof action.message === "string" ? action.message : raw
          this.messages.push({ role: "assistant", content: raw })
          this.#emitOutput(`\u001b[36m${message.replace(/\n/g, "\r\n")}\u001b[0m\r\n`)
          break
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

  interrupt() {
    this.controller?.abort()
  }

  dispose() {
    this.closed = true
    this.controller?.abort()
  }
}
