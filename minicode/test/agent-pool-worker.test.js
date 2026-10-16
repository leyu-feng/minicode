import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { EventEmitter, once } from "node:events"
import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import test from "node:test"
import { WebSocketServer } from "ws"
import { agentPoolServerUrl, loadWorkerCredential, startAgentPoolWorker } from "../server/agent-pool-worker.js"
import { AgentSession } from "../server/agent-session.js"

const execFileAsync = promisify(execFile)
const agent = { id: "agent-a", name: "Agent A" }

async function waitUntil(predicate) {
  const deadline = Date.now() + 10_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for worker state")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function harness(t, factory) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-workspace-test-"))
  const source = path.join(directory, "source repo")
  const workspaceRoot = path.join(directory, "workspaces")
  await fs.mkdir(source)
  const git = async (...args) => (await execFileAsync("git", args, { cwd: source, windowsHide: true })).stdout.trim()
  await git("init", "--initial-branch=main")
  await fs.writeFile(path.join(source, "tracked.txt"), "committed")
  await git("add", "tracked.txt")
  await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "Fixture")
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  await once(server, "listening")
  const connections = []
  const serverInstanceId = randomUUID()
  server.on("connection", (socket) => {
    const peer = { socket, messages: [], send: (message) => socket.send(JSON.stringify(message)) }
    connections.push(peer)
    socket.on("message", (raw) => peer.messages.push(JSON.parse(raw.toString())))
  })
  const options = {
    server: `http://127.0.0.1:${server.address().port}`, workerId: randomUUID(),
    clientToken: "a".repeat(64), cwd: source, workspaceRoot, sessionFactory: factory,
    reconnectMs: 10, log: () => {},
  }
  let worker = await startAgentPoolWorker(options)
  t.after(async () => {
    await worker.stop()
    for (const socket of server.clients) socket.terminate()
    await new Promise((resolve) => server.close(resolve))
    await fs.rm(directory, { recursive: true, force: true })
  })
  async function welcome(index, ack = 0, completed = false) {
    await waitUntil(() => connections[index]?.messages.some((message) => message.type === "hello"))
    const peer = connections[index]
    const hello = peer.messages.find((message) => message.type === "hello")
    peer.send({ type: "welcome", serverInstanceId, runId: hello.runId, ack, completed })
    return peer
  }
  return {
    worker, welcome, connections, serverInstanceId, source, workspaceRoot, git,
    async restart() {
      await worker.stop()
      worker = await startAgentPoolWorker(options)
    },
  }
}

test("worker credentials survive restart, stay bound to root/server, and require secure transport", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-worker-test-"))
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }))
  const options = { server: "https://pool.example.test", workerId: randomUUID(), cwd: process.cwd(), stateDir }
  const first = await loadWorkerCredential(options)
  assert.match(first.clientToken, /^[a-f0-9]{64}$/)
  assert.deepEqual(await loadWorkerCredential(options), first)
  await assert.rejects(loadWorkerCredential({ ...options, cwd: os.tmpdir() }), /different server or working directory/)
  assert.throws(() => agentPoolServerUrl("http://remote.example.test"), /requires HTTPS/)
  assert.throws(() => agentPoolServerUrl("https://user:pass@example.test"), /server origin/)
})

test("network reconnect resumes the same session and replays only unacknowledged output", async (t) => {
  let calls = 0, complete, session
  class Session extends EventEmitter {
    write() { calls++; return new Promise((resolve) => { complete = resolve }) }
    interrupt() { complete?.({ exitCode: 130 }) }
    dispose() {}
  }
  const { welcome, connections } = await harness(t, () => { session = new Session(); return session })
  const first = await welcome(0)
  await waitUntil(() => first.messages.some((message) => message.type === "ready"))
  first.send({ type: "task", runId: "run-1", agent, context: { task: "work" } })
  await waitUntil(() => calls === 1)
  session.emit("output", { stream: "stdout", data: "before" })
  await waitUntil(() => first.messages.some((message) => message.data === "before"))
  const before = first.messages.find((message) => message.data === "before")
  first.send({ type: "ack", runId: "run-1", seq: before.seq, completed: false })
  first.socket.terminate()
  await waitUntil(() => connections.length === 2)
  session.emit("output", { stream: "stdout", data: "while offline" })
  complete({ exitCode: 0 })
  const resumed = await welcome(1, before.seq)
  await waitUntil(() => resumed.messages.some((message) => message.type === "result"))
  assert.equal(calls, 1)
  assert.deepEqual(resumed.messages.filter((message) => message.type === "log").map((message) => message.data), ["while offline"])
  assert.equal(resumed.messages.find((message) => message.type === "hello").runId, "run-1")
  const result = resumed.messages.find((message) => message.type === "result")
  resumed.send({ type: "ack", runId: "run-1", seq: result.seq, completed: true })
  await waitUntil(() => resumed.messages.some((message) => message.type === "ready"))
})

