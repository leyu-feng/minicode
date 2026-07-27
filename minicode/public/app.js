const Terminal = window.Terminal
const FitAddon = window.FitAddon.FitAddon

const layoutEl = document.getElementById("layout")
const statusEl = document.getElementById("status")
const repoEl = document.getElementById("repo-root")

const panes = new Map()
let layout = null
let focusedId = null
let paneCounter = 0
let socket = null
let started = false
let repoRoot = ""

const THEME = {
  background: "#010409",
  foreground: "#c9d1d9",
  cursor: "#58a6ff",
  selectionBackground: "#264f78",
}

function uid(prefix) {
  paneCounter += 1
  return `${prefix}-${paneCounter}-${Math.random().toString(36).slice(2, 7)}`
}

function send(payload) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload))
}

/* ------------------------------------------------------- state persistence */

const STATE_KEY = "minicode:layout"

// The layout and pane identities live in localStorage so reloading the page
// reattaches to the same server-side sessions instead of starting new ones.
function saveState() {
  try {
    const entries = [...panes.values()].map((pane) => ({
      id: pane.id,
      kind: pane.kind,
      cwd: pane.cwd,
      history: pane.history.slice(-100),
    }))
    localStorage.setItem(STATE_KEY, JSON.stringify({ layout, panes: entries }))
  } catch {}
}

function loadState() {
  try {
    const raw = localStorage.getItem(STATE_KEY)
    if (!raw) return null
    const state = JSON.parse(raw)
    if (!state?.layout || !Array.isArray(state.panes) || state.panes.length === 0) return null
    return state
  } catch {
    return null
  }
}

/* ---------------------------------------------------------------- layout */

function findParent(node, paneId, parent = null) {
  if (!node) return null
  if (node.type === "leaf") return node.paneId === paneId ? parent : null
  return findParent(node.a, paneId, node) || findParent(node.b, paneId, node)
}

function findLeaf(node, paneId) {
  if (!node) return null
  if (node.type === "leaf") return node.paneId === paneId ? node : null
  return findLeaf(node.a, paneId) || findLeaf(node.b, paneId)
}

function firstLeaf(node) {
  if (!node) return null
  return node.type === "leaf" ? node : firstLeaf(node.a) || firstLeaf(node.b)
}

function splitPane(paneId, dir, kind) {
  const leaf = findLeaf(layout, paneId)
  if (!leaf) return
  const pane = createPane(kind)
  const existing = { type: "leaf", paneId: leaf.paneId }
  leaf.type = "split"
  leaf.dir = dir
  leaf.a = existing
  leaf.b = { type: "leaf", paneId: pane.id }
  delete leaf.paneId
  render()
  focusPane(pane.id)
  saveState()
}

function removePane(paneId) {
  const pane = panes.get(paneId)
  if (!pane) return
  send({ type: "close", sessionId: paneId })
  pane.term.dispose()
  panes.delete(paneId)

  if (layout && layout.type === "leaf" && layout.paneId === paneId) {
    layout = null
    render()
    focusedId = null
    saveState()
    return
  }

  const parent = findParent(layout, paneId)
  if (!parent) return
  const survivor = parent.a.type === "leaf" && parent.a.paneId === paneId ? parent.b : parent.a
  Object.keys(parent).forEach((key) => delete parent[key])
  Object.assign(parent, survivor)
  render()
  const next = firstLeaf(layout)
  if (next) focusPane(next.paneId)
  saveState()
}

function renderNode(node) {
  if (!node) return document.createDocumentFragment()
  if (node.type === "leaf") {
    const pane = panes.get(node.paneId)
    return pane ? pane.el : document.createDocumentFragment()
  }
  const el = document.createElement("div")
  el.className = `split ${node.dir}`
  el.appendChild(renderNode(node.a))
  el.appendChild(renderNode(node.b))
  return el
}

function render() {
  layoutEl.replaceChildren(layout ? renderNode(layout) : emptyState())
  requestAnimationFrame(() => panes.forEach(fitPane))
}

function emptyState() {
  const el = document.createElement("div")
  el.className = "empty-state"
  el.innerHTML =
    '<p>No sessions open.</p><p class="hint">Use <b>+ agent</b> or <b>+ shell</b> above to start one.</p>'
  return el
}

function fitPane(pane) {
  try {
    pane.fit.fit()
  } catch {}
}

/* ----------------------------------------------------------------- panes */

