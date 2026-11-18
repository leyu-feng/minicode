import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { createCoordinatorFrontend, selectCoordinatorFrontend } from "../server/coordinator-frontend.js"

const frontend = (overrides = {}) => ({
  pane_id: "w1:p1", workspace_id: "w1", terminal_id: "frontend", name: "operator",
  agent: "copilot", agent_status: "idle", agent_session: { source: "copilot", value: "session" }, ...overrides,
})

async function fixture(t) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-frontend-test-"))
  t.after(() => fs.rm(storageRoot, { recursive: true, force: true }))
  const calls = []
  const requests = []
  const worker = frontend({ pane_id: "w1:p2", terminal_id: "worker", agent: "minicode" })
  let agents = [frontend(), worker]
  let deliveryError = false
  const options = {
    coordinatorId: "coordinator", storageRoot,
    env: { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_PANE_ID: "w1:p2" },
    run: async args => {
      calls.push(args)
      if (args[1] === "list") return { result: { agents } }
      assert.deepEqual(args.slice(0, 3), ["agent", "prompt", "w1:p1"])
      const requestFile = JSON.parse(args[3].match(/ in (".*")\. Follow/)[1])
      const prompt = await fs.readFile(requestFile, "utf8")
      const replyFile = JSON.parse(prompt.match(/JSON file at (".*")\./)[1])
      const { requestId } = JSON.parse(prompt.match(/schema is (\{.*\})\./)[1])
      requests.push({ prompt, replyFile, requestId, requestFile })
      if (deliveryError) throw new Error("timeout")
      return { result: { agent: agents.find(agent => agent.pane_id === args[2]) } }
    },
  }
  return {
    options, calls, requests,
    set agents(value) { agents = [...value, worker] },
    set deliveryError(value) { deliveryError = value },
    async reply(index, text) {
      await fs.writeFile(requests[index].replyFile, JSON.stringify({ requestId: requests[index].requestId, text }))
    },
  }
}

const request = (messageId, prompt = "Inspect the worker.") => ({
  messageId, prompt, audience: { audienceAll: false, audienceCoordinatorIds: ["coordinator"] },
})

test("frontend selection is workspace scoped, excludes workers, and refuses ambiguity", () => {
  const candidates = [
    frontend({ pane_id: "w1:p2" }),
    frontend({ pane_id: "w1:p3", agent: "minicode" }),
    frontend({ pane_id: "w1:p4", tokens: { "minicode-role": "worker" } }),
    frontend({ pane_id: "w1:p5", agent_session: { source: "minicode-worker" } }),
    frontend({ workspace_id: "w2", pane_id: "w2:p1" }), frontend(),
  ]
  const binding = { workspaceId: "w1", ownPane: "w1:p2" }
  assert.equal(selectCoordinatorFrontend(candidates, binding).pane_id, "w1:p1")
  const ambiguous = [...candidates, frontend({ pane_id: "w1:p6", name: "other" })]
  assert.throws(() => selectCoordinatorFrontend(ambiguous, binding), /Multiple frontends/)
  assert.equal(selectCoordinatorFrontend(ambiguous, { ...binding, target: "w1:p1" }).pane_id, "w1:p1")
  assert.throws(() => selectCoordinatorFrontend(candidates, { ...binding, target: "w2:p1" }), /No matching/)
  assert.throws(() => selectCoordinatorFrontend(candidates, { ...binding, target: "w1:p4" }), /No matching/)
  assert.throws(() => selectCoordinatorFrontend(candidates), /No Herdr workspace binding/)
  assert.equal(selectCoordinatorFrontend([frontend()], { target: "operator" }).pane_id, "w1:p1")
})

test("relay mirrors frontend work without messages and queues FIFO without interrupting busy work", async t => {
  const f = await fixture(t)
  const relay = await createCoordinatorFrontend(f.options)
  f.agents = [frontend({ agent_status: "working" })]
  assert.deepEqual(await relay.poll(), { busy: true, isTyping: true, reply: null, problem: null })
  const longPrompt = "a".repeat(50_000)
  await relay.enqueue(request("first", longPrompt))
  await relay.enqueue(request("second"))
  await relay.enqueue(request("first"))
  await relay.poll()
  assert.equal(f.requests.length, 0)
  for (const state of [{ agent_status: "blocked" }, { agent_status: "unknown" }, { launch_pending: true }]) {
    f.agents = [frontend(state)]
    const status = await relay.poll()
    assert.equal(status.busy, true)
    assert.match(status.problem, /waiting without sending input/)
    assert.equal(f.requests.length, 0)
  }
  f.agents = [frontend({ agent_status: "done" })]
  await relay.poll()
  assert.equal(f.requests.length, 1)
  assert.ok(f.requests[0].prompt.endsWith(longPrompt))
  assert.ok(f.calls.find(args => args[1] === "prompt")[3].length < 2000)
  const awaiting = await relay.poll()
  assert.equal(awaiting.reply, null)
  assert.equal(awaiting.busy, true)
  assert.equal(f.requests.length, 1)
  await f.reply(0, "  Exact frontend response.\n")
  f.agents = [frontend({ agent_status: "working" })]
  const ready = await relay.poll()
  assert.equal(ready.busy, true)
  assert.equal(ready.isTyping, true)
  assert.equal(ready.reply.text, "  Exact frontend response.\n")
  assert.deepEqual(ready.reply.audience, request("first").audience)
  await relay.markPosting(ready.reply.id)
  await relay.acknowledge(ready.reply.id)
  await relay.enqueue(request("first"))
  await relay.poll()
  assert.equal(f.requests.length, 1)
  f.agents = [frontend({ agent_status: "done" })]
  await relay.poll()
  assert.equal(f.requests.length, 2)
  assert.ok(f.requests[1].prompt.endsWith("Inspect the worker."))
  await assert.rejects(fs.stat(f.requests[0].requestFile), { code: "ENOENT" })
  assert.ok(f.calls.every(args => args[1] === "list" || args[1] === "prompt"))
})

