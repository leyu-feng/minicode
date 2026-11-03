import { createServer } from "node:http"
import { once } from "node:events"
import { randomBytes } from "node:crypto"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"

const MAX_BODY = 4 * 1024 * 1024
const MAX_EVENT_CHARS = 4 * 1024 * 1024

async function body(request) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > MAX_BODY) throw new Error("Hosted harness request exceeded its limit")
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

function trackModelCompletion(chatCompletions, onCompletion) {
  const decoder = new TextDecoder()
  let pending = ""
  let data = ""
  let skipLF = false
  let invalid = false
  return new Transform({
    transform(chunk, encoding, callback) {
      try {
        if (!invalid) {
          const text = decoder.decode(chunk, { stream: true })
          const lines = (pending + (skipLF && text.startsWith("\n") ? text.slice(1) : text)).split(/\r\n|\r|\n/)
          if (text) skipLF = text.endsWith("\r")
          pending = lines.pop()
          for (const line of lines) {
            if (line.startsWith("data:")) data += `${line.slice(5).replace(/^ /, "")}\n`
            else if (line === "" && data) {
              const payload = data.trim()
              data = ""
              if (!payload) continue
              if (chatCompletions && payload === "[DONE]") onCompletion(true)
              else {
                let event
                try { event = JSON.parse(payload) }
                catch (error) {
                  if (!(error instanceof SyntaxError)) throw error
                  invalid = true
                  break
                }
                if (event?.error || ["error", "response.failed", "response.incomplete"].includes(event?.type)) {
                  invalid = true
                  break
                }
                if (!chatCompletions && event?.type === "response.completed" && event.response?.status === "completed") onCompletion(true)
              }
            }
            if (data.length > MAX_EVENT_CHARS) { invalid = true; break }
          }
          if (invalid || data.length + pending.length > MAX_EVENT_CHARS) {
            invalid = true
            data = pending = ""
            onCompletion(false)
          }
        }
        callback(null, chunk)
      } catch (error) {
        callback(error)
      }
    },
  })
}

export async function startHostedHarnessBridge({ endpoint, model, getAccessToken, tools, signal, onError, onModelRequest, onToolEvent, modelEnabled = true }) {
  const upstream = modelEnabled ? new URL(endpoint) : null
  if (upstream && (upstream.protocol !== "https:" || upstream.username || upstream.password
    || !upstream.pathname.endsWith("/responses"))) throw new Error("Invalid Hosted model endpoint")
  const secret = randomBytes(32).toString("hex")
  const toolMap = new Map(tools.map(tool => [tool.name, tool]))
  let modelRequests = 0
  let toolCalls = 0
  const server = createServer((request, response) => {
    let modelRequest
    let modelCompleted = false
    const json = (status, value) => {
      response.writeHead(status, { "Content-Type": "application/json" })
      response.end(JSON.stringify(value))
    }
    void (async () => {
      if (request.headers.authorization !== `Bearer ${secret}`) {
        json(401, { error: "Hosted harness authentication required" })
        return
      }
      if (request.method !== "POST") {
        json(405, { error: "Only POST is supported" })
        return
      }
      const input = await body(request)
      if (request.url === "/mcp") {
        const result = value => json(200, { jsonrpc: "2.0", id: input.id, result: value })
        if (input.method === "initialize") {
          result({ protocolVersion: input.params?.protocolVersion ?? "2025-03-26",
            capabilities: { tools: {} }, serverInfo: { name: "hosted-worker", version: "1" } })
        } else if (input.method === "notifications/initialized") {
          response.writeHead(202).end()
        } else if (input.method === "tools/list") {
          result({ tools: tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })) })
        } else if (input.method === "tools/call") {
          const tool = toolMap.get(input.params?.name)
          if (!tool) throw new Error("Unknown Hosted harness tool")
          const call = { id: input.id ?? `mcp-${++toolCalls}`, name: tool.name, input: input.params.arguments }
          const started = Date.now()
          try {
            signal.throwIfAborted()
            onToolEvent?.({ ...call, phase: "start" })
            const output = await tool.execute(input.params.arguments, { signal })
            onToolEvent?.({ ...call, phase: "end", output, durationMs: Date.now() - started })
            result({ content: [{ type: "text", text: typeof output === "string" ? output : JSON.stringify(output) }] })
          } catch (error) {
            onToolEvent?.({ ...call, phase: "end", error: error.message, durationMs: Date.now() - started })
            result({ isError: true, content: [{ type: "text", text: error.message }] })
          }
        } else if (input.method === "ping") {
          result({})
        } else {
          json(200, { jsonrpc: "2.0", id: input.id, error: { code: -32601, message: "Unsupported Hosted method" } })
        }
        return
      }
      if (!modelEnabled || !["/openai/v1/responses", "/openai/v1/chat/completions"].includes(request.url)) {
        json(404, { error: "Unknown Hosted model operation" })
        return
      }
      signal.throwIfAborted()
      const target = new URL(upstream)
      if (request.url.endsWith("/chat/completions")) target.pathname = target.pathname.replace(/responses$/, "chat/completions")
      input.model = model
      modelRequest = { turn: ++modelRequests, requestBody: JSON.stringify(input) }
      const token = await getAccessToken({ signal })
      signal.throwIfAborted()
      onModelRequest?.(modelRequest, token)
      const remote = await fetch(target, {
        method: "POST", redirect: "error", signal,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: modelRequest.requestBody,
      })
      if (!remote.ok) {
        onError(`Hosted model request failed (HTTP ${remote.status})`, {
          ...modelRequest, code: `http_${remote.status}`, httpStatus: remote.status,
          requestId: remote.headers.get("x-request-id") ?? remote.headers.get("apim-request-id"),
        })
        await remote.body?.cancel()
        json(remote.status, { error: { message: `Hosted model request failed (HTTP ${remote.status})`, type: "hosted_model_error" } })
        return
      }
      const contentType = remote.headers.get("content-type") ?? "application/json"
      response.writeHead(remote.status, { "Content-Type": contentType })
      if (remote.body) {
        const streams = [Readable.fromWeb(remote.body)]
        if (/^text\/event-stream(?:;|$)/i.test(contentType)) {
          streams.push(trackModelCompletion(request.url.endsWith("/chat/completions"), completed => { modelCompleted = completed }))
        }
        await pipeline(...streams, response, { signal })
      } else response.end()
    })().catch(error => {
      // Harnesses can close a completed SSE response before the upstream HTTP EOF.
      if (!signal.aborted && modelCompleted && error.code === "ERR_STREAM_PREMATURE_CLOSE") return
      onError(signal.aborted ? "Hosted harness cancelled" : error.message,
        modelRequest ? { ...modelRequest, code: error.cause?.code ?? error.code } : undefined)
      if (response.headersSent) response.destroy()
      else json(500, { error: { message: "Hosted harness request failed", type: "hosted_bridge_error" } })
    })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  return {
    baseUrl, secret,
    async close() {
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      server.closeAllConnections()
      await closed
    },
  }
}
