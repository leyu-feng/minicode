import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { EventEmitter, once } from "node:events"
import { createHash, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import test from "node:test"
import { createServer } from "node:http"
import { zipSync } from "fflate"
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

function inlineInstructions(content, revisionId = "revision-1") {
  return { version: 1, format: "markdown", content, revisionId,
    contentSha256: createHash("sha256").update(content).digest("hex") }
}

function skillBundle(contents = {
  "paperclip/SKILL.md": "# Paperclip skill\nPost progress with the issue comments API and verify task completion.",
  "paperclip/references/api-reference.md": "Include X-Paperclip-Run-Id on modifying requests.",
  "paperclip/scripts/report.js": "console.log('bundled helper')",
}) {
  const bytes = Object.fromEntries(Object.entries(contents).map(([name, text]) => [name, Buffer.from(text)]))
  const archive = Buffer.from(zipSync(bytes))
  const hash = data => createHash("sha256").update(data).digest("hex")
  const sha256 = hash(archive)
  return { archive, downloads: [], skills: { version: 1, sha256, url: `/api/agent-pool/skills/${sha256}.zip`,
    files: Object.entries(bytes).map(([name, data]) => ({ path: name, sha256: hash(data) })) } }
}

async function harness(t, factory, workerOptions = {}) {
  const { bundle, ...configuredOptions } = workerOptions
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-workspace-test-"))
  const source = path.join(directory, "source repo")
  const workspaceRoot = path.join(directory, "workspaces")
  await fs.mkdir(source)
  const git = async (...args) => (await execFileAsync("git", args, { cwd: source, windowsHide: true })).stdout.trim()
  await git("init", "--initial-branch=main")
  await fs.writeFile(path.join(source, "tracked.txt"), "committed")
  await git("add", "tracked.txt")
  await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "Fixture")
  const http = createServer((req, res) => {
    if (bundle && req.url === bundle.skills.url) {
      bundle.downloads.push(req.headers)
      if (bundle.hold) return
      res.writeHead(200, { "Content-Type": "application/zip" }).end(bundle.archive)
    } else res.writeHead(404).end()
  })
  const server = new WebSocketServer({ server: http })
  http.listen(0, "127.0.0.1")
  await once(http, "listening")
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
    ...configuredOptions,
  }
  let worker = await startAgentPoolWorker(options)
  t.after(async () => {
    await worker.stop()
    for (const socket of server.clients) socket.terminate()
    await new Promise((resolve) => server.close(resolve))
    await new Promise((resolve) => http.close(resolve))
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

test("an unresolved PR registration failure fails the run even if the model claims success", async t => {
  const issueId = "11111111-1111-4111-8111-111111111111"
  const commit = "a".repeat(40)
  let published = false
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const route = new URL(url).pathname
    if (route === `/api/issues/${issueId}`) return Response.json({ id: issueId, assigneeAgentId: agent.id })
    assert.ok(route.endsWith("/work-products"))
    return options.method === "GET" ? Response.json([]) : new Response("", { status: 403 })
  })
  class Session extends EventEmitter {
    constructor(options) { super(); this.tool = options.tools[0] }
    async write() {
      await assert.rejects(this.tool.execute({ commit, title: "CI", body: "Validated" }), /HTTP 403/)
      return { exitCode: 0 }
    }
    interrupt() {}
    dispose() {}
  }
  const fixture = await harness(t, options => new Session(options), {
    githubRepo: "fixture-owner/repo", githubUser: "fixture-owner",
    async publisherFactory() {
      return () => ({ name: "publish_pull_request", description: "Fixture", parameters: { type: "object", properties: {} },
        async execute() {
          published = true
          return { repository: "fixture-owner/repo", number: 1, url: "https://github.com/fixture-owner/repo/pull/1",
            commit, branch: `minicode/${agent.id}/${commit}`, state: "OPEN", worktreeRemoved: true }
        } })
    },
  })
  const peer = await fixture.welcome(0)
  peer.send({ type: "task", runId: "registration-failure", agent, authToken: "fixture-key", context: { issueId } })
  await waitUntil(() => peer.messages.some(message => message.type === "result"))
  const result = peer.messages.find(message => message.type === "result")
  assert.equal(published, true)
  assert.equal(result.exitCode, 1)
  assert.match(result.error, /GitHub PR exists.*Receipt:.*HTTP 403/)
})