function focusPane(paneId) {
  focusedId = paneId
  panes.forEach((pane) => pane.el.classList.toggle("focused", pane.id === paneId))
  const pane = panes.get(paneId)
  if (pane) {
    fitPane(pane)
    pane.term.focus()
  }
}

function promptText(pane, leadingNewline = false) {
  const label = pane.kind === "agent" ? "minicode" : pane.kind === "pi" ? "pi" : "PS"
  const prefix = leadingNewline ? "\r\n" : ""
  return `${prefix}\u001b[32m${label}\u001b[0m \u001b[90m${pane.cwd || repoRoot}\u001b[0m> `
}

function prompt(pane, leadingNewline = false) {
  pane.term.write(promptText(pane, leadingNewline))
}

// Toggle a pane's busy state and reflect it in the cursor. While busy (a
// prompt was sent and the agent is still working) input is already blocked,
// so switch to a non-blinking bar cursor to signal the waiting state, like
// Pi's TUI does. When idle, restore the blinking block cursor.
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

// Draw/refresh the spinner line in place. Shows the elapsed time so the user
// can see how long the agent has been working or a command has been running.
function renderSpinner(pane) {
  const glyph = SPINNER_FRAMES[pane.spinnerFrame % SPINNER_FRAMES.length]
  pane.spinnerFrame++
  const secs = pane.spinnerStart ? Math.floor((Date.now() - pane.spinnerStart) / 1000) : 0
  pane.term.write(`\r\u001b[K\u001b[90m${glyph} working… ${secs}s\u001b[0m`)
  pane.spinnerVisible = true
}

function startSpinner(pane) {
  if (pane.spinnerTimer) clearInterval(pane.spinnerTimer)
  pane.spinnerFrame = 0
  if (!pane.spinnerStart) pane.spinnerStart = Date.now()
  renderSpinner(pane)
  pane.spinnerTimer = setInterval(() => renderSpinner(pane), 80)
}

// Temporarily clear the spinner line (e.g. before writing real output) without
// forgetting the elapsed clock, so it can resume afterwards.
function hideSpinner(pane) {
  if (pane.spinnerVisible) {
    pane.term.write("\r\u001b[K")
    pane.spinnerVisible = false
  }
}

function stopSpinner(pane) {
  if (pane.spinnerTimer) {
    clearInterval(pane.spinnerTimer)
    pane.spinnerTimer = null
  }
  hideSpinner(pane)
  pane.spinnerStart = null
}

function setBusy(pane, busy) {
  pane.busy = busy
  if (busy) {
    pane.term.options.cursorBlink = false
    startSpinner(pane)
  } else {
    stopSpinner(pane)
    pane.term.options.cursorStyle = "block"
    pane.term.options.cursorBlink = true
  }
}

// Keys the browser owns. The terminal is line based and never needs function
// keys, so let Edge/Chrome handle fullscreen (F11), devtools (F12), reload,
// zoom and tab switching instead of swallowing them.
const BROWSER_KEYS = new Set([
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
])

function passThroughToBrowser(event) {
  if (BROWSER_KEYS.has(event.key)) return false

  // Ctrl+Shift+I / J / C (devtools), Ctrl+Shift+M, Ctrl+Shift+P, etc.
  if (event.ctrlKey && event.shiftKey && !event.altKey) return false

  // Ctrl+R reload, Ctrl+L address bar, Ctrl +/-/0 zoom, Ctrl+T/W/N tabs.
  if (event.ctrlKey && !event.shiftKey && !event.altKey) {
    if (["r", "l", "t", "w", "n", "+", "-", "=", "0"].includes(event.key.toLowerCase())) return false
  }

  if (event.altKey && !event.ctrlKey) return false

  return true
}

