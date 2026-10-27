import assert from "node:assert/strict"
import test from "node:test"
import { createHostedProviderTool, createHostedProviderPostTool } from "../server/hosted-provider.js"

const retryPath = "/v1/builds/123/stages/c952ca9e-c683-5349-c7b6-e858fdfdd2c1/retry"
const bodySchema = {
  type: "object", properties: { expectedAttempt: { type: "integer", minimum: 1, maximum: 5 } },
  required: ["expectedAttempt"], additionalProperties: false,
}

test("Hosted provider POST binds the run and advertises the provider-owned body schema without exposing credentials", async () => {
  const calls = []
  const signal = new AbortController().signal
  const expected = { statusCode: 202, body: { state: "retryRequested" } }
  const tool = createHostedProviderPostTool({
    task: { runId: "assigned-run", authToken: "task-only-secret" }, baseUrl: "https://provider.example",
    routes: ["/v1/builds/{id}/stages/{guid}/retry"], bodySchema,
    request: async (...args) => { calls.push(args); return expected },
  })

  assert.equal(tool.name, "provider_post")
  assert.deepEqual(tool.parameters.properties.body, bodySchema)
  assert.deepEqual(tool.parameters.required, ["path", "body"])
  assert.match(tool.description, /never automatically replay the POST/)
  assert.deepEqual(await tool.execute({ path: retryPath, body: { expectedAttempt: 2 } }, { signal }), expected)
  assert.deepEqual(calls, [["provider_post",
    { runId: "assigned-run", path: retryPath, body: { expectedAttempt: 2 } }, { signal }]])
  assert.doesNotMatch(JSON.stringify(tool), /task-only-secret/)
})

test("Hosted provider POST rejects malformed requests and caller overrides before forwarding", async () => {
  let calls = 0
  const tool = createHostedProviderPostTool({
    task: { runId: "assigned-run" }, baseUrl: "https://provider.example", routes: ["/retry"], bodySchema,
    request: async () => { calls++ },
  })
  for (const input of [
    null, { path: "https://other.example/retry", body: {} }, { path: "//other.example/retry", body: {} },
    { path: "/retry\\other", body: {} }, { path: "/retry#fragment", body: {} },
    { path: "/retry", body: {}, method: "DELETE" }, { path: "/retry", body: {}, runId: "another" },
    { path: "/retry", body: {}, headers: { Authorization: "caller-secret" } },
    { path: "/retry", body: {}, outputPath: "/tmp/result" }, { path: "/retry" },
    { path: "/retry", body: null }, { path: "/retry", body: [] }, { path: "/retry", body: "json" },
    { path: "/retry", body: { text: "a".repeat(8192) } },
  ]) await assert.rejects(tool.execute(input))
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(tool.execute({ path: "/retry", body: { expectedAttempt: 1 } }, { signal: controller.signal }), { name: "AbortError" })
  assert.equal(calls, 0)
})

test("Hosted provider POST never replays parent errors or switches authentication", async () => {
  let calls = 0
  const failure = new Error("POST outcome unknown")
  const tool = createHostedProviderPostTool({
    task: { runId: "assigned-run" }, baseUrl: "https://provider.example", routes: ["/retry"], bodySchema,
    request: async () => { calls++; throw failure },
  })
  await assert.rejects(tool.execute({ path: "/retry", body: { expectedAttempt: 1 } }), error => error === failure)
  assert.equal(calls, 1)
})

test("Hosted provider POST remains generic and requires an advertised JSON body schema", async () => {
  const tool = createHostedProviderPostTool({
    task: { runId: "partner-run" }, baseUrl: "https://partner.example", routes: ["/api/reports"],
    bodySchema: { type: "object", properties: { title: { type: "string" } } },
    request: async (operation, input) => {
      assert.equal(operation, "provider_post")
      assert.deepEqual(input, { runId: "partner-run", path: "/api/reports", body: { title: "Report" } })
      return { statusCode: 202 }
    },
  })
  assert.doesNotMatch(tool.description, /\/v1\/builds|expectedAttempt/)
  assert.deepEqual(await tool.execute({ path: "/api/reports", body: { title: "Report" } }), { statusCode: 202 })
  for (const schema of [undefined, null, [], { type: "string" }]) {
    assert.throws(() => createHostedProviderPostTool({
      baseUrl: "https://partner.example", routes: ["/api/reports"], bodySchema: schema,
    }), /provider-advertised object body schema/)
  }
})

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