test("inline instructions are agent-scoped snapshots applied without workspace instruction files", async (t) => {
  const sessions = []
  class Session extends EventEmitter {
    async write() { return { exitCode: 0 } }
    interrupt() {}
    dispose() {}
  }
  const fixture = await harness(t, (options) => { sessions.push(options); return new Session() })
  const peer = await fixture.welcome(0)
  assert.deepEqual(peer.messages.find(message => message.type === "hello").capabilities, ["inline_instructions_v1", "skill_bundle_v1"])
  for (const [index, content] of ["Keep reports concise.", "Updated instructions: include evidence."].entries()) {
    const runId = `inline-${index}`
    peer.send({ type: "task", protocolVersion: 1, runId, agent, context: {}, instructions: inlineInstructions(content, `revision-${index}`) })
    await waitUntil(() => peer.messages.some(message => message.type === "result" && message.runId === runId))
    const result = peer.messages.find(message => message.type === "result" && message.runId === runId)
    assert.equal(result.exitCode, 0)
    assert.ok(sessions[index].instructions.includes(content))
    await assert.rejects(fs.stat(path.join(sessions[index].cwd, "AGENTS.md")), { code: "ENOENT" })
    peer.send({ type: "ack", runId, seq: result.seq, completed: true })
    await waitUntil(() => peer.messages.filter(message => message.type === "ready").length === index + 2)
  }
  assert.ok(!sessions[0].instructions.includes("Updated instructions:"))
  assert.ok(!sessions[1].instructions.includes("Keep reports concise."))
  assert.ok(!peer.messages.some(message => message.data?.includes("Keep reports concise.")))
})

test("bundled skills download once, repair extracted files each assignment, and refresh changed archives", async (t) => {
  const bundle = skillBundle()
  const sessions = []
  class Session extends EventEmitter {
    async write() { return { exitCode: 0 } }
    interrupt() {}
    dispose() {}
  }
  const fixture = await harness(t, options => { sessions.push(options); return new Session() }, { bundle })
  const peer = await fixture.welcome(0)
  async function assign(index) {
    const runId = `skills-${index}`
    peer.send({ type: "task", runId, agent: { ...agent, companyId: "company-a" }, skills: bundle.skills,
      authToken: "run-credential", context: { issueId: "task-a", wakeReason: "issue_assigned", commentId: "comment-a" } })
    await waitUntil(() => peer.messages.some(message => message.type === "result" && message.runId === runId))
    const result = peer.messages.find(message => message.type === "result" && message.runId === runId)
    assert.equal(result.exitCode, 0, result.error)
    peer.send({ type: "ack", runId, seq: result.seq, completed: true })
    await waitUntil(() => peer.messages.filter(message => message.type === "ready").length === index + 2)
  }
  await assign(0)
  const workspace = sessions[0].cwd
  const root = path.join(workspace, ".worker", "skills")
  assert.equal(bundle.downloads[0].authorization, "Bearer run-credential")
  assert.equal(bundle.downloads[0]["x-paperclip-run-id"], "skills-0")
  assert.ok(sessions[0].instructions.includes("Post progress with the issue comments API"))
  assert.equal(sessions[0].env.PAPERCLIP_COMPANY_ID, "company-a")
  assert.equal(sessions[0].env.PAPERCLIP_TASK_ID, "task-a")
  assert.equal(sessions[0].env.PAPERCLIP_WAKE_REASON, "issue_assigned")
  assert.equal(sessions[0].env.PAPERCLIP_WAKE_COMMENT_ID, "comment-a")
  assert.ok(!sessions[0].instructions.includes("run-credential"))
  await fs.writeFile(path.join(root, "paperclip", "references", "api-reference.md"), "tampered")
  await fs.writeFile(path.join(root, "unexpected.md"), "unexpected instructions")
  await assign(1)
  assert.equal(bundle.downloads.length, 1)
  assert.match(await fs.readFile(path.join(root, "paperclip", "references", "api-reference.md"), "utf8"), /X-Paperclip-Run-Id/)
  await assert.rejects(fs.stat(path.join(root, "unexpected.md")), { code: "ENOENT" })
  await fs.writeFile(path.join(workspace, ".worker", "skills.zip"), "corrupt cached ZIP")
  await assign(2)
  assert.equal(bundle.downloads.length, 2)
  const next = skillBundle({ "paperclip/SKILL.md": "# Updated Paperclip instructions" })
  bundle.skills = next.skills
  bundle.archive = next.archive
  await assign(3)
  assert.equal(bundle.downloads.length, 3)
  assert.ok(sessions[3].instructions.includes("# Updated Paperclip instructions"))
  await assert.rejects(fs.stat(path.join(root, "paperclip", "scripts")), { code: "ENOENT" })
  const status = await execFileAsync("git", ["status", "--porcelain"], { cwd: workspace, windowsHide: true })
  assert.equal(status.stdout, "")
  await assert.rejects(fs.stat(path.join(fixture.source, ".worker")), { code: "ENOENT" })
})

