import childProcess from "node:child_process"
import fs from "node:fs"
import fsp from "node:fs/promises"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { WebSocketServer } from "ws"
import { AgentSession } from "./agent-session.js"
import { ShellSession } from "./shell-session.js"
import { PiSession } from "./pi-session.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")
const PUBLIC_DIR = path.join(ROOT, "public")
const MODULES_DIR = path.join(ROOT, "node_modules")

const repoRoot = path.resolve(process.env.MINICODE_REPO_ROOT || process.argv[2] || process.cwd())
const requestedPort = Number(process.env.MINICODE_WEB_PORT || process.argv[3] || 0)
const shouldOpen = process.env.MINICODE_WEB_OPEN !== "0"

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
}

const VENDOR = {
  "/vendor/xterm.js": path.join(MODULES_DIR, "@xterm", "xterm", "lib", "xterm.js"),
  "/vendor/xterm.css": path.join(MODULES_DIR, "@xterm", "xterm", "css", "xterm.css"),
  "/vendor/addon-fit.js": path.join(MODULES_DIR, "@xterm", "addon-fit", "lib", "addon-fit.js"),
}

async function serveFile(res, filePath) {
  try {
    const data = await fsp.readFile(filePath)
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" })
    res.end(data)
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" })
    res.end("not found")
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost")
  const pathname = url.pathname

  if (pathname === "/api/restart" && req.method === "POST") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ ok: true }))
    // Respawn a fresh copy of the server with the same arguments, then exit so
    // the new process takes over. Running sessions are intentionally dropped.
    console.log("restart requested via portal; respawning…")
    setTimeout(() => {
      const boundPort = server.address()?.port
      // Tear down listeners so the port is free before the replacement binds,
      // and reuse the same port so the reloading UI reconnects seamlessly.
      for (const [id] of sessions) disposeSession(id)
      try { wss.close() } catch {}
      server.close(() => {
        try {
          const child = childProcess.spawn(process.execPath, process.argv.slice(1), {
            cwd: process.cwd(),
            env: {
              ...process.env,
              MINICODE_WEB_OPEN: "0",
              MINICODE_WEB_PORT: String(boundPort || ""),
            },
            detached: true,
            stdio: "inherit",
            windowsHide: true,
          })
          child.unref()
        } catch (error) {
          console.error(`restart failed: ${error.message}`)
        }
        process.exit(0)
      })
    }, 150)
    return
  }

  if (pathname === "/api/info") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ repoRoot, platform: process.platform, model: process.env.OPENCODE_MODEL || "default" }))
    return
  }

  if (VENDOR[pathname]) {
    await serveFile(res, VENDOR[pathname])
    return
  }

  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "")
  const target = path.join(PUBLIC_DIR, relative)
  if (!target.startsWith(PUBLIC_DIR) || !fs.existsSync(target)) {
    await serveFile(res, path.join(PUBLIC_DIR, "index.html"))
    return
  }
  await serveFile(res, target)
})

const wss = new WebSocketServer({ server })

const MAX_BUFFER_CHARS = 200000
const IDLE_REAP_MS = Number(process.env.MINICODE_WEB_IDLE_MS || 30 * 60 * 1000)

/**
 * Sessions are owned by the server, not by a WebSocket connection, so the web
 * UI can be reloaded (or briefly disconnected) without losing shell state or
 * agent conversation history. Output is buffered per session and replayed to
 * whichever client attaches next.
 * @type {Map<string, {session: ShellSession|AgentSession, kind: string, cwd: string, buffer: string, busy: boolean, subscriber: import("ws").WebSocket|null, detachedAt: number}>}
 */
const sessions = new Map()

function sendTo(socket, payload) {
  if (socket && socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload))
}

function appendBuffer(entry, text) {
  entry.buffer += text
  if (entry.buffer.length > MAX_BUFFER_CHARS) {
    entry.buffer = entry.buffer.slice(entry.buffer.length - MAX_BUFFER_CHARS)
  }
}

