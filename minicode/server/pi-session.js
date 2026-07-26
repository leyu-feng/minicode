import childProcess from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { EventEmitter } from "node:events"
import { killTree } from "./kill-tree.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// minicode/server -> repo root that contains the pi-agent submodule
const INSTALL_ROOT = path.resolve(__dirname, "..", "..")
const PI_ROOT = path.join(INSTALL_ROOT, "pi-agent")
const PI_CLI = path.join(PI_ROOT, "packages", "coding-agent", "src", "cli.ts")

function tsxBin() {
  const name = process.platform === "win32" ? "tsx.cmd" : "tsx"
  return path.join(PI_ROOT, "node_modules", ".bin", name)
}

/**
 * A conversational Pi coding-agent bound to one web pane. Each prompt spawns the
 * Pi CLI in --print mode against a stable per-pane session id, so conversation
 * history is preserved by Pi itself across turns. Output is streamed live.
 */
export class PiSession extends EventEmitter {
  constructor({ id, cwd }) {
    super()
    this.id = id
    this.kind = "pi"
    this.cwd = cwd
    this.busy = false
    this.closed = false
    this.proc = null
    // Pi session ids must be filesystem/URL safe; derive one from the pane id.
    this.piSessionId = String(id).replace(/[^a-zA-Z0-9_-]/g, "-")
    this.started = false
  }

  #emitOutput(data, stream = "stdout") {
    this.emit("output", { stream, data })
  }

  write(line) {
    const prompt = line.replace(/\r?\n$/, "").trim()
    if (!prompt || this.closed) return
    if (this.busy) {
      this.#emitOutput("\u001b[33mPi is still working; wait for it to finish.\u001b[0m\r\n", "stderr")
      return
    }

    const bin = tsxBin()
    if (!fs.existsSync(bin) || !fs.existsSync(PI_CLI)) {
      this.#emitOutput(
        `\u001b[31mPi is not installed. Run \"minicode pi\" once (or 'npm install' inside pi-agent) to set it up.\u001b[0m\r\n`,
        "stderr",
      )
      this.busy = false
      this.emit("done", { exitCode: 1 })
      return
    }

    // After the first turn, resume the existing session so history carries over.
    // A stable --session-id reuses the same Pi session file across turns, so
    // conversation history is preserved without --continue (which targets the
    // most-recent session and could conflict with an explicit id).
    const args = [PI_CLI, "--print", "--session-id", this.piSessionId, prompt]

    this.busy = true
    this.started = true

    const proc = childProcess.spawn(bin, args, {
      cwd: this.cwd,
      env: { ...process.env, FORCE_COLOR: "1", PI_CODING_AGENT: "true" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32", // .cmd shim needs a shell on Windows
    })
    this.proc = proc

    proc.stdout.on("data", (chunk) => this.#emitOutput(chunk.toString()))
    proc.stderr.on("data", (chunk) => this.#emitOutput(chunk.toString(), "stderr"))
    proc.on("error", (error) => this.#emitOutput(`${error.message}\r\n`, "stderr"))
    proc.on("close", (code) => {
      this.proc = null
      this.busy = false
      this.emit("done", { exitCode: typeof code === "number" ? code : 0 })
    })
  }

  interrupt() {
    if (this.closed || !this.proc) return
    try {
      killTree(this.proc.pid)
    } catch {}
    this.#emitOutput("\r\n[interrupted]\r\n", "stderr")
  }

  dispose() {
    if (this.closed) return
    this.closed = true
    try {
      if (this.proc) killTree(this.proc.pid)
    } catch {}
  }
}
