import assert from "node:assert/strict"
import test from "node:test"
import { createHerdrWorkerReporter } from "../server/herdr-worker-reporter.js"

test("Herdr worker reporting and cleanup use pane-first arguments compatible with Herdr 0.9.5", async () => {
  const calls = []
  const reporter = createHerdrWorkerReporter({
    workerName: "sql-worker",
    env: { HERDR_ENV: "1", HERDR_PANE_ID: "w5:p3" },
    run: async args => { calls.push(args) },
  })

  await reporter.state({ state: "idle" })
  await reporter.state({ state: "busy" })
  reporter.activity({ kind: "model_action", action: "shell", target: "call-1", summary: "Run npm test" })
  reporter.activity({ kind: "tool_result", action: "shell", target: "call-1", summary: "passed" })
  await reporter.stop()

  assert.equal(reporter.enabled, true)
  assert.deepEqual(calls.map(args => args.slice(0, 3)), [
    ["pane", "report-metadata", "w5:p3"],
    ["pane", "report-metadata", "w5:p3"],
    ["pane", "report-agent", "w5:p3"],
    ["pane", "report-metadata", "w5:p3"],
    ["pane", "report-agent", "w5:p3"],
    ["pane", "report-metadata", "w5:p3"],
    ["pane", "report-agent", "w5:p3"],
    ["pane", "report-metadata", "w5:p3"],
    ["pane", "report-agent", "w5:p3"],
    ["pane", "release-agent", "w5:p3"],
    ["pane", "report-metadata", "w5:p3"],
  ])
  assert.ok(calls[0].includes("minicode-role=worker"))
  assert.ok(calls[1].includes("sql-worker"))
  assert.ok(calls[2].includes("idle"))
  assert.ok(calls[4].includes("working"))
  assert.ok(calls[5].includes("Busy - Run npm test"))
  assert.ok(calls[7].includes("Busy - shell completed; processing result"))
  assert.ok(calls.at(-1).includes("--clear-token"))
})

test("Herdr worker reporter stays disabled outside a dedicated Herdr pane", async () => {
  let called = false
  for (const env of [{}, { HERDR_ENV: "1", HERDR_PANE_ID: "bad" },
    { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2", MINICODE_WORKERS_MODE: "1" }]) {
    const reporter = createHerdrWorkerReporter({ workerName: "worker", env,
      run: async () => { called = true } })
    assert.equal(reporter.enabled, false)
    await reporter.state({ state: "busy" })
    reporter.activity({ kind: "model_action", target: "tool", summary: "command" })
    await reporter.stop()
  }
  assert.equal(called, false)
})

test("worker role reporting retries after a transient failure before publishing lifecycle", async () => {
  const calls = []
  const logs = []
  const reporter = createHerdrWorkerReporter({
    env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2" },
    log: message => logs.push(message),
    run: async args => {
      calls.push(args)
      if (calls.length === 1) throw new Error("server unavailable")
    },
  })
  await reporter.state({ state: "idle" })
  await reporter.stop()
  assert.equal(logs.length, 1)
  assert.match(logs[0], /server unavailable/)
  assert.equal(calls.filter(args => args.includes("minicode-role=worker")).length, 2)
  assert.ok(calls.some(args => args[1] === "report-agent" && args.includes("idle")))
})
