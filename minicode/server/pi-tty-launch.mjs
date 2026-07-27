// Software-TTY launcher (Option C): runs the real Pi interactive TUI inside a
// child process whose piped stdin/stdout are monkeypatched to look like a
// terminal, so isTTY-gated interactive mode engages. Raw bytes flow over the
// pipes to/from the web client's xterm.js; terminal size arrives over the IPC
// channel. No native PTY is used.
import { pathToFileURL } from "node:url"

const cols = Number(process.env.PI_TTY_COLS) || 80
const rows = Number(process.env.PI_TTY_ROWS) || 24

/* --------------------------------------------------------------- stdin */
// Make stdin look like a raw-capable TTY. Pi reads keystrokes via on("data")
// in raw mode, so setRawMode just needs to exist and track state.
const stdin = process.stdin
try {
  Object.defineProperty(stdin, "isTTY", { value: true, configurable: true })
} catch {
  stdin.isTTY = true
}
stdin.isRaw = false
if (typeof stdin.setRawMode !== "function") {
  stdin.setRawMode = function setRawMode(mode) {
    this.isRaw = !!mode
    return this
  }
}

/* -------------------------------------------------------------- stdout */
// Make stdout look like a TTY with a known size. Pi's terminal layer writes VT
// escape sequences directly, so we only need isTTY, columns/rows, a "resize"
// event, and harmless stubs for the Node tty helper methods some libraries poke.
const stdout = process.stdout
try {
  Object.defineProperty(stdout, "isTTY", { value: true, configurable: true })
} catch {
  stdout.isTTY = true
}
stdout.columns = cols
stdout.rows = rows
if (typeof stdout.getColorDepth !== "function") stdout.getColorDepth = () => 24
if (typeof stdout.hasColors !== "function") stdout.hasColors = () => true
for (const method of ["cursorTo", "moveCursor", "clearLine", "clearScreenDown"]) {
  if (typeof stdout[method] !== "function") {
    stdout[method] = (...args) => {
      const cb = args[args.length - 1]
      if (typeof cb === "function") cb()
      return true
    }
  }
}

// The parent forwards xterm resize events over IPC; update the fake size and
// emit the "resize" event Pi listens for so the TUI relays out.
process.on("message", (msg) => {
  if (msg && msg.type === "resize") {
    if (msg.cols) stdout.columns = msg.cols
    if (msg.rows) stdout.rows = msg.rows
    stdout.emit("resize")
  }
})

/* ---------------------------------------------------------------- boot */
const entry = process.env.PI_CLI_ENTRY
if (!entry) {
  process.stderr.write("pi-tty-launch: PI_CLI_ENTRY is not set\n")
  process.exit(1)
}

// Importing Pi's CLI entry runs main(process.argv.slice(2)) itself, so the
// TTY patch above is already in place before Pi resolves interactive vs print.
await import(pathToFileURL(entry).href)
