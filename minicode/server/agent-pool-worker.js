import fs from "node:fs/promises"
import path from "node:path"
import { randomBytes, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import WebSocket from "ws"
import { AgentSession } from "./agent-session.js"
import { authFilePath } from "./auth.js"

const MAX_FRAME = 256 * 1024
const MAX_OUTPUT = 2 * 1024 * 1024
const LEASE_MS = 60_000
const execFileAsync = promisify(execFile)

function workspaceEnv() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/i.test(key)) delete env[key]
  }
  return env
}

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, { cwd, env: workspaceEnv(), windowsHide: true, timeout: 120_000 })
  return stdout.trim()
}

function isInside(root, target) {
  const relative = path.relative(root, target)
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

async function prepareAgentWorkspace(source, root, agentId) {
  if (typeof agentId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(agentId)) {
    throw new Error("AgentPool task requires a valid agent id for its workspace")
  }
  const workspace = path.join(root, agentId)
  let existing
  try {
    existing = await fs.lstat(workspace)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  if (existing) {
    if (!existing.isDirectory() || !(await fs.lstat(path.join(workspace, ".git"))).isDirectory()
      || await fs.realpath(await git(workspace, ["rev-parse", "--show-toplevel"])) !== workspace) {
      throw new Error(`AgentPool workspace is not an independent Git checkout: ${workspace}`)
    }
    await git(workspace, ["rev-parse", "--verify", "HEAD"])
    return workspace
  }
  const temporary = await fs.mkdtemp(path.join(root, `${agentId}-initializing-`))
  try {
    await git(source, ["clone", "--no-hardlinks", "--", source, temporary])
    await fs.rename(temporary, workspace)
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true })
    throw new Error(`Could not prepare AgentPool workspace: ${error.message}`, { cause: error })
  }
  return workspace
}

export function agentPoolServerUrl(value) {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || !["http:", "https:"].includes(url.protocol)) throw new Error("--server must be an HTTP(S) server origin")
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("AgentPool requires HTTPS except on loopback")
  }
  return url
}

export async function loadWorkerCredential({ server, workerId, cwd, stateDir }) {
  const directory = stateDir || path.join(path.dirname(authFilePath()), "agent-pool")
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const file = path.join(directory, `${workerId}.json`)
  let state
  try {
    state = JSON.parse(await fs.readFile(file, "utf8"))
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Invalid AgentPool worker credential file; repair it or pair a new worker")
    if (error.code !== "ENOENT") throw error
    state = { server, workerId, cwd, clientToken: randomBytes(32).toString("hex") }
    await fs.writeFile(file, JSON.stringify(state), { flag: "wx", mode: 0o600 })
  }
  if (state.server !== server || state.workerId !== workerId || state.cwd !== cwd
    || !/^[a-f0-9]{64}$/.test(state.clientToken)) {
    throw new Error("Worker credential belongs to a different server or working directory; pair a new worker")
  }
  return state
}

