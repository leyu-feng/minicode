import assert from "node:assert/strict"
import test from "node:test"
import { createHostedEngsysTool } from "../server/hosted-engsys.js"

test("Hosted Engsys reads bind to the assigned run without forwarding its task credential or taking caller auth", async () => {
  const signal = new AbortController().signal
  const calls = []
  const result = { statusCode: 200, body: { buildId: "161465369" } }
  const tool = createHostedEngsysTool({
    task: { runId: "assigned-run", authToken: "paperclip-only-secret" }, baseUrl: "https://engsys.example",
    request: async (...args) => { calls.push(args); return result },
  })
  assert.deepEqual(await tool.execute({ path: "/v1/builds/161465369" }, { signal }), result)
  assert.deepEqual(calls, [["engsys_read", { runId: "assigned-run", path: "/v1/builds/161465369" }, { signal }]])
  for (const input of [
    null, { path: null }, { path: "/v1/builds", method: "POST" },
    { path: "/v1/builds", headers: { Authorization: "caller-secret" } },
    { path: "/v1/builds", runId: "another-run" }, { path: "/v1/builds", outputPath: "/tmp/file" },
  ]) {
    await assert.rejects(tool.execute(input), /accepts only a relative path/)
  }
  assert.equal(calls.length, 1)
})

test("Hosted Engsys errors propagate without an anonymous or Azure CLI fallback", async () => {
  const failure = new Error("Engsys GET /v1/builds failed (HTTP 401) using managed identity")
  let calls = 0
  const tool = createHostedEngsysTool({
    task: { runId: "assigned-run" }, baseUrl: "https://engsys.example",
    request: async () => { calls++; throw failure },
  })
  await assert.rejects(tool.execute({ path: "/v1/builds" }), error => error === failure)
  assert.equal(calls, 1)
})

test("large JSON keeps its artifact path visible within the model tool-result budget", async () => {
  const tool = createHostedEngsysTool({
    task: { runId: "assigned-run" }, baseUrl: "https://engsys.example",
    request: async () => ({
      path: "/v1/builds", statusCode: 200, contentType: "application/json",
      body: { text: "\n".repeat(6000) }, artifact: "/ws/repos/.worker/engsys/result.json",
    }),
  })
  const result = await tool.execute({ path: "/v1/builds" })
  assert.equal(result.artifact, "/ws/repos/.worker/engsys/result.json")
  assert.equal(result.body, undefined)
  assert.match(result.bodyOmitted, /read the returned artifact path/)
  assert.ok(JSON.stringify(result).length < 1000)
})

test("Hosted Engsys respects cancellation before requesting a parent operation", async () => {
  const controller = new AbortController()
  controller.abort()
  const tool = createHostedEngsysTool({
    task: { runId: "assigned-run" }, baseUrl: "https://engsys.example",
    request: async () => { throw new Error("The parent must not be called") },
  })
  await assert.rejects(tool.execute({ path: "/v1/builds" }, { signal: controller.signal }), { name: "AbortError" })
})