test("invalid skill manifests, ZIP hashes, and archive contents fail before starting the model", async (t) => {
  const bundle = skillBundle()
  let sessions = 0
  const fixture = await harness(t, () => { sessions++; throw new Error("Must not create a model session") }, { bundle })
  const peer = await fixture.welcome(0)
  const original = structuredClone(bundle.skills)
  const cases = [
    { skills: { ...original, url: "https://other.example/steal-token" }, archive: bundle.archive, error: /manifest/ },
    { skills: original, archive: Buffer.from("corrupted download"), error: /SHA-256 mismatch/ },
    { skills: { ...original, files: [{ path: "../escape", sha256: "a".repeat(64) }] }, archive: bundle.archive, error: /Invalid.*file/ },
    { skills: { ...original, files: [original.files[0], { ...original.files[0], path: "PAPERCLIP/skill.md" }] }, archive: bundle.archive, error: /duplicate/ },
    { skills: { ...original, files: [original.files[0]] }, archive: bundle.archive, error: /contents.*manifest/ },
  ]
  const oversized = skillBundle({ "paperclip/SKILL.md": Buffer.alloc(9 * 1024 * 1024) })
  cases.push({ ...oversized, error: /extraction limits/ })
  for (const [index, entry] of cases.entries()) {
    bundle.skills = entry.skills
    bundle.archive = entry.archive
    const runId = `bad-skills-${index}`
    peer.send({ type: "task", runId, agent, context: {}, authToken: "run-credential", skills: entry.skills })
    await waitUntil(() => peer.messages.some(message => message.type === "result" && message.runId === runId))
    const result = peer.messages.find(message => message.type === "result" && message.runId === runId)
    assert.equal(result.exitCode, 1)
    assert.match(result.error, entry.error)
    peer.send({ type: "ack", runId, seq: result.seq, completed: true })
    await waitUntil(() => peer.messages.filter(message => message.type === "ready").length === index + 2)
  }
  assert.equal(sessions, 0)
  await assert.rejects(fs.stat(path.join(fixture.workspaceRoot, "escape")), { code: "ENOENT" })
})