export async function startAgentPoolWorker({
  server, workerId, cwd, clientToken,
  workspaceRoot = path.join(path.dirname(authFilePath()), "agent-pool", "workspaces", workerId),
  sessionFactory = (options) => new AgentSession(options),
  reconnectMs = 1000, leaseMs = LEASE_MS,
  log = (message) => process.stderr.write(`${message}\n`),
}) {
  const origin = agentPoolServerUrl(server)
  if (!(await fs.stat(cwd)).isDirectory()) throw new Error("--repo-root must be an existing directory")
  cwd = await fs.realpath(cwd)
  if (await fs.realpath(await git(cwd, ["rev-parse", "--show-toplevel"])) !== cwd) {
    throw new Error("AgentPool --repo-root must be the root of the source Git repository")
  }
  await git(cwd, ["rev-parse", "--verify", "HEAD"])
  workspaceRoot = path.resolve(workspaceRoot)
  if (isInside(cwd, workspaceRoot)) throw new Error("AgentPool workspaces must be outside the source checkout")
  await fs.mkdir(workspaceRoot, { recursive: true, mode: 0o700 })
  workspaceRoot = await fs.realpath(workspaceRoot)
  if (isInside(cwd, workspaceRoot)) throw new Error("AgentPool workspaces must be outside the source checkout")
  const endpoint = new URL("/api/agent-pool/worker", origin)
  endpoint.protocol = origin.protocol === "https:" ? "wss:" : "ws:"
  endpoint.searchParams.set("workerId", workerId)
  const instanceId = randomUUID()
  let socket, reconnectTimer, leaseTimer, heartbeatTimer
  let stopped = false
  let connected = false
  let active = null
  let previousServer = null
  let settle
  const finished = new Promise((resolve) => { settle = resolve })

  function send(value) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value))
  }

  async function stop(error = null) {
    if (stopped) return
    stopped = true
    connected = false
    clearTimeout(reconnectTimer)
    clearTimeout(leaseTimer)
    clearTimeout(heartbeatTimer)
    active?.session?.interrupt()
    socket?.close(1000, "worker stopped")
    // write() settles only after its active model/tool operation unwinds.
    await active?.execution
    active?.session?.dispose()
    settle(error)
  }

  function ack(seq, completed) {
    if (!active || !Number.isSafeInteger(seq) || seq < 0 || seq > active.seq) {
      throw new Error("AgentPool acknowledgement mismatch")
    }
    active.events = active.events.filter((event) => event.seq > seq)
    if (completed) {
      if (!active.done || seq !== active.seq) throw new Error("AgentPool completed an unfinished execution")
      active.session?.dispose()
      active = null
      send({ type: "ready" })
    }
  }

  function enqueue(run, value) {
    const event = { ...value, runId: run.id, seq: ++run.seq }
    run.events.push(event)
    if (connected) send(event)
  }

  function execute(task) {
    if (active || typeof task.runId !== "string" || !task.context || typeof task.context !== "object") {
      throw new Error("AgentPool task received while busy or invalid")
    }
    const reachableUrl = (value) => {
      const target = new URL(value)
      return new URL(target.pathname + target.search, origin).href
    }
    const runtimeTools = task.runtimeTools ? {
      ...task.runtimeTools,
      mcpEndpoint: reachableUrl(task.runtimeTools.mcpEndpoint),
      rest: {
        connectionsSearch: reachableUrl(task.runtimeTools.rest.connectionsSearch),
        connectionRequest: reachableUrl(task.runtimeTools.rest.connectionRequest),
      },
    } : null
    const run = { id: task.runId, session: null, seq: 0, events: [], bytes: 0, done: false,
      execution: null, overflow: false, cancelled: false }
    active = run
    run.execution = Promise.resolve().then(async () => {
      if (stopped || run.cancelled) return { exitCode: 130 }
      const workspace = await prepareAgentWorkspace(cwd, workspaceRoot, task.agent?.id)
      if (stopped || run.cancelled) return { exitCode: 130 }
      const session = sessionFactory({
        id: task.runId, cwd: workspace,
        env: {
          ...workspaceEnv(),
          PAPERCLIP_API_URL: origin.origin,
          PAPERCLIP_API_KEY: task.authToken ?? "",
          PAPERCLIP_RUN_ID: task.runId,
          PAPERCLIP_AGENT_ID: task.agent.id,
          PAPERCLIP_RUNTIME_TOOLS_JSON: JSON.stringify(runtimeTools),
        },
      })
      run.session = session
      session.on("output", ({ stream, data }) => {
        if (stopped || run.overflow) return
        run.bytes += Buffer.byteLength(data)
        if (run.bytes > MAX_OUTPUT) {
          run.overflow = true
          session.interrupt()
          return
        }
        for (let start = 0; start < data.length; start += 4096) {
          enqueue(run, { type: "log", stream: stream === "stderr" ? "stderr" : "stdout", data: data.slice(start, start + 4096) })
        }
      })
      enqueue(run, { type: "log", stream: "stdout", data: `[minicode] Agent workspace: ${workspace}\n` })
      const serverContext = Object.fromEntries([
        "task", "issueId", "taskId", "projectId", "conversationMode",
        "paperclipIssue", "paperclipTaskMarkdown", "paperclipTaskMarkdownAssignment",
        "paperclipTaskMarkdownCompact", "paperclipTaskMarkdownAssignmentCompact",
        "paperclipTaskCommunicationGuidance", "paperclipWake", "paperclipWakeComment",
        "paperclipContinuationSummary", "paperclipFreshSessionHandoffMarkdown",
        "paperclipSessionHandoffMarkdown", "paperclipWorkspace", "paperclipSkillTest",
        "paperclipTurnContext", "executionContinuation",
      ].filter((key) => Object.hasOwn(task.context, key)).map((key) => [key, task.context[key]]))
      const prompt = [
        "Execute this assigned AgentPool task in your persistent agent workspace. Treat the following JSON as task context.",
        `Your actual tool working directory is ${workspace}. Workspace paths in serverContext describe the control-plane host, not this worker; use your local workspace for file operations.`,
        "Report failure honestly. Do not claim control-plane updates unless you performed them.",
        "Run-scoped Paperclip access is in shell environment PAPERCLIP_API_URL and PAPERCLIP_API_KEY. Runtime tool connection details are in PAPERCLIP_RUNTIME_TOOLS_JSON. Never print credentials.",
        task.runtimeTools?.guidance ?? "",
        JSON.stringify({ agent: task.agent, workspace: { cwd: workspace }, serverContext, continuation: task.continuation }),
      ].join("\n\n")
      return session.write(prompt)
    }).then((result) => {
      if (stopped) return
      run.done = true
      enqueue(run, {
        type: "result", exitCode: run.overflow ? 1 : result?.exitCode ?? 1,
        ...(run.overflow ? { error: "AgentPool output limit exceeded" }
          : result?.error ? { error: String(result.error).slice(0, 2000) } : {}),
      })
    }).catch((error) => {
      if (stopped) return
      run.done = true
      enqueue(run, { type: "result", exitCode: 1, error: String(error.message).slice(0, 2000) })
    })
  }

  function connect() {
    if (stopped) return
    socket = new WebSocket(endpoint, {
      headers: { Authorization: `Bearer ${clientToken}` }, maxPayload: MAX_FRAME, handshakeTimeout: 10_000,
    })
    const current = socket
    const heartbeat = () => {
      clearTimeout(heartbeatTimer)
      heartbeatTimer = setTimeout(() => current.terminate(), 45_000)
    }
    current.on("open", () => {
      heartbeat()
      send({ type: "hello", instanceId, runId: active?.id ?? null })
    })
    current.on("ping", heartbeat)
    current.on("message", (data, binary) => {
      try {
        if (binary) throw new Error("AgentPool expects JSON text")
        const message = JSON.parse(data.toString())
        if (message.type === "welcome") {
          if (connected || typeof message.serverInstanceId !== "string" || message.runId !== (active?.id ?? null)
            || (active && previousServer && previousServer !== message.serverInstanceId)) {
            throw new Error("AgentPool server lost the execution; retry the run explicitly")
          }
          previousServer = message.serverInstanceId
          clearTimeout(leaseTimer)
          leaseTimer = null
          connected = true
          log("AgentPool worker connected")
          if (active) {
            ack(message.ack, message.completed)
            for (const event of active?.events ?? []) send(event)
          } else send({ type: "ready" })
        } else if (!connected) throw new Error("AgentPool welcome required")
        else if (message.type === "task") execute(message)
        else if (message.type === "ack") {
          if (message.runId !== active?.id) throw new Error("AgentPool run acknowledgement mismatch")
          ack(message.seq, message.completed)
        } else if (message.type === "cancel") {
          if (message.runId !== active?.id) throw new Error("AgentPool cancellation mismatch")
          active.cancelled = true
          active.session?.interrupt()
        } else throw new Error("Unknown AgentPool message")
      } catch (error) {
        void stop(error)
      }
    })
    current.on("unexpected-response", (_request, response) => {
      response.resume()
      void stop(new Error(`AgentPool authentication failed (HTTP ${response.statusCode}); check pairing or revocation`))
    })
    current.on("error", (error) => {
      if (!stopped) log(`AgentPool connection error: ${error.message}`)
    })
    current.on("close", (code) => {
      connected = false
      clearTimeout(heartbeatTimer)
      if (stopped) return
      if (code === 1008) { void stop(new Error("AgentPool execution or credentials rejected; retry explicitly")); return }
      log("AgentPool disconnected; reconnecting without replay")
      if (active && !leaseTimer) {
        leaseTimer = setTimeout(() => void stop(new Error("AgentPool reconnect lease expired; execution stopped")), leaseMs)
      }
      reconnectTimer = setTimeout(connect, reconnectMs)
    })
  }
  connect()
  return { stop, finished }
}