test("cancellation waits for the active operation, not the immediate done event", async (t) => {
  let release, interrupted = false
  class Session extends EventEmitter {
    write() { return new Promise((resolve) => { release = resolve }) }
    interrupt() { interrupted = true; this.emit("done", { exitCode: 130 }) }
    dispose() {}
  }
  const { welcome } = await harness(t, () => new Session())
  const peer = await welcome(0)
  peer.send({ type: "task", runId: "cancel-run", agent, context: {} })
  await waitUntil(() => release)
  peer.send({ type: "cancel", runId: "cancel-run" })
  await waitUntil(() => interrupted)
  assert.equal(peer.messages.some((message) => message.type === "result"), false)
  release({ exitCode: 130 })
  await waitUntil(() => peer.messages.some((message) => message.type === "result"))
  assert.equal(peer.messages.find((message) => message.type === "result").exitCode, 130)
})

test("run credentials stay in the per-session tool environment rather than the model prompt", async (t) => {
  const inheritedApiKey = process.env.PAPERCLIP_API_KEY
  let options, prompt
  class Session extends EventEmitter {
    async write(value) { prompt = value; return { exitCode: 0 } }
    interrupt() {}
    dispose() {}
  }
  const { welcome } = await harness(t, (value) => { options = value; return new Session() })
  const peer = await welcome(0)
  const runtimeTools = {
    bearerToken: "tool-token-fixture", guidance: "Use the assigned tools",
    mcpEndpoint: "http://internal-server:3100/mcp",
    rest: { connectionsSearch: "http://internal-server:3100/api/search", connectionRequest: "http://internal-server:3100/api/request" },
  }
  const taskContext = {
    task: "Complete the assignment",
    paperclipTaskMarkdown: "Full task instructions",
    paperclipTaskMarkdownAssignment: "Assigned task instructions",
    paperclipTaskCommunicationGuidance: "Report progress on the task",
    paperclipWake: { reason: "issue_assigned", comments: [{ body: "Latest task update" }] },
    paperclipContinuationSummary: { body: "Previous progress" },
    paperclipWorkspace: { cwd: "control-plane-workspace" },
  }
  const continuation = { objective: "Finish the assignment", completedWork: "Previous step" }
  peer.send({
    type: "task", runId: "credential-run", authToken: "run-jwt-fixture", agent: { id: "agent-id" },
    runtimeTools, continuation,
    context: {
      ...taskContext,
      paperclipRuntimeTools: runtimeTools,
      paperclipManagedMcp: { env: { MCP_TOKEN: "managed-mcp-token-fixture" } },
      futureRuntimeConfig: { credential: "future-token-fixture" },
    },
  })
  await waitUntil(() => peer.messages.some((message) => message.type === "result"))
  assert.equal(options.env.PAPERCLIP_API_KEY, "run-jwt-fixture")
  assert.equal(JSON.parse(options.env.PAPERCLIP_RUNTIME_TOOLS_JSON).bearerToken, "tool-token-fixture")
  assert.equal(new URL(JSON.parse(options.env.PAPERCLIP_RUNTIME_TOOLS_JSON).mcpEndpoint).hostname, "127.0.0.1")
  assert.ok(!prompt.includes("run-jwt-fixture"))
  assert.ok(!prompt.includes("tool-token-fixture"))
  assert.ok(!prompt.includes("managed-mcp-token-fixture"))
  assert.ok(!prompt.includes("future-token-fixture"))
  assert.ok(prompt.includes(runtimeTools.guidance))
  const modelContext = JSON.parse(prompt.split("\n\n").at(-1))
  assert.deepEqual(modelContext.serverContext, taskContext)
  assert.deepEqual(modelContext.continuation, continuation)
  assert.equal(process.env.PAPERCLIP_API_KEY, inheritedApiKey)
})

