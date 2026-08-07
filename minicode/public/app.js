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
  if (typeof node.sizeA !== "number") node.sizeA = 0.5
  const childA = renderNode(node.a)
  const childB = renderNode(node.b)
  const wrapA = document.createElement("div")
  wrapA.className = "split-child"
  wrapA.style.flex = `${node.sizeA} 1 0`
  wrapA.appendChild(childA)
  const wrapB = document.createElement("div")
  wrapB.className = "split-child"
  wrapB.style.flex = `${1 - node.sizeA} 1 0`
  wrapB.appendChild(childB)
  const resizer = document.createElement("div")
  resizer.className = `split-resizer ${node.dir}`
  attachResizer(resizer, el, wrapA, wrapB, node)
  el.appendChild(wrapA)
  el.appendChild(resizer)
  el.appendChild(wrapB)
  return el
}

function attachResizer(resizer, container, wrapA, wrapB, node) {
  resizer.addEventListener("pointerdown", (e) => {
    e.preventDefault()
    resizer.setPointerCapture(e.pointerId)
    const horizontal = node.dir === "row"
    const rect = container.getBoundingClientRect()
    const total = horizontal ? rect.width : rect.height
    const start = horizontal ? rect.left : rect.top
    document.body.classList.add("resizing")

    const onMove = (ev) => {
      const pos = horizontal ? ev.clientX : ev.clientY
      let frac = (pos - start) / total
      frac = Math.max(0.1, Math.min(0.9, frac))
      node.sizeA = frac
      wrapA.style.flex = `${frac} 1 0`
      wrapB.style.flex = `${1 - frac} 1 0`
      panes.forEach(fitPane)
    }
    const onUp = (ev) => {
      resizer.releasePointerCapture(e.pointerId)
      document.body.classList.remove("resizing")
      resizer.removeEventListener("pointermove", onMove)
      resizer.removeEventListener("pointerup", onUp)
      panes.forEach(fitPane)
      saveState()
    }
    resizer.addEventListener("pointermove", onMove)
    resizer.addEventListener("pointerup", onUp)
  })
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

// Render a chunk of session output. Captured command output (stream
// "command") gets a subtle green background so it stands out from the AI text,
// the "$ command" line and the "exit code" line, which are left untinted.
const OUTPUT_BG = "\u001b[48;2;20;28;22m" // near-black gray with a hint of green

function renderOutput(data, stream) {
  if (stream === "stderr") return `\u001b[31m${data}\u001b[0m`
  if (stream !== "command") return data
  // Tint each line and extend the background to the row end with \u001b[K,
  // reopening the background after each newline so every line is covered.
  const open = OUTPUT_BG
  const body = data.replace(/\r?\n/g, "\u001b[K\u001b[0m\r\n" + open)
  return open + body + "\u001b[K\u001b[0m"
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
      if (event.key === "c" && event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
        const sel = term.getSelection()
        if (sel && navigator.clipboard) navigator.clipboard.writeText(sel).catch(() => {})
        term.clearSelection()
        event.preventDefault()
        event.stopPropagation()
        return false
      }
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
    if (ch === "\n") handleInput(pane, pane.raw ? "\r" : "\n")
    else if (ch === "\t" || ch.charCodeAt(0) >= 32) handleInput(pane, ch)
  }
}

const EXIT_COMMANDS = new Set(["exit", "quit", "/exit", "/quit", ":q", "logout"])
const CLEAR_COMMANDS = new Set(["cls", "clear", "/clear"])

