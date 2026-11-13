import assert from "node:assert/strict"
import childProcess from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { shouldWake, startCoordinator } from "../server/coordinator.js"
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

test("coordinator joins, ignores history, runs the harness for a new engineer message and posts its response", async () => {
  const posted = []
  let snapshots = 0
  let stopped = false
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
    if (route.includes("/heartbeat")) return Response.json({ coordinatorId: "coordinator-id" })
    return new Response("not found", { status: 404 })
  }
  const prompts = []
  const coordinator = await startCoordinator({
    server: "https://engsys.example.test", cwd: process.cwd(), instanceKey: "test",
    harness: "minicode", machineName: "devbox", pollMs: 5, heartbeatMs: 1000,
    fetchImpl, tokenProvider: Object.assign(async () => token(), { invalidate() {} }),
    harnessFactory: async () => ({
      async run(prompt) { prompts.push(prompt); return { exitCode: 0, summary: "I will fix it." } },
      async stop() { stopped = true },
    }),
    log: () => {},
  })
  await waitUntil(() => posted.length === 1)
  await coordinator.stop()
  assert.equal(prompts.length, 1)
  assert.match(prompts[0], /fix the worker/)
  assert.equal(posted[0].text, "I will fix it.")
  assert.match(posted[0].coordinatorId, /^[a-f0-9]{64}$/)
  assert.equal(stopped, true)
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
  assert.equal(shouldWake({ senderId: "coordinator", senderKind: 1, text: "@build echo" }, member), false)
  assert.equal(shouldWake({ senderId: "system", senderKind: 2, text: "@all notice" }, member), false)
})

test("coordinator releases its harness when the initial room snapshot fails", async () => {
  let stopped = false
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
    harnessFactory: async () => ({
      async run() { return { exitCode: 0, summary: "" } },
      async stop() { stopped = true },
    }),
    log: () => {},
  }), /HTTP 503/)
  assert.equal(stopped, true)
})

test("one coordinator is elected per machine and a standby takes over", async t => {
  const leaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-coordinator-lease-test-"))
  t.after(() => fs.rm(leaseDir, { recursive: true, force: true }))
  const coordinatorIds = []
  let harnessStarts = 0
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
    return new Response("not found", { status: 404 })
  }
  const options = {
    server: "https://singleton.engsys.example.test", cwd: process.cwd(),
    harness: "minicode", machineName: "devbox", pollMs: 50, heartbeatMs: 1000,
    leaseDir, leasePollMs: 5, leaseSettleMs: 1, fetchImpl,
    tokenProvider: Object.assign(async () => token(), { invalidate() {} }),
    harnessFactory: async () => {
      harnessStarts++
      return {
        async run() { return { exitCode: 0, summary: "" } },
        async stop() {},
      }
    },
    log: () => {},
  }
  const first = await startCoordinator({ ...options, instanceKey: "worker:first" })
  const second = await startCoordinator({ ...options, instanceKey: "worker:second" })
  t.after(() => first.stop())
  t.after(() => second.stop())
  assert.equal(harnessStarts, 1)
  assert.equal(coordinatorIds.length, 1)

  await first.stop()
  await waitUntil(() => coordinatorIds.length === 2)
  assert.equal(harnessStarts, 2)
  assert.equal(coordinatorIds[1], coordinatorIds[0])
  await second.stop()
})

test("workers.yml accepts one launcher coordinator and validates its harness", () => {
  const config = parseWorkersYaml(`
version: 1
coordinatorServer: https://engsys.example.test
coordinatorAlias: build
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
    "--coordinator-harness", "minicode",
    "--coordinator-azure-config-dir", "C:\\Users\\me\\.azure",
  ])
  assert.equal(parsed.options["coordinator-server"], "https://engsys.example.test")
  assert.equal(parsed.options["coordinator-alias"], "build")
  assert.equal(parsed.options["coordinator-harness"], "minicode")
})

test("coordinator repairs use an isolated approved worktree and leave the source checkout unchanged", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-coordinator-test-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const source = path.join(root, "academy")
  await fs.mkdir(source)
  const git = args => childProcess.execFileSync("git", args, { cwd: source, encoding: "utf8", windowsHide: true }).trim()
  git(["init", "-b", "dev"])
  git(["config", "user.name", "Coordinator Test"])
  git(["config", "user.email", "coordinator@example.test"])
  git(["remote", "add", "origin", "https://github.com/example/academy.git"])
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
  await assert.rejects(() => tools.run_coordinator_command.execute(
    { command: "git push origin HEAD" }, { signal: AbortSignal.timeout(5000) }),
  /Direct remote mutation is disabled/)
  const state = await tools.repository_state.execute({ repository: "academy" }, { signal: AbortSignal.timeout(5000) })
  assert.match(state.log, /initial/)
  const created = await tools.create_repair_workspace.execute(
    { repository: "academy", title: "fix value" }, { signal: AbortSignal.timeout(5000) })
  await assert.rejects(() => tools.run_repair_command.execute(
    { repairId: created.repairId, command: "git push origin HEAD" }, { signal: AbortSignal.timeout(5000) }),
  /Direct remote mutation is disabled/)
  await tools.edit_repair_file.execute({
    repairId: created.repairId, path: "value.txt", find: "source\n", replace: "fixed\n",
  }, { signal: AbortSignal.timeout(5000) })
  const committed = await tools.commit_repair.execute(
    { repairId: created.repairId, message: "Fix value" }, { signal: AbortSignal.timeout(5000) })
  assert.match(committed.commit, /^[a-f0-9]{40}$/)
  assert.equal(await fs.readFile(path.join(source, "value.txt"), "utf8"), "source\n")
  assert.equal(git(["status", "--porcelain"]), "")
  await assert.rejects(() => tools.create_repair_workspace.execute(
    { repository: "monolith", title: "not allowed" }, { signal: AbortSignal.timeout(5000) }),
  /not approved/)
})
