import assert from "node:assert/strict"
import childProcess from "node:child_process"
import { EventEmitter } from "node:events"
import test, { afterEach } from "node:test"
import { AgentSession, callModelOnce } from "../server/agent-session.js"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("calls the Azure Responses API with an Entra token", async () => {
  let request
  globalThis.fetch = async (url, init) => {
    request = { url, init }
    return new Response(
      JSON.stringify({
        output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
  }

  const result = await callModelOnce(
    {
      api: "responses",
      endpoint: "https://example.test/openai/v1/responses",
      getAccessToken: async () => "entra-token",
      model: "gpt-5.6-sol",
    },
    [{ role: "user", content: "hello" }],
  )

  assert.equal(result, "OK")
  assert.equal(request.url, "https://example.test/openai/v1/responses")
  assert.equal(request.init.headers.Authorization, "Bearer entra-token")
  assert.deepEqual(JSON.parse(request.init.body), {
    model: "gpt-5.6-sol",
    input: [{ role: "user", content: "hello" }],
  })
})

test("reports the endpoint when a model request cannot connect", async () => {
  globalThis.fetch = async () => {
    const cause = new Error("blocked")
    cause.code = "ENETUNREACH"
    throw new TypeError("fetch failed", { cause })
  }

  await assert.rejects(
    callModelOnce(
      {
        api: "responses",
        endpoint: "https://example.test/openai/v1/responses",
        getAccessToken: async () => "entra-token",
        model: "gpt-5.6-sol",
      },
      [{ role: "user", content: "hello" }],
    ),
    /Model request could not reach https:\/\/example\.test\/openai\/v1\/responses: fetch failed \(ENETUNREACH\)/,
  )
})

test("AgentSession returns a failed result when the model request fails", async () => {
  const originalKey = process.env.OPENCODE_API_KEY
  const originalUrl = process.env.OPENCODE_BASE_URL
  process.env.OPENCODE_API_KEY = "fixture-only"
  process.env.OPENCODE_BASE_URL = "https://example.test/v1"
  globalThis.fetch = async () => new Response("model unavailable", { status: 503 })
  const session = new AgentSession({ id: "failed-worker", cwd: process.cwd() })
  try {
    const result = await session.write("do work")
    assert.equal(result.exitCode, 1)
    assert.match(result.error, /503/)
  } finally {
    session.dispose()
    if (originalKey === undefined) delete process.env.OPENCODE_API_KEY
    else process.env.OPENCODE_API_KEY = originalKey
    if (originalUrl === undefined) delete process.env.OPENCODE_BASE_URL
    else process.env.OPENCODE_BASE_URL = originalUrl
  }
})

test("AgentSession reports failure when shell actions exhaust the tool turn limit", async (t) => {
  const originalKey = process.env.OPENCODE_API_KEY
  const originalUrl = process.env.OPENCODE_BASE_URL
  process.env.OPENCODE_API_KEY = "fixture-only"
  process.env.OPENCODE_BASE_URL = "https://example.test/v1"
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: '{"type":"tool","command":"echo fixture"}' } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } })
  t.mock.method(childProcess, "spawn", () => {
    const proc = new EventEmitter()
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    queueMicrotask(() => proc.emit("close", 0))
    return proc
  })
  const session = new AgentSession({ id: "exhausted-worker", cwd: process.cwd() })
  try {
    const result = await session.write("do work")
    assert.equal(result.exitCode, 1)
    assert.match(result.error, /max tool turns/)
  } finally {
    session.dispose()
    if (originalKey === undefined) delete process.env.OPENCODE_API_KEY
    else process.env.OPENCODE_API_KEY = originalKey
    if (originalUrl === undefined) delete process.env.OPENCODE_BASE_URL
    else process.env.OPENCODE_BASE_URL = originalUrl
  }
})