test("tracked or linked worker skill caches are rejected without changing host-owned files", async (t) => {
  for (const variant of ["tracked", "linked"]) {
    const bundle = skillBundle()
    let sessions = 0
    const fixture = await harness(t, () => { sessions++; throw new Error("Must not start model") }, { bundle })
    if (variant === "tracked") {
      await fs.mkdir(path.join(fixture.source, ".worker"))
      await fs.writeFile(path.join(fixture.source, ".worker", "owned.txt"), "Preserve project files")
      await fixture.git("add", ".worker")
      await fixture.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
        "-c", "commit.gpgsign=false", "commit", "-m", "Existing reserved directory")
    } else {
      await fs.mkdir(fixture.workspaceRoot, { recursive: true })
      const workspace = path.join(fixture.workspaceRoot, agent.id)
      await execFileAsync("git", ["clone", fixture.source, workspace], { windowsHide: true })
      await fs.symlink(fixture.source, path.join(workspace, ".worker"), "junction")
    }
    const peer = await fixture.welcome(0)
    peer.send({ type: "task", runId: variant, agent, context: {}, authToken: "run-key", skills: bundle.skills })
    await waitUntil(() => peer.messages.some(message => message.type === "result"))
    const result = peer.messages.find(message => message.type === "result")
    assert.equal(result.exitCode, 1)
    assert.match(result.error, variant === "tracked" ? /tracked files/ : /links/)
    assert.equal(sessions, 0)
    assert.equal(bundle.downloads.length, 0)
    assert.equal(await fs.readFile(path.join(fixture.source, "tracked.txt"), "utf8"), "committed")
    assert.equal(await fixture.git("status", "--porcelain"), "")
  }
})

test("cancellation aborts a pending skill download before creating a model session", async (t) => {
  const bundle = skillBundle()
  bundle.hold = true
  let sessions = 0
  const fixture = await harness(t, () => { sessions++; throw new Error("Must not start model") }, { bundle })
  const peer = await fixture.welcome(0)
  peer.send({ type: "task", runId: "cancel-download", agent, context: {}, authToken: "run-key", skills: bundle.skills })
  await waitUntil(() => bundle.downloads.length === 1)
  peer.send({ type: "cancel", runId: "cancel-download" })
  await waitUntil(() => peer.messages.some(message => message.type === "result"))
  assert.equal(peer.messages.find(message => message.type === "result").exitCode, 130)
  assert.equal(sessions, 0)
})

test("malformed inline instructions fail before workspace or model work starts", async (t) => {
  let sessions = 0
  const fixture = await harness(t, () => { sessions++; throw new Error("Must not create session") })
  const peer = await fixture.welcome(0)
  const invalid = [
    { ...inlineInstructions("text"), version: 2 },
    { ...inlineInstructions("text"), content: "tampered" },
    { ...inlineInstructions("text"), content: 42 },
    { ...inlineInstructions("text"), format: "html" },
  ]
  for (const [index, instructions] of invalid.entries()) {
    const runId = `invalid-inline-${index}`
    peer.send({ type: "task", runId, agent, context: {}, instructions })
    await waitUntil(() => peer.messages.some(message => message.type === "result" && message.runId === runId))
    const result = peer.messages.find(message => message.type === "result" && message.runId === runId)
    assert.equal(result.exitCode, 1)
    assert.match(result.error, /Invalid AgentPool inline instructions/)
    peer.send({ type: "ack", runId, seq: result.seq, completed: true })
    await waitUntil(() => peer.messages.filter(message => message.type === "ready").length === index + 2)
  }
  assert.equal(sessions, 0)
  assert.deepEqual(await fs.readdir(fixture.workspaceRoot), [])
})

