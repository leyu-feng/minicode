import childProcess from "node:child_process"
import fs from "node:fs"
import fsp from "node:fs/promises"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { WebSocketServer } from "ws"
import { AgentSession } from "./agent-session.js"
import { ShellSession } from "./shell-session.js"

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

wss.on("connection", (socket) => {
  /** @type {Map<string, ShellSession|AgentSession>} */
  const sessions = new Map()

  const send = (payload) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload))
  }

  const attach = (session) => {
    session.on("output", ({ stream, data }) => send({ type: "output", sessionId: session.id, stream, data }))
    session.on("done", ({ exitCode }) => send({ type: "done", sessionId: session.id, exitCode }))
    session.on("exit", ({ code }) => {
      send({ type: "exit", sessionId: session.id, code })
      sessions.delete(session.id)
    })
  }

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
      if (sessions.has(sessionId)) return
      const cwd = message.cwd && fs.existsSync(message.cwd) ? message.cwd : repoRoot
      try {
        const session =
          message.kind === "agent"
            ? new AgentSession({ id: sessionId, cwd })
            : new ShellSession({ id: sessionId, cwd })
        sessions.set(sessionId, session)
        attach(session)
        send({ type: "ready", sessionId, kind: session.kind, cwd })
      } catch (error) {
        send({ type: "output", sessionId, stream: "stderr", data: `${error.message}\r\n` })
      }
      return
    }

    const session = sessions.get(sessionId)
    if (!session) return

    if (type === "input") session.write(String(message.data ?? ""))
    else if (type === "interrupt") session.interrupt()
    else if (type === "close") {
      session.dispose()
      sessions.delete(sessionId)
      send({ type: "exit", sessionId, code: 0 })
    }
  })

  socket.on("close", () => {
    for (const session of sessions.values()) session.dispose()
    sessions.clear()
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