function createPane(kind, restore = null) {
  const id = restore?.id || uid(kind)

  const el = document.createElement("div")
  el.className = `pane kind-${kind}`

  const header = document.createElement("div")
  header.className = "pane-header"
  header.innerHTML = `<span class="pane-kind">${kind}</span><span class="pane-title">starting…</span>`

  const body = document.createElement("div")
  body.className = "pane-body"

  el.append(header, body)

  const term = new Terminal({
    convertEol: true,
    cursorBlink: true,
    cursorStyle: "block",
    fontSize: 13,
    fontFamily: '"Cascadia Code", Consolas, monospace',
    scrollback: 5000,
    theme: THEME,
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.attachCustomKeyEventHandler((event) => {
    if (event.type === "keydown" && term.hasSelection()) {
      if (event.key === "Enter") {
        const sel = term.getSelection()
        if (sel && navigator.clipboard) navigator.clipboard.writeText(sel).catch(() => {})
        term.clearSelection()
        event.preventDefault()
        event.stopPropagation()
        return false
      }
      if (event.key === "Escape") {
        term.clearSelection()
        event.preventDefault()
        event.stopPropagation()
        return false
      }
    }
    // xterm reports Enter and Shift+Enter as the same data (\r), so handle
    // the modified key event before it reaches onData. A bare Enter still
    // submits the prompt; Shift+Enter inserts a newline into it.
    if (event.type === "keydown" && event.key === "Enter" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !pane.raw) {
      handleInput(pane, "\n")
      event.preventDefault()
      event.stopPropagation()
      return false
    }
    return passThroughToBrowser(event)
  })
  term.open(body)

  const cwd = restore?.cwd || repoRoot
  const history = Array.isArray(restore?.history) ? [...restore.history] : []

  const pane = {
    id,
    kind,
    el,
    header,
    term,
    fit,
    cwd,
    buffer: "",
    cursor: 0,
    history,
    historyIndex: history.length,
    busy: false,
  }

  el.addEventListener("mousedown", () => focusPane(id))
  body.addEventListener("contextmenu", (event) => {
    event.preventDefault()
    focusPane(id)
    if (!navigator.clipboard || !navigator.clipboard.readText) return
    navigator.clipboard
      .readText()
      .then((text) => {
        if (text) pasteText(pane, text)
      })
      .catch(() => {})
  })
  pane.raw = kind === "pi"
  term.onData((data) => {
    if (pane.raw) {
      // Raw passthrough: send every keystroke straight to the interactive
      // process; the process (Pi's TUI) owns echo, editing and rendering.
      send({ type: "input", sessionId: pane.id, data })
      return
    }
    handleInput(pane, data)
  })
  // Relay terminal size to raw sessions so the faked TTY lays out correctly.
  term.onResize(({ cols, rows }) => {
    if (pane.raw) send({ type: "resize", sessionId: pane.id, cols, rows })
  })
  panes.set(id, pane)

  header.querySelector(".pane-title").textContent = cwd
  const dims = fit.proposeDimensions?.() || {}
  send({ type: "create", sessionId: id, kind, cwd, cols: dims.cols, rows: dims.rows })
  return pane
}

function addPane(kind) {
  const pane = createPane(kind)
  const leaf = { type: "leaf", paneId: pane.id }
  if (!layout) layout = leaf
  else layout = { type: "split", dir: "row", a: layout, b: leaf }
  render()
  focusPane(pane.id)
  saveState()
}

function restoreFromState(state) {
  layout = state.layout
  for (const entry of state.panes) {
    if (findLeaf(layout, entry.id)) createPane(entry.kind, entry)
  }
  // Drop layout leaves whose pane metadata was missing.
  for (const leaf of collectLeaves(layout)) {
    if (!panes.has(leaf.paneId)) removeLeaf(leaf.paneId)
  }
  if (!layout || panes.size === 0) {
    layout = null
    render()
    addPane("agent")
    return
  }
  render()
  const first = firstLeaf(layout)
  if (first) focusPane(first.paneId)
}

function collectLeaves(node, acc = []) {
  if (!node) return acc
  if (node.type === "leaf") acc.push(node)
  else {
    collectLeaves(node.a, acc)
    collectLeaves(node.b, acc)
  }
  return acc
}

function removeLeaf(paneId) {
  if (layout && layout.type === "leaf" && layout.paneId === paneId) {
    layout = null
    return
  }
  const parent = findParent(layout, paneId)
  if (!parent) return
  const survivor = parent.a.type === "leaf" && parent.a.paneId === paneId ? parent.b : parent.a
  Object.keys(parent).forEach((key) => delete parent[key])
  Object.assign(parent, survivor)
}

function replaceLine(pane, value) {
  const previousBuffer = pane.buffer
  const previousCursor = pane.cursor
  pane.buffer = value
  pane.cursor = value.length
  redrawLine(pane, previousBuffer, previousCursor)
}

// Insert clipboard text into the current line. Embedded newlines are treated
// as Enter presses so multi-line pastes submit each line in turn.
function pasteText(pane, text) {
  const normalized = text.replace(/\r\n?/g, "\n")
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i]
    if (ch === "\n") handleInput(pane, "\r")
    else if (ch === "\t" || ch.charCodeAt(0) >= 32) handleInput(pane, ch)
  }
}

