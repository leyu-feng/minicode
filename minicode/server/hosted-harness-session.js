import { EventEmitter } from "node:events"
import { spawn, execFile } from "node:child_process"
import readline from "node:readline"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { startHostedHarnessBridge } from "./hosted-harness-bridge.js"
import { redactSecrets } from "./http-error.js"
import { stripVTControlCharacters } from "node:util"
import { randomUUID } from "node:crypto"
import { createHostedHarnessWorkspaceTools } from "./agent-session.js"

const MAX_LOG_CHARS = 24000
const MAX_DIAGNOSTIC_BYTES = 512 * 1024
const MAX_HARNESS_OUTPUT_BYTES = 4 * 1024 * 1024

function logValue(value, secrets) {
  const text = typeof value === "string" ? value : JSON.stringify(value, (key, item) => {
    if (/^(authorization|proxy-authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|token|password|secret)$/i.test(key)) return "[redacted]"
    if (key === "reasoning" || key === "thinking" || ["reasoning", "thinking", "redacted_thinking"].includes(item?.type)) return "[omitted]"
    if (["image", "image_url", "input_image", "output_image", "audio", "input_audio"].includes(item?.type)) return { type: item.type, data: "[omitted]" }
    return item
  })
  return stripVTControlCharacters(redactSecrets(text ?? "", secrets))
}

function clip(value, max = MAX_LOG_CHARS) {
  const suffix = "\n[message truncated]"
  return value.length > max ? value.slice(0, max - suffix.length) + suffix : value
}

// No credentials are persisted in this extension. Its capability is assignment-scoped
// and only permits model requests and the existing trusted worker tools.
const PI_EXTENSION = `
export default function(pi) {
  const configuration = JSON.parse(process.env.HOSTED_HARNESS_CONFIG);
  pi.registerProvider("hosted", {
    baseUrl: configuration.baseUrl + "/openai/v1",
    apiKey: configuration.secret,
    api: "openai-responses",
    models: [{
      id: configuration.model, name: configuration.model, reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000, maxTokens: 8192
    }]
  });
  for (const tool of configuration.tools) pi.registerTool({
    name: tool.name, label: tool.name, description: tool.description, parameters: tool.parameters,
    async execute(toolCallId, args, signal) {
      const response = await fetch(configuration.baseUrl + "/mcp", {
        method: "POST", signal,
        headers: { Authorization: "Bearer " + configuration.secret, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: toolCallId, method: "tools/call",
          params: { name: tool.name, arguments: args } })
      });
      if (!response.ok) throw new Error("Hosted tool bridge failed (HTTP " + response.status + ")");
      const envelope = await response.json();
      if (envelope.error) throw new Error(envelope.error.message);
      if (envelope.result.isError) throw new Error(envelope.result.content.map(item => item.text).join("\\n"));
      return { content: envelope.result.content, details: {} };
    }
  });
}
`

export class HostedHarnessSession extends EventEmitter {
  constructor({ harness, id, cwd, env, instructions, tools, prepare, modelConfig, githubCredential, harnessModel, localCopilot = false, captureFailedPrompt = false, spawnProcess = spawn }) {
    super()
    if (!["opencode", "pi", "claudecode", "copilotcli"].includes(harness)) throw new Error("Unsupported external Hosted harness")
    if (localCopilot && harness !== "copilotcli") throw new Error("Local authentication is only supported for Copilot CLI")
    this.github = harness === "claudecode" || harness === "copilotcli"
    Object.assign(this, { harness, id, cwd, env, instructions, prepare, modelConfig, githubCredential, harnessModel, localCopilot, captureFailedPrompt, spawnProcess })
    this.tools = this.github ? [...createHostedHarnessWorkspaceTools({ cwd, env }), ...tools] : tools
    this.controller = new AbortController()
  }

  interrupt() {
    this.controller.abort()
    this.kill()
  }

