import assert from "node:assert/strict"
import test from "node:test"
import { createHostedProviderTool } from "../server/hosted-provider.js"

test("Hosted Provider reads bind to the assigned run without forwarding its task credential or taking caller auth", async () => {
  const signal = new AbortController().signal
  const calls = []
  const result = { statusCode: 200, body: { buildId: "123" } }
  const tool = createHostedProviderTool({
    task: { runId: "assigned-run", authToken: "paperclip-only-secret" }, baseUrl: "https://provider.example", routes: ["/v1/builds/{id}"],
    request: async (...args) => { calls.push(args); return result },
  })
  assert.deepEqual(await tool.execute({ path: "/v1/builds/123" }, { signal }), result)
  assert.deepEqual(calls, [["provider_read", { runId: "assigned-run", path: "/v1/builds/123" }, { signal }]])
  for (const input of [
    null, { path: null }, { path: "https://other.example/api" }, { path: "//other.example/api" },
    { path: "/api\\other" }, { path: "/api\nother" }, { path: "/v1/builds", method: "POST" },
    { path: "/v1/builds", headers: { Authorization: "caller-secret" } },
    { path: "/v1/builds", runId: "another-run" }, { path: "/v1/builds", outputPath: "/tmp/file" },
  ]) {
    await assert.rejects(tool.execute(input), /accepts only a relative path/)
  }
  assert.equal(calls.length, 1)
})

test("Hosted Provider errors propagate without an anonymous or Azure CLI fallback", async () => {
  const failure = new Error("Provider GET /v1/builds failed (HTTP 401) using managed identity")
  let calls = 0
  const tool = createHostedProviderTool({
    task: { runId: "assigned-run" }, baseUrl: "https://provider.example", routes: ["/v1/builds"],
    request: async () => { calls++; throw failure },
  })
  await assert.rejects(tool.execute({ path: "/v1/builds" }), error => error === failure)
  assert.equal(calls, 1)
})

test("large JSON keeps its artifact path visible within the model tool-result budget", async () => {
  const tool = createHostedProviderTool({
    task: { runId: "assigned-run" }, baseUrl: "https://provider.example", routes: ["/v1/builds"],
    request: async () => ({
      path: "/v1/builds", statusCode: 200, contentType: "application/json",
      body: { text: "\n".repeat(6000) }, artifact: "/ws/repos/.worker/provider/result.json",
    }),
  })
  const result = await tool.execute({ path: "/v1/builds" })
  assert.equal(result.artifact, "/ws/repos/.worker/provider/result.json")
  assert.equal(result.body, undefined)
  assert.match(result.bodyOmitted, /read the returned artifact path/)
  assert.ok(JSON.stringify(result).length < 1000)
})

test("Hosted Provider respects cancellation before requesting a parent operation", async () => {
  const controller = new AbortController()
  controller.abort()
  const tool = createHostedProviderTool({
    task: { runId: "assigned-run" }, baseUrl: "https://provider.example", routes: ["/v1/builds"],
    request: async () => { throw new Error("The parent must not be called") },
  })
  await assert.rejects(tool.execute({ path: "/v1/builds" }, { signal: controller.signal }), { name: "AbortError" })
})

test("Hosted provider reads advertise arbitrary partner routes without build-service assumptions", async () => {
  const tool = createHostedProviderTool({
    task: { runId: "weather-run" }, baseUrl: "https://partner.example", routes: ["/api/weather/{city}"],
    request: async (operation, input) => {
      assert.equal(operation, "provider_read")
      assert.deepEqual(input, { runId: "weather-run", path: "/api/weather/seattle" })
      return { body: { temperature: 12 } }
    },
  })
  assert.match(tool.description, /\/api\/weather\/\{city\}/)
  assert.doesNotMatch(tool.description, /\/v1\/builds/)
  assert.deepEqual(await tool.execute({ path: "/api/weather/seattle" }), { body: { temperature: 12 } })
  for (const options of [
    { baseUrl: "http://partner.example", routes: ["/api/weather"] },
    { baseUrl: "https://partner.example", routes: [] },
    { baseUrl: "https://partner.example" },
    { baseUrl: "https://partner.example", routes: ["https://other.example/api"] },
  ]) assert.throws(() => createHostedProviderTool(options), /explicit relative GET route allowlist/)
})
