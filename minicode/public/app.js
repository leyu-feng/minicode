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
  const label = pane.kind === "agent" ? "minicode" : "PS"
  const prefix = leadingNewline ? "\r\n" : ""
  return `${prefix}\u001b[32m${label}\u001b[0m \u001b[90m${pane.cwd || repoRoot}\u001b[0m> `
}

function prompt(pane, leadingNewline = false) {
  pane.term.write(promptText(pane, leadingNewline))
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
  term.onData((data) => handleInput(pane, data))
  panes.set(id, pane)

  header.querySelector(".pane-title").textContent = cwd
  send({ type: "create", sessionId: id, kind, cwd })
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
  pane.term.write(`\u001b[2K\r`)
  pane.buffer = ""
  prompt(pane)
  pane.term.write(value)
  pane.buffer = value
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
    send({ type: "interrupt", sessionId: pane.id })
    if (!pane.busy) prompt(pane)
    return
  }

  if (data === "\r") {
    const line = pane.buffer
    pane.buffer = ""
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

    pane.busy = true
    // Echo is what the server stores in its replay buffer so a page reload
    // shows the same transcript the user typed.
    send({ type: "input", sessionId: pane.id, data: line, echo: `${promptText(pane)}${line}\r\n` })
    saveState()
    return
  }

  if (data === "\u007f") {
    if (pane.buffer.length > 0) {
      pane.buffer = pane.buffer.slice(0, -1)
      pane.term.write("\b \b")
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

  pane.buffer += data
  pane.term.write(data)
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
      panes.forEach((pane) => send({ type: "create", sessionId: pane.id, kind: pane.kind, cwd: pane.cwd }))
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

      if (message.restored) {
        // Replay the transcript the server buffered while we were away.
        if (message.buffer) pane.term.write(message.buffer)
        pane.term.write("\u001b[90m—— reattached to running session ——\u001b[0m\r\n")
      } else {
        pane.term.write(
          pane.kind === "agent"
            ? "\u001b[90mAsk anything. The agent runs shell commands in this repo. Type 'exit' to close this pane.\u001b[0m\r\n"
            : "\u001b[90mLine-based shell (no PTY): full-screen TUI apps are unsupported. Type 'exit' to close this pane.\u001b[0m\r\n",
        )
      }

      pane.buffer = ""
      pane.busy = Boolean(message.busy)
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
      pane.term.write(message.stream === "stderr" ? `\u001b[31m${message.data}\u001b[0m` : message.data)
      return
    }

    if (message.type === "done") {
      pane.busy = false
      prompt(pane, true)
      return
    }

    if (message.type === "exit") {
      pane.busy = false
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
  else if (action === "new-shell") addPane("shell")
  else if (action === "split-right" && focusedId) splitPane(focusedId, "row", panes.get(focusedId).kind)
  else if (action === "split-down" && focusedId) splitPane(focusedId, "col", panes.get(focusedId).kind)
  else if (action === "close" && focusedId) removePane(focusedId)
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
