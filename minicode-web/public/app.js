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
    addPane("agent")
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
  layoutEl.replaceChildren(renderNode(layout))
  requestAnimationFrame(() => panes.forEach(fitPane))
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

function prompt(pane, leadingNewline = false) {
  const label = pane.kind === "agent" ? "minicode" : "PS"
  const prefix = leadingNewline ? "\r\n" : ""
  pane.term.write(`${prefix}\u001b[32m${label}\u001b[0m \u001b[90m${pane.cwd || repoRoot}\u001b[0m> `)
}

function createPane(kind) {
  const id = uid(kind)

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
  term.open(body)

  const pane = {
    id,
    kind,
    el,
    header,
    term,
    fit,
    cwd: repoRoot,
    buffer: "",
    history: [],
    historyIndex: -1,
    busy: false,
  }

  el.addEventListener("mousedown", () => focusPane(id))
  term.onData((data) => handleInput(pane, data))
  panes.set(id, pane)

  header.querySelector(".pane-title").textContent = id
  send({ type: "create", sessionId: id, kind, cwd: repoRoot })
  return pane
}

function addPane(kind) {
  const pane = createPane(kind)
  const leaf = { type: "leaf", paneId: pane.id }
  if (!layout) layout = leaf
  else layout = { type: "split", dir: "row", a: layout, b: leaf }
  render()
  focusPane(pane.id)
}

function replaceLine(pane, value) {
  pane.term.write(`\u001b[2K\r`)
  pane.buffer = ""
  prompt(pane)
  pane.term.write(value)
  pane.buffer = value
}

function handleInput(pane, data) {
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
    pane.busy = true
    send({ type: "input", sessionId: pane.id, data: line })
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
    if (!layout) addPane("agent")
    else panes.forEach((pane) => send({ type: "create", sessionId: pane.id, kind: pane.kind, cwd: pane.cwd }))
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
      pane.term.write(
        pane.kind === "agent"
          ? "\u001b[90mAsk anything. The agent runs shell commands in this repo.\u001b[0m\r\n"
          : "\u001b[90mLine-based shell (no PTY): full-screen TUI apps are unsupported.\u001b[0m\r\n",
      )
      pane.busy = false
      prompt(pane)
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
      pane.term.write(`\r\n\u001b[90msession ended (${message.code})\u001b[0m\r\n`)
      pane.busy = false
    }
  })
}

/* --------------------------------------------------------------- toolbar */

document.querySelector(".toolbar").addEventListener("click", (event) => {
  const action = event.target.dataset?.action
  if (!action) return
  if (action === "new-agent") addPane("agent")
  else if (action === "new-shell") addPane("shell")
  else if (action === "split-right" && focusedId) splitPane(focusedId, "row", panes.get(focusedId).kind)
  else if (action === "split-down" && focusedId) splitPane(focusedId, "col", panes.get(focusedId).kind)
  else if (action === "close" && focusedId) removePane(focusedId)
})

window.addEventListener("resize", () => panes.forEach(fitPane))

fetch("/api/info")
  .then((res) => res.json())
  .then((info) => {
    repoRoot = info.repoRoot
    repoEl.textContent = `${info.repoRoot} · ${info.model}`
  })
  .finally(connect)
