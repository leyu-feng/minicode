// A loopback proxy that carries the worker's Easy Auth session for the agent.
//
// The agent calls Clippy itself, from shell commands and runtime tool URLs, with its own Clippy
// token in Authorization. Pointed at this proxy instead of the server, its requests leave with
// X-ZUMO-AUTH added and Authorization untouched; the agent never sees the session. A random path
// prefix keeps other local processes from borrowing the session through the port.
import http from "node:http"
import https from "node:https"
import { randomBytes } from "node:crypto"
import { SESSION_HEADER, isEasyAuthChallenge } from "./entra-session.js"

const MAX_BODY = 32 * 1024 * 1024
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "host", "te", "trailer"])

function proxyTarget(origin, path) {
  if (path.startsWith("//") || path.includes("\\")) return null
  const target = new URL(path, origin)
  return target.origin === origin.origin ? target : null
}

function forward(target, request, body, session) {
  const transport = target.protocol === "https:" ? https : http
  const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !HOP_BY_HOP.has(name)))
  headers[SESSION_HEADER] = session.token()
  if (body.length) headers["content-length"] = String(body.length)
  return new Promise((resolve, reject) => {
    const upstream = transport.request(target, { method: request.method, headers }, resolve)
    upstream.on("error", reject)
    upstream.end(body)
  })
}

export async function startEntraProxy({ server, session }) {
  const origin = new URL(server)
  const prefix = `/${randomBytes(16).toString("hex")}`
  const proxy = http.createServer(async (request, response) => {
    try {
      if (!request.url.startsWith(`${prefix}/`)) {
        response.writeHead(404).end()
        return
      }
      const target = proxyTarget(origin, request.url.slice(prefix.length))
      if (!target) {
        response.writeHead(400, { "content-type": "text/plain" })
          .end("AgentPool Entra proxy: request path must stay on the configured server origin")
        return
      }
      const chunks = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > MAX_BODY) {
          response.writeHead(413).end()
          return
        }
        chunks.push(chunk)
      }
      // Buffered so the request can be sent again after a renewal; agent API bodies are small.
      const body = Buffer.concat(chunks)
      let upstream = await forward(target, request, body, session)
      if (isEasyAuthChallenge(upstream.statusCode, upstream.headers["www-authenticate"])) {
        upstream.resume()
        await session.renew()
        upstream = await forward(target, request, body, session)
      }
      response.writeHead(upstream.statusCode, Object.fromEntries(
        Object.entries(upstream.headers).filter(([name]) => !HOP_BY_HOP.has(name))))
      upstream.pipe(response)
    } catch (error) {
      if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" })
      response.end(`AgentPool Entra proxy: ${error.message}`)
    }
  })
  await new Promise((resolve, reject) => {
    proxy.once("error", reject)
    proxy.listen(0, "127.0.0.1", resolve)
  })
  const url = new URL(`http://127.0.0.1:${proxy.address().port}${prefix}`)
  return {
    // Where the agent should send what it would have sent to the server.
    rewrite: (value) => {
      const target = new URL(value)
      return `${url.href}${target.pathname}${target.search}`
    },
    origin: url.href,
    close: () => new Promise((resolve) => proxy.close(resolve)),
  }
}