test("separate workers can read the same configured shared folder without copying its contents", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-shared-test-"))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const workerShared = path.join(directory, "shared files")
  const sessions = []
  class Session extends EventEmitter {
    constructor(options) { super(); this.options = options; sessions.push(options) }
    async write() {
      assert.equal(await fs.readFile(path.join(this.options.env.WORKER_SHARED, "reference.txt"), "utf8"), "shared reference")
      await assert.rejects(fs.stat(path.join(this.options.cwd, "reference.txt")), { code: "ENOENT" })
      return { exitCode: 0 }
    }
    interrupt() {}
    dispose() {}
  }
  const first = await harness(t, (options) => new Session(options), { workerShared })
  await fs.writeFile(path.join(workerShared, "reference.txt"), "shared reference")
  const second = await harness(t, (options) => new Session(options), { workerShared })
  for (const fixture of [first, second]) {
    const peer = await fixture.welcome(0)
    peer.send({ type: "task", runId: "shared-read", agent, context: {} })
    await waitUntil(() => peer.messages.some(message => message.type === "result"))
    const result = peer.messages.find(message => message.type === "result")
    assert.equal(result.exitCode, 0, result.error)
  }
  assert.notEqual(sessions[0].cwd, sessions[1].cwd)
  for (const session of sessions) {
    assert.equal(session.env.WORKER_SHARED, await fs.realpath(workerShared))
    assert.ok(session.instructions.includes(await fs.realpath(workerShared)))
    assert.match(session.instructions, /Never create, edit, delete, rename, move, or change permissions/)
    assert.ok(!session.instructions.includes("shared reference"))
  }
})