test("a changed server process fails and stops the live execution without rerunning it", async (t) => {
  let complete, calls = 0, interrupted = 0
  class Session extends EventEmitter {
    write() { calls++; return new Promise((resolve) => { complete = resolve }) }
    interrupt() { interrupted++; complete?.({ exitCode: 130 }) }
    dispose() {}
  }
  const { worker, welcome, connections } = await harness(t, () => new Session())
  const first = await welcome(0)
  first.send({ type: "task", runId: "restart-run", agent, context: {} })
  await waitUntil(() => calls === 1)
  first.socket.terminate()
  await waitUntil(() => connections[1]?.messages.some((message) => message.type === "hello"))
  connections[1].send({ type: "welcome", serverInstanceId: randomUUID(), runId: "restart-run", ack: 0, completed: false })
  const error = await worker.finished
  assert.match(error.message, /lost the execution/)
  assert.equal(calls, 1)
  assert.equal(interrupted, 1)
})

test("real model tools use committed files in an independent workspace, not the source checkout", async (t) => {
  const originalKey = process.env.OPENCODE_API_KEY
  const originalUrl = process.env.OPENCODE_BASE_URL
  const originalGitDir = process.env.GIT_DIR
  process.env.OPENCODE_API_KEY = "fixture-only"
  process.env.OPENCODE_BASE_URL = "https://example.test/v1"
  t.after(() => {
    if (originalKey === undefined) delete process.env.OPENCODE_API_KEY
    else process.env.OPENCODE_API_KEY = originalKey
    if (originalUrl === undefined) delete process.env.OPENCODE_BASE_URL
    else process.env.OPENCODE_BASE_URL = originalUrl
    if (originalGitDir === undefined) delete process.env.GIT_DIR
    else process.env.GIT_DIR = originalGitDir
  })
  const actions = [
    { type: "tool", command: process.platform === "win32"
      ? "Get-Location; Get-ChildItem -Name; git rev-parse --show-toplevel"
      : "pwd; ls; git rev-parse --show-toplevel" },
    { type: "write", path: "tracked.txt", content: "agent-edit" },
    { type: "final", message: "Done" },
  ]
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(actions.shift()) } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } }))
  let cwd
  const fixture = await harness(t, (options) => { cwd = options.cwd; return new AgentSession(options) })
  process.env.GIT_DIR = path.join(fixture.source, ".git")
  await fs.writeFile(path.join(fixture.source, "tracked.txt"), "source-edit")
  await fs.writeFile(path.join(fixture.source, "staged.txt"), "staged-only")
  await fixture.git("add", "staged.txt")
  await fs.writeFile(path.join(fixture.source, "local-only.txt"), "untracked")
  const sourceStatus = await fixture.git("status", "--porcelain")
  const peer = await fixture.welcome(0)
  peer.send({
    type: "task", runId: "real-tools", agent,
    context: { paperclipWorkspace: { cwd: fixture.source } },
  })
  await waitUntil(() => peer.messages.some((message) => message.type === "result"))
  assert.equal(peer.messages.find((message) => message.type === "result").exitCode, 0)
  assert.equal(cwd, path.join(await fs.realpath(fixture.workspaceRoot), agent.id))
  const output = peer.messages.filter((message) => message.type === "log").map((message) => message.data).join("")
  assert.ok(output.includes(cwd))
  assert.ok(output.includes("tracked.txt"))
  assert.ok(!output.includes("local-only.txt"))
  assert.ok(!output.includes(fixture.source))
  assert.ok(!output.includes(fixture.source.replaceAll("\\", "/")))
  assert.equal(await fs.readFile(path.join(cwd, "tracked.txt"), "utf8"), "agent-edit")
  await assert.rejects(fs.stat(path.join(cwd, "staged.txt")), { code: "ENOENT" })
  assert.ok((await fs.stat(path.join(cwd, ".git"))).isDirectory())
  assert.equal(await fs.readFile(path.join(fixture.source, "tracked.txt"), "utf8"), "source-edit")
  assert.equal(await fixture.git("status", "--porcelain"), sourceStatus)
})

