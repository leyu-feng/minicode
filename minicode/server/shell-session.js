import childProcess from "node:child_process"
import { EventEmitter } from "node:events"
import { killTree, killDescendants } from "./kill-tree.js"

const DONE_MARKER = "__MINICODE_DONE__"

// PowerShell's formatter right-pads output lines with spaces to a fixed nominal
// width (120 cols) when stdout is a pipe rather than a real console. Strip that
// trailing padding so lines aren't ragged in the web terminal. Only affects
// trailing whitespace before line breaks, so real output is preserved.
function trimLinePadding(text) {
  if (process.platform !== "win32") return text
  return text.replace(/[ \t]+(?=\r?\n)/g, "").replace(/[ \t]+$/, "")
}

function shellLauncher() {
  if (process.platform === "win32") {
    return { file: "powershell.exe", args: ["-NoProfile", "-NoLogo", "-Command", "-"] }
  }
  return { file: "bash", args: ["-s"] }
}

function doneProbe() {
  if (process.platform === "win32") {
    return `Write-Output "${DONE_MARKER}:$(if ($?) { 0 } else { 1 })"`
  }
  return `printf '${DONE_MARKER}:%s\\n' "$?"`
}

/**
 * A long-lived shell process whose stdin/stdout are proxied to a web client.
 * No native PTY is used, so state (cwd, variables) persists but full-screen
 * curses applications are not supported.
 */
export class ShellSession extends EventEmitter {
  constructor({ id, cwd, env }) {
    super()
    this.id = id
    this.kind = "shell"
    this.cwd = cwd
    this.busy = false
    this.closed = false
    this.pending = ""

    const { file, args } = shellLauncher()
    this.proc = childProcess.spawn(file, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })

    this.proc.stdout.on("data", (chunk) => this.#handleChunk(chunk.toString(), "stdout"))
    this.proc.stderr.on("data", (chunk) => this.emit("output", { stream: "stderr", data: trimLinePadding(chunk.toString()) }))
    this.proc.on("error", (error) => this.emit("output", { stream: "stderr", data: `${error.message}\n` }))
    this.proc.on("close", (code) => {
      this.closed = true
      this.emit("exit", { code: typeof code === "number" ? code : 0 })
    })
  }

  #handleChunk(text, stream) {
    this.pending += text
    let index = this.pending.indexOf(DONE_MARKER)
    while (index !== -1) {
      const before = this.pending.slice(0, index)
      const rest = this.pending.slice(index)
      const match = rest.match(new RegExp(`^${DONE_MARKER}:(-?\\d+)\\r?\\n?`))
      if (!match) break
      if (before) this.emit("output", { stream, data: trimLinePadding(before) })
      this.busy = false
      this.emit("done", { exitCode: Number(match[1]) })
      this.pending = rest.slice(match[0].length)
      index = this.pending.indexOf(DONE_MARKER)
    }

    // Flush complete lines only. Holding back the partial tail keeps trailing
    // padding adjacent to its newline so trimLinePadding can strip it; flushing
    // mid-line could split a line's padding and leak the leading half through.
    // A partial DONE marker only ever sits after the last newline (the marker
    // always ends with its own newline), so flushing up to and including the
    // last newline can never split a marker. Capping below lastBreak would flush
    // a line mid-padding, leaving leading spaces with no trailing newline that
    // the trim regex can't match -- which is the empty-line/padding leak.
    const safeLength = this.pending.lastIndexOf("\n") + 1
    if (safeLength > 0) {
      const flush = this.pending.slice(0, safeLength)
      this.pending = this.pending.slice(safeLength)
      this.emit("output", { stream, data: flush.replace(/[ \t]+(?=\r?\n)/g, "") })
    }
  }

  write(line) {
    if (this.closed) return
    const command = line.replace(/\r?\n$/, "")
    this.busy = true
    this.proc.stdin.write(`${command}\n${doneProbe()}\n`)
  }

  interrupt() {
    if (this.closed) return
    // Without a PTY we cannot deliver Ctrl+C, so cancellation is best effort:
    // kill the child processes the shell spawned for the current command while
    // leaving the shell itself alive. Shell builtins that run in-process (e.g.
    // Start-Sleep) cannot be interrupted this way.
    killDescendants(this.proc.pid)
    this.emit("output", { stream: "stderr", data: "\r\n[sent kill to running command (best effort; no PTY)]\r\n" })
  }

  dispose() {
    if (this.closed) return
    this.closed = true
    try {
      this.proc.stdin.end()
      killTree(this.proc.pid)
    } catch {}
  }
}
