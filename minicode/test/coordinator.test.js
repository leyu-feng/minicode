import assert from "node:assert/strict"
import childProcess from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  coordinatorMessagePrompt,
  shouldWake,
  startCoordinator,
  updateCommandTarget,
} from "../server/coordinator.js"
import { createCoordinatorTools } from "../server/coordinator-tools.js"
import { parseWorkerCliOptions } from "../server/agent-pool-worker.js"
import { parseWorkersYaml } from "../server/workers-mode.js"

function token() {
  const claims = Buffer.from(JSON.stringify({ tid: "tenant", oid: "caller" })).toString("base64url")
  return `header.${claims}.signature`
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for coordinator")
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test("coordinator relays verbatim frontend replies and mirrors frontend presence without running a harness", async t => {
  const posted = []
  const presence = []
  const logs = []
  let snapshots = 0
  let frontendBusy = true
  let reply = null
  let heartbeatCount = 0
  const historical = { id: "old", senderId: "engineer", senderName: "Engineer", senderKind: 0, text: "old", at: "2026-01-01" }
  const incoming = { id: "new", senderId: "engineer", senderName: "Engineer", senderKind: 0, text: "@devbox fix the worker", at: "2026-01-02" }
  const fetchImpl = async (url, options = {}) => {
    const route = new URL(url).pathname
    if (route.endsWith("/join")) return Response.json({
      member: { coordinatorId: "coordinator-id", alias: "devbox", name: "devbox", machineName: "devbox" },
      repositories: [{ name: "repo", source: "https://example.test/repo", branch: "main", readOnly: true }],
    })
    if (route.endsWith("/default") && !options.method) {
      snapshots++
      return Response.json({ room: {}, members: [], messages: snapshots === 1 ? [historical] : [historical, incoming] })
    }
    if (route.endsWith("/messages")) {
      posted.push(JSON.parse(options.body))
      return Response.json({ id: "response" })
    }
    if (route.endsWith("/presence")) {
      const update = JSON.parse(options.body)
      presence.push(update)
      return Response.json({
        coordinatorId: "coordinator-id", alias: "devbox", name: "devbox",
        machineName: "devbox", ...update,
      })
    }
    if (route.includes("/heartbeat")) {
      heartbeatCount++
      return Response.json({ coordinatorId: "coordinator-id" })
    }
    return new Response("not found", { status: 404 })
  }
  const queued = []
  const acknowledged = []
  const posting = []
  const coordinator = await startCoordinator({
    server: "https://engsys.example.test", cwd: process.cwd(), instanceKey: "test",
    harness: "copilotcli", copilotPath: process.execPath,
    machineName: "devbox", pollMs: 5, heartbeatMs: 5,
    fetchImpl, tokenProvider: Object.assign(async () => token(), { invalidate() {} }),
    harnessFactory: () => { throw new Error("An independent coordinator harness must never start") },
    frontendFactory: async () => ({
      async enqueue(request) { queued.push(request) },
      async poll() { return { busy: frontendBusy, isTyping: frontendBusy, reply, problem: null } },
      async markPosting(id) { posting.push(id) },
      async acknowledge(id) { acknowledged.push(id); reply = null },
    }),
    busyKeepaliveMs: 5, log: message => logs.push(message),
  })
  t.after(() => coordinator.stop())
  await waitUntil(() => presence.length >= 2 && heartbeatCount >= 2)
  assert.equal(queued.length, 1)
  assert.match(queued[0].prompt, /fix the worker/)
  assert.doesNotMatch(queued[0].prompt, /New coordinator-room message from Engineer:\nold/)
  assert.ok(presence.every(update => update.state === 1 && update.isTyping))
  assert.equal(posted.length, 1)
  reply = { id: "request", text: "  I will fix it.\n", audience: queued[0].audience }
  await waitUntil(() => posted.length === 2)
  frontendBusy = false
  await waitUntil(() => presence.some(update => update.state === 0))
  await coordinator.stop()
  assert.equal(posted[0].text, "Queued for @devbox's frontend.")
  assert.equal(posted[0].hidden, true)
  assert.deepEqual(posted[0].audienceCoordinatorIds, ["coordinator-id"])
  assert.equal(posted[1].text, "  I will fix it.\n")
  assert.deepEqual(posted[1].audienceCoordinatorIds, ["coordinator-id"])
  assert.match(posted[1].coordinatorId, /^[a-f0-9]{64}$/)
  assert.deepEqual(acknowledged, ["request"])
  assert.deepEqual(posting, ["request"])
  assert.deepEqual(presence.at(-1), { state: 0, isTyping: false })
  assert.ok(logs.includes("[coordinator:devbox] frontend response posted"))
})

test("coordinator can end an acknowledgment exchange without posting another reply", async t => {
  const posted = []
  const presence = []
  const logs = []
  let snapshots = 0
  let pending = null
  let acknowledged = false
  const incoming = {
    id: "ack", senderId: "other", senderName: "shanghai", senderKind: 1,
    text: "@devbox acknowledged, thanks.",
  }
  const fetchImpl = async (url, options = {}) => {
    const route = new URL(url).pathname
    if (route.endsWith("/join")) return Response.json({
      member: { coordinatorId: "coordinator-id", alias: "devbox", name: "devbox" },
      repositories: [],
    })
    if (route.endsWith("/default") && !options.method) {
      return Response.json({ members: [], messages: ++snapshots === 1 ? [] : [incoming] })
    }
    if (route.endsWith("/messages")) {
      posted.push(JSON.parse(options.body))
      return Response.json({ id: "response" })
    }
    if (route.endsWith("/presence")) {
      const update = JSON.parse(options.body)
      presence.push(update)
      return Response.json({ coordinatorId: "coordinator-id", alias: "devbox", name: "devbox", ...update })
    }
    if (route.endsWith("/heartbeat")) return Response.json({ coordinatorId: "coordinator-id" })
    return new Response("not found", { status: 404 })
  }
  const coordinator = await startCoordinator({
    server: "https://engsys.example.test", cwd: process.cwd(), instanceKey: "no-reply-test",
    machineName: "devbox", pollMs: 5, heartbeatMs: 1000, fetchImpl,
    tokenProvider: Object.assign(async () => token(), { invalidate() {} }),
    frontendFactory: async () => ({
      async enqueue(request) { pending = request },
      async poll() {
        return { busy: Boolean(pending), isTyping: false, problem: null,
          reply: pending ? { id: "request", text: "\n[NO_REPLY]\n", audience: pending.audience } : null }
      },
      async acknowledge() { acknowledged = true; pending = null },
    }),
    log: message => logs.push(message),
  })
  t.after(() => coordinator.stop())
  await waitUntil(() => presence.some(update => update.state === 0))
  await coordinator.stop()
  assert.equal(acknowledged, true)
  assert.equal(posted.length, 1)
  assert.equal(posted[0].hidden, true)
  assert.ok(logs.includes("[coordinator:devbox] frontend requested no reply"))
})

test("coordinator wakes only for its alias or all", () => {
  const member = {
    coordinatorId: "coordinator",
    alias: "build",
    name: "build(devbox)",
  }
  assert.equal(shouldWake({ senderId: "engineer", senderKind: 0, text: "please investigate" }, member), false)
  assert.equal(shouldWake({ senderId: "engineer", senderKind: 0, text: "@other investigate" }, member), false)
  assert.equal(shouldWake({ senderId: "engineer", senderKind: 0, text: "@build investigate" }, member), true)
  assert.equal(shouldWake({ senderId: "other", senderKind: 1, text: "@all status" }, member), true)
  assert.equal(shouldWake({
    senderId: "engineer",
    senderKind: 0,
    text: "investigate",
    audienceCoordinatorIds: ["coordinator"],
  }, member), true)
  assert.equal(shouldWake({
    senderId: "engineer",
    senderKind: 0,
    text: "@build investigate",
    audienceCoordinatorIds: ["other"],
  }, member), false)
  assert.equal(shouldWake({
    senderId: "engineer",
    senderKind: 0,
    text: "status",
    audienceAll: true,
  }, member), true)
  assert.equal(shouldWake({
    senderId: "other",
    senderKind: 1,
    text: "response",
    audienceAll: true,
  }, member), false)
  assert.equal(shouldWake({
    senderId: "engineer",
    senderKind: 0,
    text: "/alias @build @fixer",
    audienceAll: true,
  }, member), false)
  assert.equal(shouldWake({
    senderId: "engineer",
    senderKind: 0,
    text: "/update @build",
    audienceAll: true,
  }, member), true)
  assert.equal(shouldWake({
    senderId: "engineer",
    senderKind: 0,
    text: "/update @other",
    audienceAll: true,
  }, member), false)
  assert.equal(updateCommandTarget({
    senderKind: 0,
    text: "/update @ALL",
  }), "all")
  assert.match(coordinatorMessagePrompt(
    {
      senderKind: 0,
      senderName: "Engineer",
      text: "/update @build",
      at: "2026-01-02",
    },
    member,
    { messages: [] },
  ), /fast-forward only if clean and non-diverged/)
  assert.equal(shouldWake({ senderId: "coordinator", senderKind: 1, text: "@build echo" }, member), false)
  assert.equal(shouldWake({ senderId: "system", senderKind: 2, text: "@all notice" }, member), false)
})

test("coordinator does not poll the frontend when the initial room snapshot fails", async () => {
  let polled = false
  const fetchImpl = async (url) => {
    const route = new URL(url).pathname
    if (route.endsWith("/join")) return Response.json({
      member: { coordinatorId: "coordinator-id", name: "devbox", machineName: "devbox" },
      repositories: [],
    })
    return new Response("room unavailable", { status: 503 })
  }
  await assert.rejects(() => startCoordinator({
    server: "https://engsys.example.test", cwd: process.cwd(), instanceKey: "test",
    harness: "minicode", fetchImpl,
    tokenProvider: Object.assign(async () => token(), { invalidate() {} }),
    frontendFactory: async () => ({ async poll() { polled = true } }),
    log: () => {},
  }), /HTTP 503/)
  assert.equal(polled, false)
})

test("one coordinator is elected per machine and a standby takes over", async t => {
  const leaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-coordinator-lease-test-"))
  t.after(() => fs.rm(leaseDir, { recursive: true, force: true }))
  const coordinatorIds = []
  let frontendStarts = 0
  const fetchImpl = async (url, options = {}) => {
    const route = new URL(url).pathname
    if (route.endsWith("/join")) {
      const request = JSON.parse(options.body)
      coordinatorIds.push(request.coordinatorId)
      return Response.json({
        member: { coordinatorId: request.coordinatorId, name: "devbox", machineName: "devbox" },
        repositories: [],
      })
    }
    if (route.endsWith("/default") && !options.method) {
      return Response.json({ room: {}, members: [], messages: [] })
    }
    if (route.includes("/heartbeat")) return Response.json({ coordinatorId: coordinatorIds.at(-1) })
    if (route.endsWith("/presence")) return Response.json({ coordinatorId: coordinatorIds.at(-1) })
    return new Response("not found", { status: 404 })
  }
  const options = {
    server: "https://singleton.engsys.example.test", cwd: process.cwd(),
    harness: "minicode", machineName: "devbox", pollMs: 50, heartbeatMs: 1000,
    leaseDir, leasePollMs: 5, leaseSettleMs: 1, fetchImpl,
    tokenProvider: Object.assign(async () => token(), { invalidate() {} }),
    frontendFactory: async () => {
      frontendStarts++
      return {
        async poll() { return { busy: false, isTyping: false, reply: null, problem: null } },
      }
    },
    log: () => {},
  }
  const first = await startCoordinator({ ...options, instanceKey: "worker:first" })
  const second = await startCoordinator({ ...options, instanceKey: "worker:second" })
  t.after(() => first.stop())
  t.after(() => second.stop())
  assert.equal(frontendStarts, 1)
  assert.equal(coordinatorIds.length, 1)

  await first.stop()
  await waitUntil(() => coordinatorIds.length === 2)
  assert.equal(frontendStarts, 2)
  assert.equal(coordinatorIds[1], coordinatorIds[0])
  await second.stop()
})

test("workers.yml accepts a frontend binding and retains legacy coordinator settings", () => {
  const config = parseWorkersYaml(`
version: 1
coordinatorServer: https://engsys.example.test
coordinatorAlias: build
coordinatorFrontend: operator
coordinatorHarness: minicode
coordinatorAzureConfigDir: C:\\Users\\me\\.azure
workers:
  - name: worker
    server: https://paperclip.example.test
    workerId: 00000000-0000-0000-0000-000000000000
    repoRoot: .
`)
  assert.equal(config.coordinatorServer, "https://engsys.example.test")
  assert.equal(config.coordinatorAlias, "build")
  assert.equal(config.coordinatorFrontend, "operator")
  assert.equal(config.coordinatorHarness, "minicode")
  assert.throws(() => parseWorkersYaml(`
version: 1
coordinatorHarness: copilotcli
workers:
  - name: worker
    server: https://paperclip.example.test
    workerId: 00000000-0000-0000-0000-000000000000
    repoRoot: .
`), /require coordinatorServer/)
})

test("direct worker accepts launcher coordinator options", () => {
  const parsed = parseWorkerCliOptions([
    "--server", "https://paperclip.example.test",
    "--coordinator-server", "https://engsys.example.test",
    "--coordinator-alias", "build",
    "--coordinator-frontend", "operator",
    "--coordinator-harness", "minicode",
    "--coordinator-azure-config-dir", "C:\\Users\\me\\.azure",
  ])
  assert.equal(parsed.options["coordinator-server"], "https://engsys.example.test")
  assert.equal(parsed.options["coordinator-alias"], "build")
  assert.equal(parsed.options["coordinator-frontend"], "operator")
  assert.equal(parsed.options["coordinator-harness"], "minicode")
  assert.throws(() => parseWorkerCliOptions(["--coordinator-frontend", "operator"]), /requires --coordinator-server/)
})

test("coordinator repairs any workspace repository and can push an explicitly requested branch", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-coordinator-test-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const source = path.join(root, "monolith")
  const remote = path.join(root, "remote.git")
  await fs.mkdir(source)
  const occupiedSibling = path.join(root, "monolith-01")
  await fs.mkdir(occupiedSibling)
  await fs.writeFile(path.join(occupiedSibling, "owner.txt"), "other worker\n")
  childProcess.execFileSync("git", ["init", "--bare", remote], { encoding: "utf8", windowsHide: true })
  const git = args => childProcess.execFileSync("git", args, { cwd: source, encoding: "utf8", windowsHide: true }).trim()
  git(["init", "-b", "dev"])
  git(["config", "user.name", "Coordinator Test"])
  git(["config", "user.email", "coordinator@example.test"])
  git(["remote", "add", "origin", remote])
  await fs.writeFile(path.join(source, "value.txt"), "source\n")
  git(["add", "value.txt"])
  git(["commit", "-m", "initial"])
  const coordinator = await createCoordinatorTools({
    root, member: { name: "devbox" }, log: () => {},
  })
  t.after(() => coordinator.stop())
  const tools = Object.fromEntries(coordinator.tools.map(tool => [tool.name, tool]))
  const command = await tools.run_coordinator_command.execute(
    { command: process.platform === "win32" ? "Write-Output local-ok" : "printf local-ok" },
    { signal: AbortSignal.timeout(5000) })
  assert.equal(command, "local-ok")
  await tools.run_coordinator_command.execute(
    { command: `git -C "${source}" push origin HEAD:refs/heads/dev` },
    { signal: AbortSignal.timeout(5000) })
  await assert.rejects(() => tools.run_coordinator_command.execute(
    { command: `git -C "${source}" push --force origin HEAD:refs/heads/dev` },
    { signal: AbortSignal.timeout(5000) }),
  /Destructive remote mutation is disabled/)
  await assert.rejects(() => tools.run_coordinator_command.execute(
    { command: `git -C "${source}" push origin :refs/heads/dev` },
    { signal: AbortSignal.timeout(5000) }),
  /Destructive remote mutation is disabled/)
  const state = await tools.repository_state.execute({ repository: "monolith" }, { signal: AbortSignal.timeout(5000) })
  assert.match(state.log, /initial/)
  const created = await tools.create_repair_workspace.execute(
    { repository: "monolith", title: "fix value" }, { signal: AbortSignal.timeout(5000) })
  assert.equal(created.workspace, path.join(root, "monolith-02"))
  assert.equal(await fs.readFile(path.join(occupiedSibling, "owner.txt"), "utf8"), "other worker\n")
  await tools.edit_repair_file.execute({
    repairId: created.repairId, path: "value.txt", find: "source\n", replace: "fixed\n",
  }, { signal: AbortSignal.timeout(5000) })
  const committed = await tools.commit_repair.execute(
    { repairId: created.repairId, message: "Fix value" }, { signal: AbortSignal.timeout(5000) })
  await tools.run_repair_command.execute(
    { repairId: created.repairId, command: "git push origin HEAD:refs/heads/conflict-fix" },
    { signal: AbortSignal.timeout(5000) })
  assert.match(committed.commit, /^[a-f0-9]{40}$/)
  const remoteCommit = childProcess.execFileSync(
    "git", ["--git-dir", remote, "rev-parse", "refs/heads/conflict-fix"],
    { encoding: "utf8", windowsHide: true }).trim()
  assert.equal(remoteCommit, committed.commit)
  assert.equal(await fs.readFile(path.join(source, "value.txt"), "utf8"), "source\n")
  assert.equal(git(["status", "--porcelain"]), "")
})