for (const outputMode of ["normal", "verbose"]) {
  test(`${outputMode} worker output preserves summaries and errors with mode-specific raw tool output`, async (t) => {
    const raw = outputMode === "normal" ? "raw tool output\n".repeat(150_000) : "raw tool output\n"
    class Session extends EventEmitter {
      async write() {
        this.emit("output", { stream: "command", data: `\u001b[32m${raw}\u001b[0m` })
        this.emit("output", { stream: "stderr", data: "\u001b[31mA useful error\u001b[0m\n" })
        this.emit("output", { stream: "stdout", data: "\u001b[36mModel summary of results\u001b[0m\n" })
        return { exitCode: 0 }
      }
      interrupt() {}
      dispose() {}
    }
    const fixture = await harness(t, () => new Session(), { outputMode })
    const peer = await fixture.welcome(0)
    peer.send({ type: "task", runId: "output-mode", agent, context: {} })
    await waitUntil(() => peer.messages.some(message => message.type === "result"))
    const output = peer.messages.filter(message => message.type === "log").map(message => message.data).join("")
    assert.equal(output.includes("raw tool output"), outputMode === "verbose")
    assert.ok(output.includes("A useful error"))
    assert.ok(output.includes("Model summary of results"))
    assert.ok(!output.includes("\u001b"))
    assert.equal(peer.messages.find(message => message.type === "result").exitCode, 0)
  })
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
  const githubTokens = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]
  const inheritedEnv = Object.fromEntries(["FORCE_COLOR", "CLICOLOR_FORCE", ...githubTokens].map(key => [key, process.env[key]]))
  process.env.FORCE_COLOR = "1"
  process.env.CLICOLOR_FORCE = "1"
  for (const key of githubTokens) process.env[key] = "publisher-token-fixture"
  t.after(() => {
    for (const [key, value] of Object.entries(inheritedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
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
  assert.equal(options.env.NO_COLOR, "1")
  assert.equal(options.env.CLICOLOR, "0")
  assert.equal(options.env.FORCE_COLOR, undefined)
  assert.equal(options.env.CLICOLOR_FORCE, undefined)
  for (const key of githubTokens) assert.equal(options.env[key], undefined)
  assert.deepEqual(options.tools, [])
  assert.ok(options.instructions.includes(options.cwd))
  assert.match(options.instructions, /Read, search, and list files only inside your assigned workspace or the read-only shared folder/)
  assert.match(options.instructions, /Create and modify files only inside your assigned workspace/)
  assert.match(options.instructions, /Never search the machine for missing skills/)
  assert.match(options.instructions, /Do not scan ports, guess endpoints or authentication schemes/)
  assert.match(options.instructions, /authentication\/authorization failure, stop task execution/)
  assert.match(options.instructions, /"error":"<short failure reason>"/)
  assert.equal(JSON.parse(options.env.PAPERCLIP_RUNTIME_TOOLS_JSON).bearerToken, "tool-token-fixture")
  assert.equal(new URL(JSON.parse(options.env.PAPERCLIP_RUNTIME_TOOLS_JSON).mcpEndpoint).hostname, "127.0.0.1")
  assert.ok(!prompt.includes("run-jwt-fixture"))
  assert.ok(!prompt.includes("tool-token-fixture"))
  assert.ok(!prompt.includes("managed-mcp-token-fixture"))
  assert.ok(!prompt.includes("future-token-fixture"))
  assert.ok(!prompt.includes("publisher-token-fixture"))
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

test("workers load only workspace-root AGENTS.md and reread it for each assignment", async (t) => {
  const sessions = []
  class Session extends EventEmitter {
    async write() { return { exitCode: 0 } }
    interrupt() {}
    dispose() {}
  }
  const fixture = await harness(t, (options) => { sessions.push(options); return new Session() })
  await fs.writeFile(path.join(path.dirname(fixture.source), "AGENTS.md"), "Parent instructions must not be loaded.")
  await fs.writeFile(path.join(fixture.source, "AGENTS.md"), "Root instructions: preserve the assessment.")
  await fs.mkdir(path.join(fixture.source, "nested"))
  await fs.writeFile(path.join(fixture.source, "nested", "AGENTS.md"), "Nested instructions must not be loaded.")
  await fixture.git("add", "AGENTS.md", "nested/AGENTS.md")
  await fixture.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false",
    "commit", "-m", "Workspace instructions")
  await fs.writeFile(path.join(fixture.source, "AGENTS.md"), "Uncommitted source instructions must not be loaded.")
  const peer = await fixture.welcome(0)
  for (const runId of ["instructions-first", "instructions-second"]) {
    const readyCount = peer.messages.filter((message) => message.type === "ready").length
    peer.send({ type: "task", runId, agent, context: {} })
    await waitUntil(() => peer.messages.some((message) => message.type === "result" && message.runId === runId))
    const result = peer.messages.find((message) => message.type === "result" && message.runId === runId)
    assert.equal(result.exitCode, 0, result.error)
    assert.ok(peer.messages.some((message) => message.runId === runId && message.data?.includes("Loaded workspace instructions from AGENTS.md")))
    peer.send({ type: "ack", runId, seq: result.seq, completed: true })
    await waitUntil(() => peer.messages.filter((message) => message.type === "ready").length > readyCount)
    if (runId === "instructions-first") {
      await fs.writeFile(path.join(sessions[0].cwd, "AGENTS.md"), "Updated workspace instructions: read back the published document.")
    }
  }
  assert.equal(sessions.length, 2)
  assert.ok(sessions[0].instructions.includes("Root instructions: preserve the assessment."))
  assert.ok(!sessions[0].instructions.includes("Updated workspace instructions:"))
  assert.ok(sessions[1].instructions.includes("Updated workspace instructions: read back the published document."))
  assert.ok(!sessions[1].instructions.includes("Root instructions: preserve the assessment."))
  for (const { instructions } of sessions) {
    assert.ok(!instructions.includes("Parent instructions must not be loaded."))
    assert.ok(!instructions.includes("Nested instructions must not be loaded."))
    assert.ok(!instructions.includes("Uncommitted source instructions must not be loaded."))
    assert.match(instructions, /Worker workspace and failure rules take precedence over repository AGENTS.md/)
  }
})

test("an invalid workspace AGENTS.md fails before starting the model", async (t) => {
  let calls = 0
  const fixture = await harness(t, () => { calls++; throw new Error("Must not start a session") })
  const workspace = path.join(fixture.workspaceRoot, agent.id)
  await execFileAsync("git", ["clone", "--no-hardlinks", "--", fixture.source, workspace], { windowsHide: true })
  await fs.mkdir(path.join(workspace, "AGENTS.md"))
  const peer = await fixture.welcome(0)
  peer.send({ type: "task", runId: "invalid-instructions", agent, context: {} })
  await waitUntil(() => peer.messages.some((message) => message.type === "result"))
  const result = peer.messages.find((message) => message.type === "result")
  assert.equal(result.exitCode, 1)
  assert.match(result.error, /AGENTS.md must be a regular file/)
  assert.equal(calls, 0)
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
      ? 'Write-Output ("{0}[31mRAW_TOOL_SENTINEL{0}[0m" -f [char]27); Get-Location; Get-ChildItem -Name; git rev-parse --show-toplevel; Get-Content -LiteralPath (Join-Path $env:WORKER_SHARED \'shared.txt\')'
      : 'printf "\\033[31mRAW_TOOL_SENTINEL\\033[0m\\n"; pwd; ls; git rev-parse --show-toplevel; cat "$WORKER_SHARED/shared.txt"' },
    { type: "write", path: "tracked.txt", content: "agent-edit" },
    { type: "tool", name: "publish_pull_request", arguments: { commit: "a".repeat(40), title: "CI", body: "Validated" } },
    { type: "final", message: "Done" },
  ]
  const requests = []
  const issueId = "11111111-1111-4111-8111-111111111111"
  const products = [], comments = []
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const route = new URL(_url).pathname
    if (route.startsWith("/api/")) {
      assert.equal(init.headers.Authorization, "Bearer fixture-run-key")
      assert.equal(init.headers["X-Paperclip-Run-Id"], "real-tools")
      const body = init.body ? JSON.parse(init.body) : null
      let result
      if (route === `/api/issues/${issueId}`) result = { id: issueId, assigneeAgentId: agent.id }
      else if (route.endsWith("/work-products")) {
        if (body) products.push({ ...body, id: "product-1", issueId })
        result = body ? products.at(-1) : products
      } else if (route.endsWith("/comments")) {
        if (body) comments.push({ ...body, id: "comment-1", issueId, authorAgentId: agent.id })
        result = body ? comments.at(-1) : comments
      } else assert.fail(`Unexpected Paperclip route ${route}`)
      return Response.json(result)
    }
    requests.push(JSON.parse(init.body))
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(actions.shift()) } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })
  })
  let cwd, publication
  const fixture = await harness(t, (options) => { cwd = options.cwd; return new AgentSession(options) }, {
    githubRepo: "fixture-owner/repo", githubUser: "publisher-fixture",
    async publisherFactory(config) {
      assert.equal(config.repository, "fixture-owner/repo")
      assert.equal(config.githubUser, "publisher-fixture")
      return ({ workspace, agentId }) => ({
        name: "publish_pull_request", description: "Publish the committed revision", parameters: { type: "object" },
        async execute(args, { signal }) {
          publication = { workspace, agentId, args }
          assert.equal(signal.aborted, false)
          return { repository: "fixture-owner/repo", number: 1, state: "OPEN", commit: args.commit,
            branch: `minicode/${agentId}/${args.commit}`, url: "https://github.com/fixture-owner/repo/pull/1", worktreeRemoved: true }
        },
      })
    },
  })
  const shared = path.join(path.dirname(await fs.realpath(fixture.source)), "worker_shared")
  await fs.writeFile(path.join(shared, "shared.txt"), "SHARED_CONFIG_SENTINEL")
  await fs.writeFile(path.join(fixture.source, "AGENTS.md"), "Repository-specific rule: preserve existing assessment files.")
  await fixture.git("add", "AGENTS.md")
  await fixture.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false",
    "commit", "-m", "Workspace instructions")
  process.env.GIT_DIR = path.join(fixture.source, ".git")
  await fs.writeFile(path.join(fixture.source, "tracked.txt"), "source-edit")
  await fs.writeFile(path.join(fixture.source, "staged.txt"), "staged-only")
  await fixture.git("add", "staged.txt")
  await fs.writeFile(path.join(fixture.source, "local-only.txt"), "untracked")
  const sourceStatus = await fixture.git("status", "--porcelain")
  const peer = await fixture.welcome(0)
  peer.send({
    type: "task", runId: "real-tools", agent, authToken: "fixture-run-key",
    instructions: inlineInstructions("Inline rule: describe the evidence in your final response."),
    context: { issueId, paperclipWorkspace: { cwd: fixture.source } },
  })
  await waitUntil(() => peer.messages.some((message) => message.type === "result"))
  assert.equal(peer.messages.find((message) => message.type === "result").exitCode, 0)
  assert.equal(products.length, 1)
  assert.equal(comments.length, 1)
  assert.equal(products[0].type, "pull_request")
  assert.ok(comments[0].body.includes("https://github.com/fixture-owner/repo/pull/1"))
  assert.ok(requests.length > 0)
  assert.ok(requests.every((request) => request.messages[0].role === "system"
    && request.messages[0].content.includes("Repository-specific rule: preserve existing assessment files.")))
  assert.ok(requests.every(request => request.messages[0].content.includes("Inline rule: describe the evidence in your final response.")))
  assert.ok(requests[1].messages.at(-1).content.split("output:\n")[1].includes("RAW_TOOL_SENTINEL"))
  assert.ok(requests[1].messages.at(-1).content.includes("\u001b[31mRAW_TOOL_SENTINEL\u001b[0m"))
  assert.ok(requests[1].messages.at(-1).content.split("output:\n")[1].includes("SHARED_CONFIG_SENTINEL"))
  assert.equal(cwd, path.join(await fs.realpath(fixture.workspaceRoot), agent.id))
  assert.deepEqual(publication, { workspace: cwd, agentId: agent.id, args: { commit: "a".repeat(40), title: "CI", body: "Validated" } })
  assert.match(requests.at(-1).messages.at(-1).content, /https:\/\/github.com\/fixture-owner\/repo\/pull\/1/)
  const output = peer.messages.filter((message) => message.type === "log").map((message) => message.data).join("")
  assert.ok(output.includes(cwd))
  assert.ok(output.includes("tracked.txt"))
  assert.ok(!output.includes("\r\nRAW_TOOL_SENTINEL\r\n"))
  assert.ok(!output.includes("SHARED_CONFIG_SENTINEL"))
  assert.ok(!output.includes("\u001b"))
  assert.ok(requests.every(request => request.messages[0].content.includes(shared)))
  assert.equal(await fs.readFile(path.join(shared, "shared.txt"), "utf8"), "SHARED_CONFIG_SENTINEL")
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