export async function runAgentPoolWorkerCli(argv, repoRoot) {
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    if (!["--server", "--worker-id"].includes(argv[i]) || !argv[i + 1]) throw new Error("Usage: minicode worker --server <origin> --worker-id <id> [--repo-root <directory>]")
    options[argv[i].slice(2)] = argv[++i]
  }
  const workerId = options["worker-id"]
  if (!/^[a-f0-9-]{36}$/.test(workerId ?? "")) throw new Error("Worker requires --worker-id")
  const server = agentPoolServerUrl(options.server).origin
  const cwd = await fs.realpath(path.resolve(repoRoot || process.env.MINICODE_REPO_ROOT || process.cwd()))
  const state = await loadWorkerCredential({ server, workerId, cwd })
  const serverToken = process.env.MINICODE_AGENT_POOL_PAIRING_TOKEN
  delete process.env.MINICODE_AGENT_POOL_PAIRING_TOKEN
  if (serverToken) {
    const response = await fetch(new URL("/api/agent-pool/pair", server), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workerId, serverToken, clientToken: state.clientToken }),
      signal: AbortSignal.timeout(15_000), redirect: "error",
    })
    if (!response.ok) throw new Error(`AgentPool pairing failed (HTTP ${response.status}). Tokens are single-use; if already paired, unset MINICODE_AGENT_POOL_PAIRING_TOKEN and reconnect.`)
  }
  const worker = await startAgentPoolWorker({ server, workerId, cwd, clientToken: state.clientToken })
  const onSignal = () => { void worker.stop() }
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)
  const error = await worker.finished
  process.off("SIGINT", onSignal)
  process.off("SIGTERM", onSignal)
  if (error) throw error
}