function handleInput(pane, data) {
  // While the pane is busy (a prompt was sent and the agent/model is still
  // working) block all input except Ctrl+C so the user cannot type until the
  // model is done and the prompt returns.
  if (pane.busy && data !== "\u0003" && data !== "\u001b") return

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

  if (data === "\u001b") {
    // Bare Esc: break the loop just like Ctrl+C.
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
      const previousBuffer = pane.buffer
      const previousCursor = pane.cursor
      pane.buffer = pane.buffer.slice(0, start) + pane.buffer.slice(pane.cursor)
      pane.cursor = start
      redrawLine(pane, previousBuffer, previousCursor)
    }
    return
  }

  if (data === "\u007f") {
    // Backspace: delete the character before the cursor.
    if (pane.cursor > 0) {
      const previousBuffer = pane.buffer
      const previousCursor = pane.cursor
      pane.buffer = pane.buffer.slice(0, pane.cursor - 1) + pane.buffer.slice(pane.cursor)
      pane.cursor--
      // A terminal backspace cannot cross xterm's soft-wrap boundary. Repaint
      // instead, so deleting the first character on a wrapped row returns to
      // the preceding row as expected.
      redrawLine(pane, previousBuffer, previousCursor)
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

// Return the cursor position relative to the start of the prompt after
// rendering `offset` UTF-16 code units of `text`. `column === columns` means
// xterm is at the right margin with a soft wrap pending; the next printable
// character will move to the next row.
function terminalPosition(text, offset, startColumn, columns) {
  let row = 0
  let column = startColumn

  for (const char of text.slice(0, offset)) {
    if (char === "\n") {
      row++
      column = 0
      continue
    }

    const width = terminalCharWidth(char)
    if (width === 0) continue
    // xterm wraps before a character following the right margin. A wide
    // character also wraps rather than straddling the final column.
    if (column >= columns || column + width > columns) {
      row++
      column = 0
    }
    column += width
  }

  return { row, column }
}

// A compact wcwidth approximation for cursor positioning. Prompt editing is
// normally ASCII, but treating combining marks and common East-Asian/emoji
// characters correctly prevents a repaint from drifting after them.
function terminalCharWidth(char) {
  const code = char.codePointAt(0)
  if (code === undefined || code === 0 || (code >= 0x300 && code <= 0x36f)) return 0
  if (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff))
  ) return 2
  return 1
}

// Repaint the current input and restore its cursor. Unlike a terminal's BS or
// CUB control sequences, this accounts for both explicit newlines and xterm's
// soft wraps, which do not allow the cursor to move backwards across a row.
function redrawLine(pane, previousBuffer = pane.buffer, previousCursor = pane.cursor) {
  const columns = Math.max(pane.term.cols || 80, 1)
  const plainPrompt = promptText(pane).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
  const promptWidth = [...plainPrompt].reduce((width, char) => width + terminalCharWidth(char), 0)
  // Preserve a right-margin position rather than reducing it to zero: the
  // first typed character after a prompt exactly filling a row soft-wraps.
  const startColumn = promptWidth === 0 ? 0 : ((promptWidth - 1) % columns) + 1
  const oldCursor = terminalPosition(previousBuffer, previousCursor, startColumn, columns)

  // Return to the prompt's first input row, remove every old visual row, then
  // draw the replacement. Send this as one write: separate writes let xterm
  // render an intermediate cursor at column zero, visible as a blue flash.
  let redraw = "\r"
  if (oldCursor.row > 0) redraw += `\u001b[${oldCursor.row}A`
  redraw += `\u001b[J${promptText(pane)}${pane.buffer}`

  if (pane.cursor !== pane.buffer.length) {
    const cursor = terminalPosition(pane.buffer, pane.cursor, startColumn, columns)
    const end = terminalPosition(pane.buffer, pane.buffer.length, startColumn, columns)
    const rowsBack = end.row - cursor.row
    if (rowsBack > 0) redraw += `\u001b[${rowsBack}A`
    redraw += "\r"
    if (cursor.column > 0) redraw += `\u001b[${cursor.column}C`
  }

  pane.term.write(redraw)
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
      pane.term.write(renderOutput(message.data, message.stream))
      // The spinner redraws with "\r\u001b[K", which clears the current line.
      // If the output just written did not end in a newline, the cursor still
      // sits on a line holding real text, so restarting the spinner there
      // would erase it (it survives only in the server replay buffer, hence it
      // reappears on reload). Only resume the spinner on a fresh line.
      const endsOnNewLine = /\r?\n$/.test(message.data)
      if (pane.busy && endsOnNewLine) startSpinner(pane)
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
