import assert from "node:assert/strict"
import { randomUUID, createHash } from "node:crypto"
import test from "node:test"
import { hostedBindingToken, startHostedFleet } from "../server/hosted-fleet.js"

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function binding() {
  return { workerId: randomUUID(), poolId: randomUUID(), companyId: randomUUID(), generation: randomUUID() }
}

async function harness(bindings, request) {
  const peers = []
  const fleet = await startHostedFleet({
    bindings, request,
    async startWorker(value, state) {
      const done = deferred()
      const peer = { binding: value, state, done, stopped: false,
        worker: { finished: done.promise, async stop() { peer.stopped = true; done.resolve(null) } } }
      peers.push(peer)
      return peer.worker
    },
  })
  return { fleet, peers }
}

test("binding credentials change on slot generation and match the provider's SHA256 input", () => {
  const value = binding()
  assert.equal(hostedBindingToken("root", value),
    createHash("sha256").update(`root\n${value.workerId}\n${value.generation}`).digest("hex"))
  assert.notEqual(hostedBindingToken("root", value), hostedBindingToken("root", { ...value, generation: randomUUID() }))
})

test("a shared execution admits only one active binding and recycles after the completion receipt", async t => {
  const initial = [binding(), binding()]
  const reset = deferred()
  const recycling = deferred()
  const { fleet, peers } = await harness(initial, async operation => {
    if (operation === "recycle") { recycling.resolve(); return reset.promise }
    return { accepting: true }
  })
  t.after(() => fleet.stop())
  assert.equal(await peers[0].state({ state: "busy" }), true)
  await assert.rejects(peers[1].state({ state: "busy" }), /cannot execute two assignments/)
  assert.equal(await peers[0].state({ state: "idle" }), false)
  assert.equal(peers.length, 2)
  // Worker completion resolves only after the broker acknowledges retiring-ready.
  peers[0].done.resolve(null)
  await recycling.promise
  assert.equal(peers[1].stopped, true)
  assert.equal(peers.length, 2)
  const replacement = { ...initial[0], generation: randomUUID() }
  reset.resolve({ accepting: true, bindings: [replacement] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(peers.length, 3)
  assert.equal(peers[2].binding.generation, replacement.generation)
})

test("stop waits for an in-flight binding startup and leaves no peer running", async () => {
  const startup = deferred()
  const entered = deferred()
  let stopped = 0
  const fleet = await startHostedFleet({
    bindings: [],
    request: async () => { throw new Error("Unexpected request") },
    async startWorker() { entered.resolve(); return startup.promise },
  })
  const update = fleet.updateBindings([binding()])
  await entered.promise
  const stopping = fleet.stop()
  startup.resolve({ finished: new Promise(() => {}), async stop() { stopped++ } })
  await Promise.all([stopping, update])
  assert.equal(stopped, 1)
  assert.equal(await fleet.finished, null)
})

test("repository reset failure closes the fleet instead of advertising fresh capacity", async () => {
  const failure = new Error("Repository reset failed")
  const { fleet, peers } = await harness([binding(), binding()], async operation => {
    if (operation === "recycle") throw failure
    return { accepting: true }
  })
  await peers[0].state({ state: "busy" })
  peers[0].done.resolve(null)
  assert.equal(await fleet.finished, failure)
  assert.equal(peers.length, 2)
  assert.equal(peers[1].stopped, true)
})

test("shared inventory rejects duplicate pools and more than 32 connections", async () => {
  const first = binding()
  const options = { startWorker: async () => { throw new Error("Must validate before startup") }, request: async () => ({}) }
  await assert.rejects(startHostedFleet({ ...options, bindings: [first, { ...binding(), poolId: first.poolId }] }), /Invalid shared/)
  await assert.rejects(startHostedFleet({ ...options, bindings: Array.from({ length: 33 }, binding) }), /Invalid shared/)
})