test("agent workspaces retain edits across runs and worker restarts without sharing another agent's files", async (t) => {
  const paths = []
  class Session extends EventEmitter {
    constructor(options) { super(); this.cwd = options.cwd; paths.push(this.cwd) }
    async write() {
      const file = path.join(this.cwd, "progress.txt")
      if (paths.length === 1) await fs.writeFile(file, "retained")
      else if (paths.length === 2) assert.equal(await fs.readFile(file, "utf8"), "retained")
      else await assert.rejects(fs.stat(file), { code: "ENOENT" })
      return { exitCode: 0 }
    }
    interrupt() {}
    dispose() {}
  }
  const fixture = await harness(t, (options) => new Session(options))
  async function execute(peer, runId, assignedAgent) {
    const readyCount = peer.messages.filter((message) => message.type === "ready").length
    peer.send({ type: "task", runId, agent: assignedAgent, context: {} })
    await waitUntil(() => peer.messages.some((message) => message.type === "result" && message.runId === runId))
    const result = peer.messages.find((message) => message.type === "result" && message.runId === runId)
    assert.equal(result.exitCode, 0, result.error)
    peer.send({ type: "ack", runId, seq: result.seq, completed: true })
    await waitUntil(() => peer.messages.filter((message) => message.type === "ready").length > readyCount)
  }
  const first = await fixture.welcome(0)
  await waitUntil(() => first.messages.some((message) => message.type === "ready"))
  await execute(first, "agent-a-first", agent)
  await fixture.restart()
  const resumed = await fixture.welcome(1)
  await waitUntil(() => resumed.messages.some((message) => message.type === "ready"))
  await execute(resumed, "agent-a-second", agent)
  await execute(resumed, "agent-b-first", { id: "agent-b" })
  assert.equal(paths[0], paths[1])
  assert.notEqual(paths[0], paths[2])
})

test("workspace preparation failure fails the run without falling back to the source checkout", async (t) => {
  let calls = 0
  const fixture = await harness(t, () => { calls++; throw new Error("Must not start a session") })
  await fs.rename(path.join(fixture.source, ".git"), path.join(fixture.source, "disabled-git"))
  const peer = await fixture.welcome(0)
  peer.send({ type: "task", runId: "clone-failure", agent, context: {} })
  await waitUntil(() => peer.messages.some((message) => message.type === "result"))
  const result = peer.messages.find((message) => message.type === "result")
  assert.equal(result.exitCode, 1)
  assert.match(result.error, /Could not prepare AgentPool workspace/)
  assert.equal(calls, 0)
  assert.deepEqual(await fs.readdir(fixture.workspaceRoot), [])
})

test("cancellation before the workspace is ready never starts the model", async (t) => {
  let calls = 0
  const { welcome } = await harness(t, () => { calls++; throw new Error("Must not start a session") })
  const peer = await welcome(0)
  peer.send({ type: "task", runId: "cancel-preparation", agent, context: {} })
  peer.send({ type: "cancel", runId: "cancel-preparation" })
  await waitUntil(() => peer.messages.some((message) => message.type === "result"))
  assert.equal(peer.messages.find((message) => message.type === "result").exitCode, 130)
  assert.equal(calls, 0)
})

test("invalid agent workspace ids fail without starting a session or creating files", async (t) => {
  const fixture = await harness(t, () => { throw new Error("Must not start a session") })
  const peer = await fixture.welcome(0)
  peer.send({ type: "task", runId: "invalid-workspace", agent: { id: "../source repo" }, context: {} })
  await waitUntil(() => peer.messages.some((message) => message.type === "result"))
  const result = peer.messages.find((message) => message.type === "result")
  assert.equal(result.exitCode, 1)
  assert.match(result.error, /valid agent id/)
  assert.deepEqual(await fs.readdir(fixture.workspaceRoot), [])
})

test("an invalid existing workspace fails without overwriting its files", async (t) => {
  const fixture = await harness(t, () => { throw new Error("Must not start a session") })
  const workspace = path.join(fixture.workspaceRoot, agent.id)
  await fs.mkdir(workspace)
  await fs.writeFile(path.join(workspace, "keep.txt"), "keep")
  const peer = await fixture.welcome(0)
  peer.send({ type: "task", runId: "invalid-existing-workspace", agent, context: {} })
  await waitUntil(() => peer.messages.some((message) => message.type === "result"))
  assert.equal(peer.messages.find((message) => message.type === "result").exitCode, 1)
  assert.equal(await fs.readFile(path.join(workspace, "keep.txt"), "utf8"), "keep")
})

test("worker startup rejects workspace storage inside the source checkout and non-root source directories", async (t) => {
  const fixture = await harness(t, () => { throw new Error("Must not start a session") })
  const options = { server: "http://127.0.0.1:1", workerId: randomUUID(), cwd: fixture.source, clientToken: "a".repeat(64) }
  const inside = path.join(fixture.source, "workspaces")
  await assert.rejects(startAgentPoolWorker({ ...options, workspaceRoot: inside }), /outside the source checkout/)
  await assert.rejects(fs.stat(inside), { code: "ENOENT" })
  const subdirectory = path.join(fixture.source, "subdirectory")
  await fs.mkdir(subdirectory)
  await assert.rejects(startAgentPoolWorker({ ...options, cwd: subdirectory, workspaceRoot: fixture.workspaceRoot }),
    /root of the source Git repository/)
})