  kill() {
    const child = this.child
    if (!child?.pid || child.exitCode != null || child.signalCode != null) return
    if (process.platform === "win32") {
      execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], error => {
        if (error && child.exitCode === null) this.emit("output", { stream: "stderr", data: "Could not terminate the Hosted harness process tree.\n" })
      })
    } else {
      try { process.kill(-child.pid, "SIGKILL") }
      catch (error) { if (error.code !== "ESRCH") throw error }
    }
  }

  async dispose() {
    this.interrupt()
    await this.execution
  }

  write(prompt) {
    if (this.execution) throw new Error("A Hosted harness session accepts only one assignment")
    this.execution = this.execute(prompt)
    return this.execution
  }

  async execute(prompt) {
    const { signal } = this.controller
    let bridge
    let temporary
    let failure = null
    let completed = false
    let bytes = 0
    let finalText = ""
    let diagnosticBytes = 0
    let turn = 0
    let round = 0
    let roundOpen = false
    let lastModelRequest
    let modelFailure
    let promptEvidence
    const streamFailures = new Map()
    const completedRequests = new Map()
    let heartbeat
    let lastProgress = Date.now()
    const activeTools = new Map()
    const toolCallIds = new Map()
    const nativeTools = new Map()
    const bridgedToolIds = new Set()
    const trustedTools = new Set(this.tools.flatMap(tool => [tool.name, `hosted_${tool.name}`]))
    const secrets = Object.entries({ ...process.env, ...this.env }).filter(([key, value]) =>
      /token|secret|password|api_key/i.test(key) && typeof value === "string").map(([, value]) => value)
    if (this.githubCredential?.accessToken) secrets.push(this.githubCredential.accessToken)
    const safe = value => logValue(value, secrets)
    const activity = value => this.emit("activity", {
      ...(turn ? { turn } : {}), ...value,
      ...(value.action ? { action: clip(safe(value.action), 100) } : {}),
      ...(value.target ? { target: clip(safe(value.target), 200) } : {}),
      summary: clip(safe(value.summary)),
    })
    const messageDetails = (label, value, diagnostic = false) => {
      const text = safe(value)
      label = safe(label).slice(0, 160)
      const id = randomUUID()
      const summary = (text.split(/\r?\n/).find(line => line.trim()) ?? label).slice(0, 200)
      for (let start = 0, part = 0; start < Math.max(1, text.length); start += 12000, part++) {
        this.emit("tool_detail", {
          version: 1, id: randomUUID(), callId: id, phase: "end", name: label,
          summary, ts: new Date().toISOString(), cwd: clip(safe(this.cwd), 2000),
          input: text.slice(start, start + 12000), truncated: false,
          message: { id, part, last: start + 12000 >= text.length, label, diagnostic },
        })
      }
    }
    const output = (stream, data) => {
      lastProgress = Date.now()
      data = safe(data)
      this.emit("output", { stream, data })
      if (stream !== "command") activity({ kind: stream === "stderr" ? "error" : "model_action", summary: data })
    }
    const diagnostic = (label, value) => {
      if (diagnosticBytes >= MAX_DIAGNOSTIC_BYTES) return
      if (label !== "assignment input") messageDetails(label, value, true)
      const data = clip(`# ${label}\n${safe(value)}\n`)
      if (diagnosticBytes + Buffer.byteLength(data) > MAX_DIAGNOSTIC_BYTES) {
        diagnosticBytes = MAX_DIAGNOSTIC_BYTES
        this.emit("output", { stream: "command", data: "\n[Hosted diagnostic log limit reached]\n" })
        return
      }
      diagnosticBytes += Buffer.byteLength(data)
      this.emit("output", { stream: "command", data, messageSummary: true })
    }
    const fail = message => { failure ??= safe(message) }
    const capture = request => {
      const requestBody = safe(JSON.parse(request.requestBody))
      return Buffer.byteLength(requestBody) > 1024 * 1024
        ? { status: "too_large" } : { capturedAt: new Date().toISOString(), requestBody }
    }
    const failModel = (message, request = lastModelRequest) => {
      fail(message)
      if (!modelFailure) {
        const model = safe(this.modelConfig?.model ?? this.harnessModel ?? this.harness)
        const code = safe(request?.code ?? "harness_model_error")
        const requestId = safe(request?.requestId)
        modelFailure = {
          model: /^[a-zA-Z0-9_.-]{1,100}$/.test(model) ? model : "unknown",
          code: /^[a-zA-Z0-9_.-]{1,100}$/.test(code) ? code : "model_request_failed",
          ...(request?.httpStatus ? { httpStatus: request.httpStatus } : {}),
          ...(/^[a-zA-Z0-9_.-]{1,200}$/.test(requestId) ? { requestId } : {}),
          occurredAt: request?.occurredAt ?? new Date().toISOString(),
          contextCharacters: request?.requestBody.length ?? 0,
        }
        if (this.captureFailedPrompt && request) promptEvidence = capture(request)
        this.emit("output", { stream: "stderr", data: `${safe(message)}\n` })
        activity({ kind: "error", action: "model", summary: message })
      }
    }
    const failedResult = error => {
      const result = { exitCode: 1, error }
      if (modelFailure) result.modelFailure = modelFailure
      if (promptEvidence) Object.defineProperty(result, "promptEvidence", { value: promptEvidence, configurable: true })
      return result
    }
    const endRound = () => {
      if (!roundOpen) return
      activity({ kind: "model_action", action: "round_end", summary: `Round ${round} end`,
        status: failure ? "failed" : signal.aborted ? "cancelled" : "completed" })
      roundOpen = false
    }
    const startRound = () => {
      lastProgress = Date.now()
      endRound()
      turn = ++round
      roundOpen = true
      activity({ kind: "model_action", action: "round_start", summary: `Round ${round} start` })
    }
    const toolEvent = ({ source, id, name, input, phase, output: result, error, durationMs }) => {
      lastProgress = Date.now()
      if (phase === "start") activeTools.set(id, { name, started: Date.now() })
      else activeTools.delete(id)
      const key = `${source}:${id}`
      if (!toolCallIds.has(key)) toolCallIds.set(key, randomUUID())
      const purpose = input?.description ?? input?.commandDescription ?? input?.path ?? input?.file_path ?? input?.command
      const summary = clip(safe(typeof purpose === "string" ? purpose : `Run ${name}`).replace(/\s+/g, " "), 200)
      const label = `${clip(safe(name), 160)} — ${summary} · ${phase === "start" ? "running" : error ? "failed" : "completed"}${durationMs === undefined ? "" : ` · ${durationMs} ms`}`
      activity({ kind: phase === "start" ? "model_action" : error ? "error" : "tool_result", action: name, target: String(id), summary })
      const content = safe(phase === "start" ? input : error ?? result)
      this.emit("tool_detail", {
        version: 1, id: randomUUID(), callId: toolCallIds.get(key), phase,
        name: clip(safe(name), 160), summary, ts: new Date().toISOString(),
        cwd: clip(safe(this.cwd), 2000), truncated: content.length > MAX_LOG_CHARS,
        ...(phase === "start" ? { input: clip(content) } : error ? { error: clip(content) } : { output: clip(content) }),
        ...(durationMs === undefined ? {} : { durationMs }),
      })
      this.emit("output", { stream: "stdout", data: `\n# tool ${label}\n`, toolSummary: true })
      if (phase === "end") toolCallIds.delete(key)
      diagnostic(`tool ${label} ${phase}`, phase === "start" ? input : error ?? result)
    }
    try {
      signal.throwIfAborted()
      if (this.harnessModel !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(this.harnessModel)) {
        throw new Error("Invalid native harness model ID")
      }
      if (this.github && !this.localCopilot && (!this.githubCredential?.accessToken || this.githubCredential.runId !== this.id
        || !Number.isFinite(Date.parse(this.githubCredential.expiresAt))
        || Date.parse(this.githubCredential.expiresAt) <= Date.now())) {
        throw new Error("The native harness requires a valid assignment-scoped GitHub access token")
      }
      const launch = await this.prepare(this.harness, this.id, { signal })
      signal.throwIfAborted()
      if (launch.harness !== this.harness || typeof launch.command !== "string" || !launch.command.trim()
        || typeof launch.version !== "string" || !launch.version.trim() || /[\r\n]/.test(launch.version)) {
        throw new Error("Hosted parent returned an invalid harness launch descriptor")
      }
      bridge = await startHostedHarnessBridge({
        ...this.modelConfig, tools: this.tools, signal, modelEnabled: !this.github,
        onError: (message, request) => {
          if (request?.code !== "ERR_STREAM_PREMATURE_CLOSE") {
            if (request) failModel(message, request)
            else fail(message)
            return
          }
          output("stderr", `${message}\n`)
          if ((completedRequests.get(request.requestKey) ?? 0) >= request.turn) {
            output("stdout", "Model stream recovered after a confirmed harness retry.\n")
          } else if ((streamFailures.get(request.requestKey)?.request.turn ?? 0) < request.turn) {
            streamFailures.set(request.requestKey, { message, request: { ...request, occurredAt: new Date().toISOString() } })
          }
        },
        onModelComplete: request => {
          const completedTurn = Math.max(completedRequests.get(request.requestKey) ?? 0, request.turn)
          completedRequests.set(request.requestKey, completedTurn)
          const pending = streamFailures.get(request.requestKey)
          if (pending && pending.request.turn <= completedTurn) {
            streamFailures.delete(request.requestKey)
            output("stdout", "Model stream recovered after a confirmed harness retry.\n")
          }
        },
        onModelRequest: (request, token) => {
          if (token && !secrets.includes(token)) secrets.push(token)
          turn = round || request.turn
          lastModelRequest = request
          const summary = `Model request ${request.turn}: ${this.modelConfig.model}, ${Buffer.byteLength(request.requestBody)} bytes`
          activity({ kind: "model_action", action: "model_request", turn: roundOpen ? round : null, summary })
          this.emit("output", { stream: "stdout", data: `# ${safe(summary)}\n` })
          diagnostic(`model request ${request.turn}`, JSON.parse(request.requestBody))
        },
        onToolEvent: event => {
          bridgedToolIds.add(String(event.id))
          toolEvent({ ...event, source: "mcp" })
        },
      })
      secrets.push(bridge.secret)
      signal.throwIfAborted()
      temporary = await fs.mkdtemp(path.join(os.tmpdir(), "hosted-harness-"))
      const childEnv = this.localCopilot ? { ...process.env, PWD: this.cwd, NO_COLOR: "1", CLICOLOR: "0" }
        : { ...process.env, ...this.env, PWD: this.cwd, NO_COLOR: "1", CLICOLOR: "0",
        HOME: temporary, USERPROFILE: temporary,
        XDG_CONFIG_HOME: path.join(temporary, "config"), XDG_CACHE_HOME: path.join(temporary, "cache"),
        XDG_STATE_HOME: path.join(temporary, "state"), XDG_DATA_HOME: path.join(temporary, "data") }
      for (const key of Object.keys(childEnv)) {
        if (/^(OPENCODE_|PI_|COPILOT_|GITHUB_TOKEN$|GH_TOKEN$|CLAUDE_CODE_|HOSTED_HARNESS_|OPENAI_|ANTHROPIC_|AZURE_|IDENTITY_|MSI_|MINION_|GIT_CONFIG_)/i.test(key)
          && !(this.localCopilot && key === "COPILOT_HOME")) delete childEnv[key]
        if (this.localCopilot && /^(PAPERCLIP_|MINICODE_|WORKER_)/i.test(key)) delete childEnv[key]
        if (this.github && /^GIT_(AUTHOR|COMMITTER)_/i.test(key) && !Object.hasOwn(this.env ?? {}, key)) delete childEnv[key]
      }
      let args
      if (this.harness === "opencode") {
        childEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify({
          provider: { hosted: { npm: "@ai-sdk/openai", name: "Hosted model",
            options: { baseURL: `${bridge.baseUrl}/openai/v1`, apiKey: bridge.secret },
            models: { [this.modelConfig.model]: { name: this.modelConfig.model } } } },
          agent: { hosted: { mode: "primary", prompt: this.instructions } },
          mcp: { hosted: { type: "remote", url: `${bridge.baseUrl}/mcp`,
            headers: { Authorization: `Bearer ${bridge.secret}` } } },
        })
        args = ["run", "--format", "json", "--agent", "hosted", "--model", `hosted/${this.modelConfig.model}`, "--dir", this.cwd]
      } else if (this.harness === "pi") {
        const extension = path.join(temporary, "hosted-extension.ts")
        const instructions = path.join(temporary, "instructions.md")
        await fs.writeFile(extension, PI_EXTENSION)
        await fs.writeFile(instructions, this.instructions)
        childEnv.HOSTED_HARNESS_CONFIG = JSON.stringify({
          baseUrl: bridge.baseUrl, secret: bridge.secret, model: this.modelConfig.model,
          tools: this.tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
        })
        childEnv.PI_CODING_AGENT_DIR = path.join(temporary, "pi")
        args = ["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates",
          "--extension", extension, "--append-system-prompt", instructions, "--provider", "hosted", "--model", this.modelConfig.model]
      } else {
        if (!this.localCopilot) childEnv.COPILOT_GITHUB_TOKEN = this.githubCredential.accessToken
        const mcp = path.join(temporary, "mcp.json")
        const server = { type: "http", url: `${bridge.baseUrl}/mcp`, headers: { Authorization: `Bearer ${bridge.secret}` } }
        await fs.writeFile(mcp, JSON.stringify({ mcpServers: { hosted: {
          ...server, ...(this.harness === "copilotcli" ? { tools: this.tools.map(tool => tool.name) } : {}),
        } } }), { mode: 0o600 })
        if (this.harness === "claudecode") {
          childEnv.ANTHROPIC_MODEL = this.harnessModel ?? "claude-sonnet-5"
          if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(childEnv.ANTHROPIC_MODEL ?? "")) throw new Error("Claude requires an explicit native model ID")
          const instructions = path.join(temporary, "instructions.md")
          await fs.writeFile(instructions, this.instructions, { mode: 0o600 })
          args = ["--print", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
            "--setting-sources", "", "--strict-mcp-config", "--mcp-config", mcp, "--tools", "",
            "--append-system-prompt-file", instructions, "--model", childEnv.ANTHROPIC_MODEL,
            "--allowedTools", ...this.tools.map(tool => `mcp__hosted__${tool.name}`)]
        } else {
          if (!this.localCopilot) childEnv.COPILOT_HOME = path.join(temporary, "copilot")
          args = ["--output-format", "json", "--stream", "on", "--disable-builtin-mcps", "--no-custom-instructions",
            "--model", this.harnessModel ?? "auto", "--additional-mcp-config", `@${mcp}`,
            "--secret-env-vars=COPILOT_GITHUB_TOKEN,GH_TOKEN,GITHUB_TOKEN",
            "--available-tools", ...this.tools.map(tool => `hosted-${tool.name}`),
            "--allow-tool", ...this.tools.map(tool => `hosted(${tool.name})`)]
          if (this.localCopilot) args.push("--no-ask-user", "--silent")
        }
      }
      signal.throwIfAborted()
      this.emit("output", { stream: "stdout", data: `using ${this.harness}.${this.localCopilot ? "devbox" : "contained"}.${safe(launch.version)} harness\n` })
      this.child = this.spawnProcess(this.localCopilot ? launch.command : "/bin/sh",
        this.localCopilot ? args : ["-c", `exec ${launch.command} "$@"`, "hosted-harness", ...args], {
        cwd: this.cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32",
      })
      const child = this.child
      if (this.localCopilot) {
        heartbeat = setInterval(() => {
          const quietSeconds = Math.floor((Date.now() - lastProgress) / 1000)
          if (quietSeconds < 30) return
          const pending = [...activeTools.values()].map(tool =>
            `${tool.name} (${Math.floor((Date.now() - tool.started) / 1000)}s)`).join(", ")
          output("stdout", `Copilot CLI still running; no new output for ${quietSeconds}s${pending ? `; waiting for ${pending}` : ""}\n`)
        }, 30_000)
        heartbeat.unref()
      }
      const result = new Promise(resolve => {
        child.once("error", error => fail(error.message))
        child.once("close", (code, terminationSignal) => resolve({ code, terminationSignal }))
      })
      const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
      child.stdout.on("data", data => {
        bytes += data.length
        if (bytes > MAX_HARNESS_OUTPUT_BYTES) {
          fail("Hosted harness output exceeded its limit")
          this.kill()
        }
      })
      lines.on("line", line => {
        if (bytes > MAX_HARNESS_OUTPUT_BYTES) return
        let event
        try { event = JSON.parse(line) }
        catch {
          fail("The Hosted harness emitted malformed JSON")
          this.kill()
          return
        }
        if (!event || typeof event !== "object" || Array.isArray(event)) {
          fail("The Hosted harness emitted an invalid event")
          this.kill()
          return
        }
        if (this.harness === "pi") {
          if (event.type === "turn_start") startRound()
          if (event.type === "turn_end") endRound()
          if (event.type === "response" && event.success === false || event.type === "extension_error") {
            fail(event.error ?? event.message ?? "Pi command or extension failed")
            this.kill()
          }
          const message = event.message
          if (message?.role === "assistant" && message.stopReason === "error") failModel(message.errorMessage ?? "Pi model failed")
          if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
            finalText += event.assistantMessageEvent.delta
            output("stdout", event.assistantMessageEvent.delta)
          }
          if (event.type === "message_start" && event.message?.role === "assistant") finalText = ""
          if (event.type === "auto_retry_end" && event.success === false) failModel(event.finalError ?? "Pi model retries failed")
          if (event.type === "agent_end") {
            for (const message of event.messages ?? []) {
              if (message.role === "assistant" && message.stopReason === "error") failModel(message.errorMessage ?? "Pi model failed")
            }
            completed = true
            this.kill()
          }
          if (event.type === "extension_ui_request") {
            fail("Pi requested interactive input; this assignment requires operator approval")
            this.kill()
          }
        } else if (this.harness === "opencode") {
          if (event.type === "step_start") { startRound(); finalText = "" }
          if (event.type === "text") {
            finalText += event.part?.text ?? ""
            output("stdout", event.part?.text ?? "")
          }
          if (event.type === "error") failModel(event.error?.data?.message ?? event.error?.message ?? "OpenCode model failed")
          if (event.type === "step_finish") { endRound(); completed = true }
        } else if (this.harness === "claudecode") {
          if (event.type === "assistant") {
            startRound()
            for (const content of event.message?.content ?? []) {
              if (content.type === "text") { finalText = content.text; output("stdout", content.text) }
              if (content.type === "tool_use") diagnostic(`tool claude:${content.id} ${content.name}`, content.input)
            }
          }
          if (event.type === "result") {
            completed = true
            if (event.is_error || event.subtype !== "success") failModel(event.errors?.join("\n") || event.result || "Claude Code failed")
            if (event.permission_denials?.length) fail("Claude Code requested tools outside this assignment's approved capabilities")
            if (typeof event.result === "string" && event.result !== finalText) output("stdout", event.result)
            if (typeof event.result === "string") finalText = event.result
            endRound()
          }
        } else {
          const data = event.data ?? event
          if (event.type === "assistant.turn_start") startRound()
          if (event.type === "assistant.turn_end") endRound()
          if (event.type === "assistant.message_delta" && typeof data.deltaContent === "string") {
            finalText += data.deltaContent
            output("stdout", data.deltaContent)
          }
          if (event.type === "assistant.message" && typeof data.content === "string") {
            if (data.content !== finalText) output("stdout", data.content)
            finalText = data.content
          }
          if (event.type === "session.error" || event.type === "error") failModel(data.message ?? data.error?.message ?? "Copilot CLI failed")
          if (event.type === "result") {
            completed = true
            if (event.exitCode !== undefined && event.exitCode !== 0) failModel(`Copilot CLI failed (exit ${event.exitCode})`)
            if (event.is_error || event.subtype && event.subtype !== "success") failModel(event.error ?? event.result ?? "Copilot CLI failed")
            if (typeof event.result === "string" && event.result !== finalText) output("stdout", event.result)
            if (typeof event.result === "string") finalText = event.result
            endRound()
          }
          if (event.type === "session.idle") { completed = true; endRound() }
        }
        const isPi = this.harness === "pi"
        const toolStart = isPi ? event.type === "tool_execution_start" : event.type === "tool_start"
        const toolEnd = isPi ? event.type === "tool_execution_end" : event.type === "tool_use"
        if (toolStart || toolEnd) {
          const id = isPi ? event.toolCallId : event.part?.id ?? event.part?.callID ?? event.part?.partID
          const name = isPi ? event.toolName : event.part?.tool
          const input = isPi ? event.args : event.part?.state?.input
          if (toolStart) nativeTools.set(id, { input, started: Date.now(), logged: !trustedTools.has(name) })
          const previous = nativeTools.get(id)
          const time = event.part?.state?.time
          const durationMs = isPi ? event.durationMs : typeof time?.end === "number" && typeof time.start === "number" ? time.end - time.start : undefined
          const error = isPi ? event.isError ? safe(event.result?.content) : undefined : event.part?.state?.error
          const mirrored = trustedTools.has(name) && (isPi ? bridgedToolIds.has(String(id)) : !error)
          if (!mirrored && !(toolStart && trustedTools.has(name))) {
            if (toolEnd && !previous?.logged) toolEvent({ source: this.harness, id, name, input: input ?? previous?.input, phase: "start" })
            toolEvent({
              source: this.harness, id, name, input: input ?? previous?.input, phase: toolStart ? "start" : "end",
              output: isPi ? event.result?.content : event.part?.state?.output ?? event.part?.state?.metadata?.content,
              error,
              durationMs: toolEnd ? durationMs ?? (previous ? Date.now() - previous.started : undefined) : undefined,
            })
          }
          if (toolEnd) nativeTools.delete(id)
        }
        if (isPi && event.type === "tool_execution_update" && !trustedTools.has(event.toolName)) {
          diagnostic(`tool pi:${safe(event.toolCallId)} ${safe(event.toolName)} update`, event.partialResult?.content)
        }
      })
      child.stderr.on("data", data => {
        bytes += data.length
        if (bytes > MAX_HARNESS_OUTPUT_BYTES) {
          fail("Hosted harness output exceeded its limit")
          this.kill()
        } else output("stderr", data.toString())
      })
      child.stdin.on("error", error => {
        if (!completed && !signal.aborted) fail(`Hosted harness input failed (${error.code ?? "IO"})`)
      })
      activity({ kind: "prompt", action: "prompt", summary: prompt })
      messageDetails("Assignment input", prompt)
      this.emit("output", { stream: "stdout", data: `# assignment input\n${clip(safe(prompt), 1000)}\n`, messageSummary: true })
      diagnostic("assignment input", prompt)
      diagnostic("system instructions", this.instructions)
      if (this.harness === "pi") child.stdin.write(`${JSON.stringify({ id: this.id, type: "prompt", message: prompt })}\n`)
      else child.stdin.end(this.harness === "copilotcli" ? `${this.instructions}\n\n${prompt}` : prompt)
      if (signal.aborted) this.kill()
      const exit = await result
      lines.close()
      if (signal.aborted) return { exitCode: 130 }
      try {
        const final = JSON.parse(finalText.trim())
        if (final?.type === "final" && typeof final.error === "string" && final.error.trim()) fail(final.error)
        if (final?.type === "final" && typeof final.message === "string") finalText = final.message
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
      }
      for (const { message, request } of streamFailures.values()) failModel(message, request)
      if (failure) return failedResult(failure)
      if (!completed || this.harness !== "pi" && exit.code !== 0) {
        return { exitCode: 1, error: `Hosted ${this.harness} did not complete successfully (exit ${exit.code ?? exit.terminationSignal})` }
      }
      if (this.localCopilot && !finalText.trim()) return { exitCode: 1, error: "Copilot CLI returned no final response" }
      return { exitCode: 0, ...(finalText.trim() ? { summary: safe(finalText) } : {}) }
    } catch (error) {
      return { exitCode: signal.aborted ? 130 : 1, error: signal.aborted ? "Hosted harness cancelled" : safe(error.message) }
    } finally {
      clearInterval(heartbeat)
      endRound()
      this.kill()
      this.child = null
      this.githubCredential = undefined
      this.controller.abort()
      await bridge?.close()
      if (temporary) await fs.rm(temporary, { recursive: true, force: true })
    }
  }
}