test("missing and ambiguous frontends remain busy without executing or losing queued requests", async t => {
  const f = await fixture(t)
  const relay = await createCoordinatorFrontend(f.options)
  await relay.enqueue(request("queued"))
  f.agents = []
  assert.match((await relay.poll()).problem, /No matching/)
  f.agents = [frontend(), frontend({ pane_id: "w1:p3", name: "other" })]
  const ambiguous = await relay.poll()
  assert.equal(ambiguous.busy, true)
  assert.match(ambiguous.problem, /Multiple frontends/)
  assert.equal(f.requests.length, 0)
  const bound = await createCoordinatorFrontend({ ...f.options, frontendTarget: "w1:p1" })
  await bound.poll()
  assert.equal(f.requests.length, 1)
})

test("relay validates correlation and complete reply content instead of treating idle as an answer", async t => {
  const f = await fixture(t)
  const relay = await createCoordinatorFrontend(f.options)
  await relay.enqueue(request("validate"))
  await relay.poll()
  const replyFile = f.requests[0].replyFile
  for (const body of ["unfinished JSON", JSON.stringify({ requestId: "wrong", text: "not this request" }),
    JSON.stringify({ requestId: f.requests[0].requestId, text: "a".repeat(8001) })]) {
    await fs.writeFile(replyFile, body)
    const invalid = await relay.poll()
    assert.equal(invalid.reply, null)
    assert.match(invalid.problem, /Invalid frontend reply/)
    assert.equal(f.requests.length, 1)
  }
  await f.reply(0, "[NO_REPLY]")
  const quiet = await relay.poll()
  assert.equal(quiet.reply.text, "[NO_REPLY]")
  await relay.acknowledge(quiet.reply.id)
  assert.deepEqual(await relay.poll(), { busy: false, isTyping: false, reply: null, problem: null })
})

test("takeover preserves queued requests and never replays uncertain delivery or room posting", async t => {
  const f = await fixture(t)
  let relay = await createCoordinatorFrontend(f.options)
  await relay.enqueue(request("pending"))
  relay = await createCoordinatorFrontend(f.options)
  f.deliveryError = true
  assert.match((await relay.poll()).problem, /uncertain; not resubmitting/)
  assert.equal(f.requests.length, 1)
  relay = await createCoordinatorFrontend(f.options)
  assert.match((await relay.poll()).problem, /uncertain; not resubmitting/)
  assert.equal(f.requests.length, 1)
  await f.reply(0, "Completed exactly once.")
  const ready = await relay.poll()
  assert.equal(ready.reply.text, "Completed exactly once.")
  await relay.markPosting(ready.reply.id)
  relay = await createCoordinatorFrontend(f.options)
  const uncertain = await relay.poll()
  assert.equal(uncertain.reply, null)
  assert.match(uncertain.problem, /Room reply outcome.*uncertain/)
  assert.equal(f.requests.length, 1)
})

test("a replacement frontend does not receive an in-flight request a second time", async t => {
  const f = await fixture(t)
  const relay = await createCoordinatorFrontend(f.options)
  await relay.enqueue(request("original"))
  await relay.poll()
  f.agents = [frontend({ terminal_id: "replacement" })]
  const changed = await relay.poll()
  assert.equal(changed.busy, true)
  assert.match(changed.problem, /changed or disconnected/)
  assert.equal(f.requests.length, 1)
})

test("relay resolves a moved pane's current workspace and excludes its canonical own pane", async t => {
  const f = await fixture(t)
  f.agents = [frontend({ workspace_id: "w2", pane_id: "w2:p1" }),
    frontend({ workspace_id: "w2", pane_id: "w2:p2", terminal_id: "moved-worker" })]
  const run = f.options.run
  f.options.env = { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_PANE_ID: "w1:p9" }
  f.options.run = async args => {
    if (args[0] !== "pane") return run(args)
    assert.deepEqual(args, ["pane", "get", "w1:p9"])
    return { result: { pane: { workspace_id: "w2", pane_id: "w2:p2" } } }
  }
  const relay = await createCoordinatorFrontend(f.options)
  assert.deepEqual(await relay.poll(), { busy: false, isTyping: false, reply: null, problem: null })
})
