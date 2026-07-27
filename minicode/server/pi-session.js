import childProcess from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { EventEmitter } from "node:events"
import { killTree } from "./kill-tree.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TTY_LAUNCH = path.join(__dirname, "pi-tty-launch.mjs")
// minicode/server -> repo root that contains the pi-agent submodule
const INSTALL_ROOT = path.resolve(__dirname, "..", "..")
const PI_ROOT = path.join(INSTALL_ROOT, "pi-agent")
// Prefer the compiled CLI (runs under plain node); fall back to source via tsx.
const PI_DIST_CLI = path.join(PI_ROOT, "packages", "coding-agent", "dist", "cli.js")
const PI_SRC_CLI = path.join(PI_ROOT, "packages", "coding-agent", "src", "cli.ts")

function tsxBin() {
  const name = process.platform === "win32" ? "tsx.cmd" : "tsx"
  return path.join(PI_ROOT, "node_modules", ".bin", name)
}

// Resolve how to launch the software-TTY wrapper: [file, prefixArgs, entry, shell].
// The wrapper (pi-tty-launch.mjs) fakes a TTY and then imports PI_CLI_ENTRY,
// which boots Pi's real interactive TUI.
function resolveLauncher() {
  if (fs.existsSync(PI_DIST_CLI)) {
    return { file: process.execPath, prefix: [TTY_LAUNCH], entry: PI_DIST_CLI, shell: false }
  }
  const bin = tsxBin()
  if (fs.existsSync(bin) && fs.existsSync(PI_SRC_CLI)) {
    return { file: bin, prefix: [TTY_LAUNCH], entry: PI_SRC_CLI, shell: process.platform === "win32" }
  }
  return null
}

/**
 * A full interactive Pi coding-agent bound to one web pane. Instead of running
 * Pi in batch (--print) mode, this launches Pi's genuine interactive TUI inside
 * a child process whose piped stdin/stdout are patched to look like a terminal
 * (see pi-tty-launch.mjs). Raw keystrokes from the client's xterm.js are written
 * straight to Pi's stdin, and Pi's VT output is streamed back verbatim, giving
 * the same experience as running Pi in a real console -- without a native PTY.
 */
export class PiSession extends EventEmitter {
  constructor({ id, cwd, cols, rows }) {
    super()
    this.id = id
    this.kind = "pi"
    this.cwd = cwd
    this.busy = false
    this.closed = false
    this.proc = null
    this.cols = cols || 80
    this.rows = rows || 24
    this.#start()
  }

  #emitOutput(data, stream = "stdout") {
    this.emit("output", { stream, data })
  }

  #start() {
    const launcher = resolveLauncher()
    if (!launcher) {
      this.#emitOutput(
        "\u001b[31mPi is not built. Run 'npm run build' inside pi-agent (or 'minicode web' which does it) to set it up.\u001b[0m\r\n",
        "stderr",
      )
      // Defer so listeners are attached before the exit fires.
      setImmediate(() => this.emit("exit", { code: 1 }))
      return
    }

    const proc = childProcess.spawn(launcher.file, launcher.prefix, {
      cwd: this.cwd,
      env: {
        ...process.env,
        FORCE_COLOR: "1",
        PI_CODING_AGENT: "true",
        PI_CLI_ENTRY: launcher.entry,
        PI_TTY_COLS: String(this.cols),
        PI_TTY_ROWS: String(this.rows),
        TERM: process.env.TERM || "xterm-256color",
        COLUMNS: String(this.cols),
        LINES: String(this.rows),
      },
      // stdin/stdout/stderr are pipes; the 4th fd is an IPC channel used to
      // relay terminal resize events into the faked TTY.
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      windowsHide: true,
      shell: launcher.shell,
    })
    this.proc = proc

    proc.stdout.on("data", (chunk) => this.#emitOutput(chunk.toString()))
    proc.stderr.on("data", (chunk) => this.#emitOutput(chunk.toString(), "stderr"))
    proc.on("error", (error) => this.#emitOutput(`${error.message}\r\n`, "stderr"))
    proc.on("close", (code) => {
      this.proc = null
      this.closed = true
      this.emit("exit", { code: typeof code === "number" ? code : 0 })
    })
  }

  // Raw keystroke passthrough from the client's terminal.
  write(data) {
    if (this.closed || !this.proc) return
    try {
      this.proc.stdin.write(data)
    } catch {}
  }

  resize(cols, rows) {
    this.cols = cols || this.cols
    this.rows = rows || this.rows
    if (this.closed || !this.proc) return
    try {
      this.proc.send({ type: "resize", cols: this.cols, rows: this.rows })
    } catch {}
  }

  // In interactive mode Ctrl+C is a keystroke Pi handles itself (cancel the
  // current turn), so deliver it as an ETX byte rather than killing the tree.
  interrupt() {
    if (this.closed || !this.proc) return
    try {
      this.proc.stdin.write("\u0003")
    } catch {}
  }

  dispose() {
    if (this.closed) return
    this.closed = true
    try {
      if (this.proc) killTree(this.proc.pid)
    } catch {}
  }
}