const EXIT_COMMANDS = new Set(["exit", "quit", "/exit", "/quit", ":q", "logout"])
const CLEAR_COMMANDS = new Set(["cls", "clear", "/clear"])

function handleInput(pane, data) {
  // While the pane is busy (a prompt was sent and the agent/model is still
  // working) block all input except Ctrl+C so the user cannot type until the
  // model is done and the prompt returns.
  if (pane.busy && data !== "\u0003") return

  if (data === "\u0016") {
    // Ctrl+V: paste from the clipboard.
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard
        .readText()
        .then((text) => {
          if (text) pasteText(pane, text)
        })
        .catch(() => {})
    }
    return
  }

  if (data === "\u0003") {
    pane.term.write("^C\r\n")
    pane.buffer = ""
    pane.cursor = 0
    send({ type: "interrupt", sessionId: pane.id })
    if (!pane.busy) prompt(pane)
    return
  }

  if (data === "\n") {
    // Shift+Enter inserts a newline without submitting.
    const atEnd = pane.cursor === pane.buffer.length
    const previousBuffer = pane.buffer
    const previousCursor = pane.cursor
    pane.buffer = pane.buffer.slice(0, pane.cursor) + "\n" + pane.buffer.slice(pane.cursor)
    pane.cursor++
    if (atEnd) pane.term.write("\r\n")
    else redrawLine(pane, previousBuffer, previousCursor)
    return
  }

  if (data === "\r") {
    const line = pane.buffer
    pane.buffer = ""
    pane.cursor = 0
    pane.term.write("\r\n")
    if (!line.trim()) {
      prompt(pane)
      return
    }
    pane.history.push(line)
    pane.historyIndex = pane.history.length

    if (EXIT_COMMANDS.has(line.trim().toLowerCase())) {
      pane.term.write("\u001b[90mclosing pane…\u001b[0m\r\n")
      removePane(pane.id)
      return
    }

    if (CLEAR_COMMANDS.has(line.trim().toLowerCase())) {
      // Wipe the on-screen scrollback and ask the server to drop both the
      // replay buffer and the agent conversation so context stays bounded.
      pane.term.reset()
      send({ type: "clear", sessionId: pane.id })
      pane.history = []
      pane.historyIndex = 0
      saveState()
      prompt(pane)
      return
    }

    setBusy(pane, true)
    // Echo is what the server stores in its replay buffer so a page reload
    // shows the same transcript the user typed.
    send({
      type: "input",
      sessionId: pane.id,
      data: line,
      echo: `${promptText(pane)}${line.replace(/\n/g, "\r\n")}\r\n`,
    })
    saveState()
    return
  }

  if (data === "\u0017" || data === "\u0008") {
    // Ctrl+W / Ctrl+Backspace: delete the word before the cursor. Skip any
    // whitespace immediately left of the cursor, then the word characters.
    if (pane.cursor > 0) {
      let start = pane.cursor
      while (start > 0 && /\s/.test(pane.buffer[start - 1])) start--
      while (start > 0 && !/\s/.test(pane.buffer[start - 1])) start--
      const atEnd = pane.cursor === pane.buffer.length
      const previousBuffer = pane.buffer
      const previousCursor = pane.cursor
      const removed = pane.cursor - start
      pane.buffer = pane.buffer.slice(0, start) + pane.buffer.slice(pane.cursor)
      pane.cursor = start
      if (atEnd && !previousBuffer.includes("\n")) pane.term.write("\b \b".repeat(removed))
      else redrawLine(pane, previousBuffer, previousCursor)
    }
    return
  }

  if (data === "\u007f") {
    // Backspace: delete the character before the cursor.
    if (pane.cursor > 0) {
      const atEnd = pane.cursor === pane.buffer.length
      const previousBuffer = pane.buffer
      const previousCursor = pane.cursor
      pane.buffer = pane.buffer.slice(0, pane.cursor - 1) + pane.buffer.slice(pane.cursor)
      pane.cursor--
      // At the end of a single line a simple erase avoids a flickering repaint.
      if (atEnd && !previousBuffer.includes("\n")) pane.term.write("\b \b")
      else redrawLine(pane, previousBuffer, previousCursor)
    }
    return
  }

  if (data === "\u001b[3~") {
    // Delete: remove the character at the cursor.
    if (pane.cursor < pane.buffer.length) {
      const previousBuffer = pane.buffer
      const previousCursor = pane.cursor
      pane.buffer = pane.buffer.slice(0, pane.cursor) + pane.buffer.slice(pane.cursor + 1)
      redrawLine(pane, previousBuffer, previousCursor)
    }
    return
  }

  if (data === "\u001b[D") {
    // Left arrow: move the cursor left one column.
    if (pane.cursor > 0) {
      pane.cursor--
      pane.term.write("\u001b[D")
    }
    return
  }

  if (data === "\u001b[C") {
    // Right arrow: move the cursor right one column.
    if (pane.cursor < pane.buffer.length) {
      pane.cursor++
      pane.term.write("\u001b[C")
    }
    return
  }

  if (data === "\u001b[H" || data === "\u0001") {
    // Home / Ctrl+A: jump to the start of the line.
    if (pane.cursor > 0) {
      pane.term.write(`\u001b[${pane.cursor}D`)
      pane.cursor = 0
    }
    return
  }

  if (data === "\u001b[F" || data === "\u0005") {
    // End / Ctrl+E: jump to the end of the line.
    const remaining = pane.buffer.length - pane.cursor
    if (remaining > 0) {
      pane.term.write(`\u001b[${remaining}C`)
      pane.cursor = pane.buffer.length
    }
    return
  }

  if (data === "\u001b[A" || data === "\u001b[B") {
    if (pane.history.length === 0) return
    const delta = data === "\u001b[A" ? -1 : 1
    pane.historyIndex = Math.min(Math.max(pane.historyIndex + delta, 0), pane.history.length)
    replaceLine(pane, pane.history[pane.historyIndex] ?? "")
    return
  }

  if (data.charCodeAt(0) < 32 && data !== "\t") return

  // Insert typed text at the cursor position. Appending at the end is the
  // common case: just echo the character to avoid repainting (which flickers).
  if (pane.cursor === pane.buffer.length) {
    pane.buffer += data
    pane.cursor += data.length
    pane.term.write(data)
    return
  }
  // Mid-line: overwrite the existing characters rather than inserting, so the
  // rest of the line stays put and no repaint (flicker) is needed.
  const previousBuffer = pane.buffer
  const previousCursor = pane.cursor
  pane.buffer = pane.buffer.slice(0, pane.cursor) + data + pane.buffer.slice(pane.cursor + data.length)
  pane.cursor += data.length
  if (previousBuffer.includes("\n")) redrawLine(pane, previousBuffer, previousCursor)
  else pane.term.write(data)
}

