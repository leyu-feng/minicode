import { EventEmitter } from "node:events"
import { spawn, execFile } from "node:child_process"
import readline from "node:readline"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { startHostedHarnessBridge } from "./hosted-harness-bridge.js"
import { redactSecrets } from "./http-error.js"
import { stripVTControlCharacters } from "node:util"

// No credentials are persisted in this extension. Its capability is assignment-scoped
// and only permits model requests and the existing trusted worker tools.
const PI_EXTENSION = `
import { Type } from "@sinclair/typebox";

function schema(value) {
  if (value.enum) return Type.Union(value.enum.map(item => Type.Literal(item)));
  if (value.anyOf || value.oneOf) return Type.Union((value.anyOf || value.oneOf).map(schema));
  const { type, properties, required, items, ...options } = value;
  if (type === "object") return Type.Object(Object.fromEntries(Object.entries(properties || {}).map(([key, field]) =>
    [key, (required || []).includes(key) ? schema(field) : Type.Optional(schema(field))])), options);
  if (type === "array") return Type.Array(schema(items), options);
  if (type === "string") return Type.String(options);
  if (type === "integer") return Type.Integer(options);
  if (type === "number") return Type.Number(options);
  if (type === "boolean") return Type.Boolean(options);
  if (type === "null") return Type.Null(options);
  throw new Error("Unsupported Hosted tool schema");
}

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
    name: tool.name, label: tool.name, description: tool.description, parameters: schema(tool.parameters),
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
  constructor({ harness, id, cwd, env, instructions, tools, prepare, modelConfig, spawnProcess = spawn }) {
    super()
    if (!["opencode", "pi"].includes(harness)) throw new Error("Unsupported external Hosted harness")
    Object.assign(this, { harness, id, cwd, env, instructions, tools, prepare, modelConfig, spawnProcess })
    this.controller = new AbortController()
  }

  interrupt() {
    this.controller.abort()
    this.kill()
  }

  kill() {
    const child = this.child
    if (!child?.pid) return
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
    const secrets = Object.entries(this.env ?? {}).filter(([key, value]) =>
      /token|secret|password|api_key/i.test(key) && typeof value === "string").map(([, value]) => value)
    const safe = value => stripVTControlCharacters(redactSecrets(String(value), secrets))
    const fail = message => { failure ??= safe(message) }
    try {
      signal.throwIfAborted()
      const launch = await this.prepare(this.harness, this.id, { signal })
      signal.throwIfAborted()
      if (launch.harness !== this.harness || typeof launch.command !== "string" || !launch.command.trim()) {
        throw new Error("Hosted parent returned an invalid harness launch descriptor")
      }
      bridge = await startHostedHarnessBridge({ ...this.modelConfig, tools: this.tools, signal, onError: fail })
      secrets.push(bridge.secret)
      signal.throwIfAborted()
      temporary = await fs.mkdtemp(path.join(os.tmpdir(), "hosted-harness-"))
      const childEnv = { ...process.env, ...this.env, PWD: this.cwd, NO_COLOR: "1", CLICOLOR: "0",
        HOME: temporary, USERPROFILE: temporary,
        XDG_CONFIG_HOME: path.join(temporary, "config"), XDG_CACHE_HOME: path.join(temporary, "cache"),
        XDG_STATE_HOME: path.join(temporary, "state"), XDG_DATA_HOME: path.join(temporary, "data") }
      for (const key of Object.keys(childEnv)) {
        if (/^(OPENCODE_|PI_|HOSTED_HARNESS_|OPENAI_|ANTHROPIC_|AZURE_|IDENTITY_|MSI_|MINION_|GIT_CONFIG_)/i.test(key)) delete childEnv[key]
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
      } else {
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
      }
      signal.throwIfAborted()
      this.child = this.spawnProcess("/bin/sh", ["-c", `exec ${launch.command} "$@"`, "hosted-harness", ...args], {
        cwd: this.cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32",
      })
      const child = this.child
      const result = new Promise(resolve => {
        child.once("error", error => fail(error.message))
        child.once("close", (code, terminationSignal) => resolve({ code, terminationSignal }))
      })
      const output = (stream, data) => {
        data = safe(data)
        this.emit("output", { stream, data })
        this.emit("activity", { kind: stream === "stderr" ? "error" : "model_action", summary: data.slice(0, 24000) })
      }
      const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
      child.stdout.on("data", data => {
        bytes += data.length
        if (bytes > 2 * 1024 * 1024) {
          fail("Hosted harness output exceeded its limit")
          this.kill()
        }
      })
      lines.on("line", line => {
        if (bytes > 2 * 1024 * 1024) return
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
          if (event.type === "response" && event.success === false || event.type === "extension_error") {
            fail(event.error ?? event.message ?? "Pi command or extension failed")
            this.kill()
          }
          const message = event.message
          if (message?.role === "assistant" && message.stopReason === "error") fail(message.errorMessage ?? "Pi model failed")
          if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
            finalText += event.assistantMessageEvent.delta
            output("stdout", event.assistantMessageEvent.delta)
          }
          if (event.type === "message_start" && event.message?.role === "assistant") finalText = ""
          if (event.type === "auto_retry_end" && event.success === false) fail(event.finalError ?? "Pi model retries failed")
          if (event.type === "agent_end") {
            for (const message of event.messages ?? []) {
              if (message.role === "assistant" && message.stopReason === "error") fail(message.errorMessage ?? "Pi model failed")
            }
            completed = true
            this.kill()
          }
          if (event.type === "extension_ui_request") {
            fail("Pi requested interactive input; this assignment requires operator approval")
            this.kill()
          }
        } else {
          if (event.type === "step_start") finalText = ""
          if (event.type === "text") {
            finalText += event.part?.text ?? ""
            output("stdout", event.part?.text ?? "")
          }
          if (event.type === "error") fail(event.error?.data?.message ?? event.error?.message ?? "OpenCode model failed")
          if (event.type === "step_finish") completed = true
        }
        if (["tool_execution_start", "tool_use"].includes(event.type)) {
          this.emit("activity", { kind: "tool_call", summary: safe(event.toolName ?? event.part?.tool ?? "tool") })
        }
      })
      child.stderr.on("data", data => {
        bytes += data.length
        if (bytes > 2 * 1024 * 1024) {
          fail("Hosted harness output exceeded its limit")
          this.kill()
        } else output("stderr", data.toString())
      })
      child.stdin.on("error", error => {
        if (!completed && !signal.aborted) fail(`Hosted harness input failed (${error.code ?? "IO"})`)
      })
      if (this.harness === "pi") child.stdin.write(`${JSON.stringify({ id: this.id, type: "prompt", message: prompt })}\n`)
      else child.stdin.end(prompt)
      if (signal.aborted) this.kill()
      const exit = await result
      lines.close()
      if (signal.aborted) return { exitCode: 130 }
      try {
        const final = JSON.parse(finalText.trim())
        if (final?.type === "final" && typeof final.error === "string" && final.error.trim()) fail(final.error)
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
      }
      if (failure) return { exitCode: 1, error: failure }
      if (!completed || this.harness === "opencode" && exit.code !== 0) {
        return { exitCode: 1, error: `Hosted ${this.harness} did not complete successfully (exit ${exit.code ?? exit.terminationSignal})` }
      }
      return { exitCode: 0 }
    } catch (error) {
      return { exitCode: signal.aborted ? 130 : 1, error: signal.aborted ? "Hosted harness cancelled" : safe(error.message) }
    } finally {
      this.kill()
      this.child = null
      this.controller.abort()
      await bridge?.close()
      if (temporary) await fs.rm(temporary, { recursive: true, force: true })
    }
  }
}