function createSession(sessionId, kind, cwd, cols, rows) {
  const session =
    kind === "agent"
      ? new AgentSession({ id: sessionId, cwd })
      : kind === "pi"
        ? new PiSession({ id: sessionId, cwd, cols, rows })
        : new ShellSession({ id: sessionId, cwd })
  const entry = { session, kind: session.kind, cwd, buffer: "", busy: false, subscriber: null, detachedAt: 0 }

  session.on("output", ({ stream, data }) => {
    // Store exactly what a client would render so replay is byte-identical.
    appendBuffer(entry, stream === "stderr" ? `\u001b[31m${data}\u001b[0m` : data)
    sendTo(entry.subscriber, { type: "output", sessionId, stream, data })
  })
  session.on("done", ({ exitCode }) => {
    entry.busy = false
    sendTo(entry.subscriber, { type: "done", sessionId, exitCode })
  })
  session.on("exit", ({ code }) => {
    sendTo(entry.subscriber, { type: "exit", sessionId, code })
    sessions.delete(sessionId)
  })

  sessions.set(sessionId, entry)
  return entry
}

function disposeSession(sessionId) {
  const entry = sessions.get(sessionId)
  if (!entry) return
  entry.session.dispose()
  sessions.delete(sessionId)
}

setInterval(() => {
  const now = Date.now()
  for (const [id, entry] of sessions) {
    if (!entry.subscriber && entry.detachedAt && now - entry.detachedAt > IDLE_REAP_MS) {
      disposeSession(id)
    }
  }
}, 60000).unref()

wss.on("connection", (socket) => {
  const owned = new Set()

  const send = (payload) => sendTo(socket, payload)

  socket.on("message", async (raw) => {
    let message
    try {
      message = JSON.parse(raw.toString())
    } catch {
      return
    }

    const { type, sessionId } = message
    if (!sessionId) return

    if (type === "create") {
      const existing = sessions.get(sessionId)
      if (existing) {
        // Reattach after a UI reload: steal the subscription and replay output.
        sendTo(existing.subscriber, { type: "detached", sessionId })
        existing.subscriber = socket
        existing.detachedAt = 0
        owned.add(sessionId)
        send({
          type: "ready",
          sessionId,
          kind: existing.kind,
          cwd: existing.cwd,
          restored: true,
          busy: existing.busy,
          buffer: existing.buffer,
        })
        return
      }

      const cwd = message.cwd && fs.existsSync(message.cwd) ? message.cwd : repoRoot
      try {
        const entry = createSession(sessionId, message.kind, cwd, message.cols, message.rows)
        entry.subscriber = socket
        owned.add(sessionId)
        send({ type: "ready", sessionId, kind: entry.kind, cwd, restored: false, busy: false, buffer: "" })
      } catch (error) {
        send({ type: "output", sessionId, stream: "stderr", data: `${error.message}\r\n` })
      }
      return
    }

    const entry = sessions.get(sessionId)
    if (!entry) {
      // The client believes this session exists; tell it otherwise.
      send({ type: "exit", sessionId, code: 0 })
      return
    }

    if (type === "input") {
      entry.busy = true
      // The client sends the exact text it rendered (prompt + command) so the
      // replay buffer matches what the user saw.
      if (typeof message.echo === "string") appendBuffer(entry, message.echo)
      entry.session.write(String(message.data ?? ""))
    } else if (type === "resize") {
      // Raw-passthrough sessions (Pi) relay terminal size into the faked TTY.
      entry.session.resize?.(message.cols, message.rows)
    } else if (type === "clear") {
      // Drop the replay buffer and the agent conversation so neither the UI
      // transcript nor the model context grows without bound.
      entry.buffer = ""
      entry.session.clearContext?.()
    } else if (type === "interrupt") {
      entry.session.interrupt()
    } else if (type === "close") {
      disposeSession(sessionId)
      owned.delete(sessionId)
      send({ type: "exit", sessionId, code: 0 })
    }
  })

  socket.on("close", () => {
    // Keep sessions alive so a page reload can reattach to them.
    for (const id of owned) {
      const entry = sessions.get(id)
      if (entry && entry.subscriber === socket) {
        entry.subscriber = null
        entry.detachedAt = Date.now()
      }
    }
    owned.clear()
  })
})

function openBrowser(url) {
  if (!shouldOpen) return
  const commands = {
    win32: ["cmd", ["/c", "start", "", url]],
    darwin: ["open", [url]],
  }
  const [file, args] = commands[process.platform] || ["xdg-open", [url]]
  try {
    childProcess.spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true }).unref()
  } catch {}
}

server.listen(requestedPort, "127.0.0.1", () => {
  const { port } = server.address()
  const url = `http://127.0.0.1:${port}`
  console.log(`minicode web portal: ${url}`)
  console.log(`repo root: ${repoRoot}`)
  openBrowser(url)
})