// Repaint the current input line and restore the cursor to pane.cursor. Used
// whenever an edit happens somewhere other than the end of the line.
function redrawLine(pane, previousBuffer = pane.buffer, previousCursor = pane.cursor) {
  if (!previousBuffer.includes("\n") && !pane.buffer.includes("\n")) {
    pane.term.write(`\u001b[2K\r`)
    pane.term.write(promptText(pane))
    pane.term.write(pane.buffer)
    const back = pane.buffer.length - pane.cursor
    if (back > 0) pane.term.write(`\u001b[${back}D`)
    return
  }

  // Return to the first input row, erase the old multi-line input, then draw
  // it again. This intentionally uses logical lines; xterm handles visual
  // wrapping separately just as it does for normal terminal input.
  const previousRow = previousBuffer.slice(0, previousCursor).split("\n").length - 1
  pane.term.write("\r")
  if (previousRow > 0) pane.term.write(`\u001b[${previousRow}A`)
  pane.term.write("\u001b[J")
  pane.term.write(promptText(pane))
  pane.term.write(pane.buffer)

  const beforeCursor = pane.buffer.slice(0, pane.cursor)
  const cursorRow = beforeCursor.split("\n").length - 1
  const rowsBack = pane.buffer.slice(pane.cursor).split("\n").length - 1
  if (rowsBack > 0) pane.term.write(`\u001b[${rowsBack}A`)
  pane.term.write("\r")
  const column = beforeCursor.slice(beforeCursor.lastIndexOf("\n") + 1).length
  // The first input row starts after the coloured prompt; continuation rows
  // start at column zero.
  const promptWidth = promptText(pane).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").length
  const targetColumn = column + (cursorRow === 0 ? promptWidth : 0)
  if (targetColumn > 0) pane.term.write(`\u001b[${targetColumn}C`)
}

/* ------------------------------------------------------------------- ws */