test("worker startup rejects overlapping shared folders, including directory links, before creating shared files", async (t) => {
  const fixture = await harness(t, () => { throw new Error("Must not start a session") })
  const options = {
    server: "http://127.0.0.1:1", workerId: randomUUID(), cwd: fixture.source,
    clientToken: "a".repeat(64), workspaceRoot: fixture.workspaceRoot,
  }
  for (const workerShared of [
    fixture.source, path.dirname(fixture.source), path.join(fixture.source, "shared"),
    fixture.workspaceRoot, path.join(fixture.workspaceRoot, "shared"),
  ]) {
    await assert.rejects(startAgentPoolWorker({ ...options, workerShared }), /--worker-shared must not overlap/)
  }
  const sourceLink = path.join(path.dirname(fixture.source), "source-link")
  await fs.symlink(fixture.source, sourceLink, process.platform === "win32" ? "junction" : "dir")
  for (const workerShared of [sourceLink, path.join(sourceLink, "shared")]) {
    await assert.rejects(startAgentPoolWorker({ ...options, workerShared }), /--worker-shared must not overlap/)
  }
  await assert.rejects(fs.stat(path.join(fixture.source, "shared")), { code: "ENOENT" })
  await assert.rejects(fs.stat(path.join(fixture.workspaceRoot, "shared")), { code: "ENOENT" })
  await assert.rejects(startAgentPoolWorker({
    ...options, workerShared: path.join(path.dirname(fixture.source), "missing-parent", "shared"),
  }), { code: "ENOENT" })
  const notDirectory = path.join(path.dirname(fixture.source), "not-a-directory")
  await fs.writeFile(notDirectory, "keep")
  await assert.rejects(startAgentPoolWorker({ ...options, workerShared: notDirectory }), /EEXIST|ENOTDIR/)
  assert.equal(await fs.readFile(notDirectory, "utf8"), "keep")
})
