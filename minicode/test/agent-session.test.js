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

test("worker instructions reach the model and a reported blocker produces a failed result without shell execution", async (t) => {
  const instructions = "Only use the assigned workspace. Stop if required server credentials are missing."
  let request
  globalThis.fetch = async (_url, init) => {
    request = JSON.parse(init.body)
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        type: "final", message: "Cannot retrieve the required skill. Supply server credentials.",
        error: "Missing server credentials",
      }) } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })
  }
  t.mock.method(childProcess, "spawn", assert.fail)
  const session = new AgentSession({ id: "blocked-worker", cwd: process.cwd(), instructions })
  session.config = {
    api: "chat-completions", endpoint: "https://example.test/v1/chat/completions",
    apiKey: "fixture-only", model: "fixture-model",
  }
  let output = ""
  session.on("output", ({ data }) => { output += data })
  try {
    const result = await session.write("Read a required skill")
    assert.equal(result.exitCode, 1)
    assert.equal(result.error, "Missing server credentials")
    assert.ok(request.messages[0].content.includes(instructions))
    assert.match(output, /Supply server credentials/)
  } finally {
    session.dispose()
  }
})

test("named harness tools reach the model, execute outside the shell, and return structured receipts", async t => {
  const calls = [], requests = []
  const actions = [
    { type: "tool", name: "publish_pull_request", arguments: { commit: "fixture" } },
    { type: "final", message: "PR ready for review" },
  ]
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body))
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(actions.shift()) } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } })
  }
  t.mock.method(childProcess, "spawn", assert.fail)
  const session = new AgentSession({
    id: "publisher", cwd: process.cwd(), tools: [{
      name: "publish_pull_request", description: "Publish through the harness", parameters: { type: "object" },
      async execute(args, { signal }) { calls.push(args); assert.equal(signal.aborted, false); return { url: "https://github.com/fixture/repo/pull/1" } },
    }],
  })
  session.config = { api: "chat-completions", endpoint: "https://example.test/v1/chat/completions", apiKey: "fixture", model: "fixture" }
  try {
    assert.equal((await session.write("Publish the validated commit")).exitCode, 0)
    assert.deepEqual(calls, [{ commit: "fixture" }])
    assert.ok(requests[0].messages[0].content.includes('"name":"publish_pull_request"'))
    assert.match(requests[1].messages.at(-1).content, /ok: true.*\nresult:.*https:\/\/github.com\/fixture\/repo\/pull\/1/)
  } finally { session.dispose() }
})

test("disabled or ambiguous harness tools return explicit errors without running shell commands", async t => {
  const requests = []
  const actions = [
    { type: "tool", name: "disabled", arguments: {} },
    { type: "tool", name: "enabled", arguments: {}, command: "must not run" },
    { type: "final", message: "Blocked", error: "Tool unavailable" },
  ]
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body))
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(actions.shift()) } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } })
  }
  t.mock.method(childProcess, "spawn", assert.fail)
  const session = new AgentSession({ id: "disabled", cwd: process.cwd(), tools: [
    { name: "enabled", description: "Enabled", execute: assert.fail },
  ] })
  session.config = { api: "chat-completions", endpoint: "https://example.test/v1/chat/completions", apiKey: "fixture", model: "fixture" }
  try {
    assert.equal((await session.write("Publish")).exitCode, 1)
    assert.match(requests[1].messages.at(-1).content, /not enabled/)
    assert.match(requests[2].messages.at(-1).content, /cannot include a shell command/)
  } finally { session.dispose() }
})

test("interrupting a harness tool forwards cancellation and waits for its cleanup", async t => {
  let ready, release, cleaned = false
  const started = new Promise(resolve => { ready = resolve })
  const cleanup = new Promise(resolve => { release = resolve })
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content:
    JSON.stringify({ type: "tool", name: "publish_pull_request", arguments: {} }),
  } }] }), { status: 200, headers: { "Content-Type": "application/json" } })
  t.mock.method(childProcess, "spawn", assert.fail)
  const session = new AgentSession({ id: "cancel-tool", cwd: process.cwd(), tools: [{
    name: "publish_pull_request", description: "Publish", async execute(_args, { signal }) {
      ready()
      await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }))
      await cleanup
      cleaned = true
      signal.throwIfAborted()
    },
  }] })
  session.config = { api: "chat-completions", endpoint: "https://example.test/v1/chat/completions", apiKey: "fixture", model: "fixture" }
  try {
    const operation = session.write("Publish")
    await started
    session.interrupt()
    let settled = false
    operation.then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(settled, false)
    release()
    assert.equal((await operation).exitCode, 130)
    assert.equal(cleaned, true)
  } finally { release(); session.dispose() }
})
