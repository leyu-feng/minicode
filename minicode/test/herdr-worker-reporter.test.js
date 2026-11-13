import assert from "node:assert/strict"
import test from "node:test"
import { createHerdrWorkerReporter } from "../server/herdr-worker-reporter.js"

test("Herdr worker reporter publishes lifecycle and current tool activity", async () => {
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
    ["pane", "report-metadata", "--source"],
    ["pane", "report-agent", "--source"],
    ["pane", "report-metadata", "--source"],
    ["pane", "report-agent", "--source"],
    ["pane", "report-metadata", "--source"],
    ["pane", "report-agent", "--source"],
    ["pane", "report-metadata", "--source"],
    ["pane", "report-agent", "--source"],
    ["pane", "release-agent", "--source"],
  ])
  assert.ok(calls[0].includes("sql-worker"))
  assert.ok(calls[1].includes("idle"))
  assert.ok(calls[3].includes("working"))
  assert.ok(calls[4].includes("Busy - Run npm test"))
  assert.ok(calls[6].includes("Busy - shell completed; processing result"))
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