function connect() {
  socket = new WebSocket(`ws://${location.host}`)

  socket.addEventListener("open", () => {
    statusEl.textContent = "connected"
    if (!started) {
      started = true
      const state = loadState()
      if (state) restoreFromState(state)
      else addPane("agent")
    } else {
      panes.forEach((pane) => {
        const dims = pane.fit.proposeDimensions?.() || {}
        send({ type: "create", sessionId: pane.id, kind: pane.kind, cwd: pane.cwd, cols: dims.cols, rows: dims.rows })
      })
    }
  })

  socket.addEventListener("close", () => {
    statusEl.textContent = "disconnected"
    setTimeout(connect, 1500)
  })

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data)
    const pane = panes.get(message.sessionId)
    if (!pane) return

    if (message.type === "ready") {
      pane.cwd = message.cwd
      pane.header.querySelector(".pane-title").textContent = message.cwd
      pane.term.reset?.()

      if (pane.raw) {
        // Interactive raw session (Pi): the process renders its own full TUI,
        // so just replay any buffered bytes and get out of the way.
        if (message.restored && message.buffer) pane.term.write(message.buffer)
        pane.buffer = ""
        setBusy(pane, false)
        saveState()
        return
      }

      if (message.restored) {
        // Replay the transcript the server buffered while we were away.
        if (message.buffer) pane.term.write(message.buffer)
        pane.term.write("\u001b[90m—— reattached to running session ——\u001b[0m\r\n")
      } else {
        pane.term.write(
          pane.kind === "agent"
            ? "\u001b[90mAsk anything. The agent runs shell commands in this repo. Type 'exit' to close this pane.\u001b[0m\r\n"
            : pane.kind === "pi"
              ? "\u001b[90mPi coding agent. Ask anything; Pi runs tools in this repo and keeps conversation history. Type 'exit' to close this pane.\u001b[0m\r\n"
              : "\u001b[90mLine-based shell (no PTY): full-screen TUI apps are unsupported. Type 'exit' to close this pane.\u001b[0m\r\n",
        )
      }

      pane.buffer = ""
      setBusy(pane, Boolean(message.busy))
      if (pane.busy) pane.term.write("\u001b[90mstill working…\u001b[0m\r\n")
      else prompt(pane)
      saveState()
      return
    }

    if (message.type === "detached") {
      pane.term.write("\r\n\u001b[33mthis session was taken over by another tab\u001b[0m\r\n")
      return
    }

    if (message.type === "output") {
      // Hide the spinner line, write the real output, then resume the spinner
      // (still busy) so it keeps showing while commands run — with the elapsed
      // clock preserved across output bursts.
      hideSpinner(pane)
      pane.term.write(message.stream === "stderr" ? `\u001b[31m${message.data}\u001b[0m` : message.data)
      if (pane.busy) startSpinner(pane)
      return
    }

    if (message.type === "done") {
      setBusy(pane, false)
      prompt(pane, true)
      return
    }

    if (message.type === "exit") {
      setBusy(pane, false)
      removePane(pane.id)
    }
  })
}

/* --------------------------------------------------------------- toolbar */

function runToolbarAction(action) {
  if (!action) return
  if (action === "refresh") {
    saveState()
    location.reload()
  } else if (action === "new-agent") addPane("agent")
  else if (action === "new-pi") addPane("pi")
  else if (action === "new-shell") addPane("shell")
  else if (action === "split-right" && focusedId) splitPane(focusedId, "row", panes.get(focusedId).kind)
  else if (action === "split-down" && focusedId) splitPane(focusedId, "col", panes.get(focusedId).kind)
  else if (action === "close" && focusedId) removePane(focusedId)
  else if (action === "restart") restartBackend()
}

async function restartBackend() {
  if (!window.confirm("Restart the backend server? Running sessions will be terminated.")) return
  if (statusEl) statusEl.textContent = "restarting\u2026"
  try {
    await fetch("/api/restart", { method: "POST" })
  } catch {}
  // Give the server time to respawn and rebind the port, then reload the UI
  // so it reconnects to the fresh backend.
  setTimeout(() => location.reload(), 1500)
}

document.querySelectorAll(".toolbar button[data-action]").forEach((btn) => {
  const action = btn.dataset.action
  let handled = false
  const run = () => { if (handled) return; handled = true; setTimeout(() => (handled = false), 300); runToolbarAction(action) }
  btn.addEventListener("click", run)
  btn.addEventListener("pointerup", run)
})

window.addEventListener("beforeunload", saveState)

window.addEventListener("resize", () => panes.forEach(fitPane))

fetch("/api/info")
  .then((res) => res.json())
  .then((info) => {
    repoRoot = info.repoRoot
    repoEl.textContent = `${info.repoRoot} · ${info.model}`
  })
  .finally(connect)
