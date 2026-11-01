import assert from "node:assert/strict"
import test from "node:test"
import { spawn } from "node:child_process"
import { HostedHarnessSession } from "../server/hosted-harness-session.js"
import { startHostedHarnessBridge } from "../server/hosted-harness-bridge.js"

const endpoint = "https://model.example/openai/v1/responses"

test("Hosted model bridge authenticates, pins the deployment and never exposes upstream credentials", async t => {
  const controller = new AbortController()
  const errors = []
  const fetchOriginal = globalThis.fetch
  const calls = []
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).startsWith("https://model.example")) {
      calls.push({ url: String(url), options })
      return new Response('{"output":[]}', { headers: { "Content-Type": "application/json" } })
    }
    return fetchOriginal(url, options)
  })
  const toolCalls = []
  const bridge = await startHostedHarnessBridge({
    endpoint, model: "deployment", signal: controller.signal, getAccessToken: async () => "private-model-token",
    onError: error => errors.push(error),
    tools: [{ name: "publish_pull_request", description: "Publish",
      parameters: { type: "object", properties: { commit: { type: "string" } } },
      execute: async (input, options) => { toolCalls.push({ input, options }); return { registered: true } } }],
  })
  t.after(async () => { controller.abort(); await bridge.close() })
  const post = (route, input, authenticated = true) => fetchOriginal(`${bridge.baseUrl}${route}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(authenticated ? { Authorization: `Bearer ${bridge.secret}` } : {}) },
    body: JSON.stringify(input),
  })
  assert.equal((await post("/openai/v1/responses", {}, false)).status, 401)
  assert.equal((await post("/unapproved", {})).status, 404)
  const model = await post("/openai/v1/responses", { model: "unapproved-deployment", input: "Hello" })
  assert.equal(model.status, 200)
  assert.equal(JSON.parse(calls[0].options.body).model, "deployment")
  assert.equal(calls[0].options.headers.Authorization, "Bearer private-model-token")
  assert.ok(!(await model.text()).includes("private-model-token"))
  const result = await (await post("/mcp", {
    jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "publish_pull_request", arguments: { commit: "abc" } },
  })).json()
  assert.equal(result.result.content[0].text, '{"registered":true}')
  assert.deepEqual(toolCalls[0].input, { commit: "abc" })
  assert.equal(toolCalls[0].options.signal, controller.signal)
  assert.deepEqual(errors, [])
})

for (const harness of ["opencode", "pi"]) {
  test(`${harness} runs a separate CLI with assignment credentials and trusted tools`, async t => {
    const script = `
      import readline from "node:readline";
      const configuration = ${harness === "pi" ? "JSON.parse(process.env.HOSTED_HARNESS_CONFIG)" : `(() => {
        const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
        return { baseUrl: config.mcp.hosted.url.replace(/\\/mcp$/, ""), secret: config.provider.hosted.options.apiKey };
      })()`};
      const lines = readline.createInterface({ input: process.stdin });
      for await (const line of lines) {
        if (!line.includes("Assigned task")) throw new Error("No task on stdin");
        if (process.env.PAPERCLIP_API_KEY !== "run-secret") throw new Error("Missing run credentials");
        if (process.env.IDENTITY_ENDPOINT || process.env.OPENAI_API_KEY) throw new Error("Leaked inherited authentication");
        const response = await fetch(configuration.baseUrl + "/mcp", {
          method: "POST", headers: { Authorization: "Bearer " + configuration.secret, "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "provider_read", arguments: { route: "approved" } } })
        });
        if (!response.ok || (await response.json()).result.isError) throw new Error("Tool bridge failed");
        ${harness === "pi" ? `console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Finished" } }));
          console.log(JSON.stringify({ type: "agent_end", messages: [] }));` :
        `console.log(JSON.stringify({ type: "text", part: { text: "Finished" } }));
          console.log(JSON.stringify({ type: "step_finish" }));`}
        break;
      }
      lines.close();
      process.stdin.pause();
    `
    const calls = []
    let invocation
    const session = new HostedHarnessSession({
      harness, id: "run", cwd: process.cwd(), instructions: "Trusted worker policy",
      env: { PAPERCLIP_API_KEY: "run-secret", IDENTITY_ENDPOINT: "private", OPENAI_API_KEY: "private" },
      tools: [{ name: "provider_read", description: "Trusted read", parameters: { type: "object" },
        execute: async input => { calls.push(input); return "read result" } }],
      modelConfig: { endpoint, model: "deployment", getAccessToken: async () => "private-token" },
      prepare: async (selected, id) => { assert.equal(selected, harness); assert.equal(id, "run"); return { harness, command: "trusted-contained-entrypoint" } },
      spawnProcess: (command, args, options) => {
        invocation = { command, args, options }
        return spawn(process.execPath, ["--input-type=module", "-e", script], options)
      },
    })
    t.after(() => session.dispose())
    const output = []
    session.on("output", event => output.push(event.data))
    assert.deepEqual(await session.write("Assigned task\n"), { exitCode: 0 })
    assert.deepEqual(calls, [{ route: "approved" }])
    assert.equal(invocation.args.some(arg => arg.includes("Assigned task") || arg.includes("run-secret")), false)
    assert.ok(output.join("").includes("Finished"))
  })
}

test("Pi treats terminal model errors as failures even when the process exits zero", async t => {
  const session = new HostedHarnessSession({
    harness: "pi", id: "run", cwd: process.cwd(), env: {}, instructions: "Policy", tools: [],
    modelConfig: { endpoint, model: "deployment", getAccessToken: async () => "token" },
    prepare: async () => ({ harness: "pi", command: "trusted" }),
    spawnProcess: (_command, _args, options) => spawn(process.execPath, ["-e",
      'console.log(JSON.stringify({type:"agent_end",messages:[{role:"assistant",stopReason:"error",errorMessage:"Provider rejected request"}]}))'], options),
  })
  t.after(() => session.dispose())
  assert.deepEqual(await session.write("Task"), { exitCode: 1, error: "Provider rejected request" })
})

test("cancelling an external harness waits for process termination and never falls back", async t => {
  const session = new HostedHarnessSession({
    harness: "opencode", id: "run", cwd: process.cwd(), env: {}, instructions: "Policy", tools: [],
    modelConfig: { endpoint, model: "deployment", getAccessToken: async () => "token" },
    prepare: async () => ({ harness: "opencode", command: "trusted" }),
    spawnProcess: (_command, _args, options) => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options)
      child.once("spawn", () => session.interrupt())
      return child
    },
  })
  t.after(() => session.dispose())
  assert.deepEqual(await session.write("Task"), { exitCode: 130 })
  assert.equal(session.child, null)
})

for (const scenario of ["invalid event", "spawn failure"]) {
  test(`external harness ${scenario} fails after process cleanup`, async t => {
    let closed = false
    const session = new HostedHarnessSession({
      harness: "opencode", id: "run", cwd: process.cwd(), env: {}, instructions: "Policy", tools: [],
      modelConfig: { endpoint, model: "deployment", getAccessToken: async () => "token" },
      prepare: async () => ({ harness: "opencode", command: "trusted" }),
      spawnProcess: (_command, _args, options) => {
        const child = scenario === "spawn failure" ? spawn("nonexistent-hosted-harness-executable", [], options) :
          spawn(process.execPath, ["-e", 'console.log("null"); setInterval(() => {}, 1000)'], options)
        child.once("close", () => { closed = true })
        return child
      },
    })
    t.after(() => session.dispose())
    const result = await session.write("Task")
    assert.equal(result.exitCode, 1)
    assert.match(result.error, scenario === "spawn failure" ? /ENOENT/ : /invalid event/)
    assert.equal(closed, true)
    assert.equal(session.child, null)
  })
}

for (const harness of ["opencode", "pi"]) {
test(`installed ${harness} completes a trusted tool call through the private model bridge`, {
  skip: !process.env[`HOSTED_${harness.toUpperCase()}_TEST_EXECUTABLE`], timeout: 45_000,
}, async t => {
  const fetchOriginal = globalThis.fetch
  let requested = false
  let toolCalled = false
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (!String(url).startsWith("https://model.example")) return fetchOriginal(url, options)
    const input = JSON.parse(options.body)
    const tool = input.tools?.find(tool => tool.name.endsWith("provider_read"))
    const respondWithText = toolCalled || !input.tools?.length
    if (!respondWithText) assert.ok(tool, "The real harness must expose the trusted worker tool")
    if (tool) requested = true
    const message = respondWithText ?
      { id: "msg_smoke", type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "READY", annotations: [] }] } :
      { id: "fc_smoke", type: "function_call", call_id: "call_smoke", name: tool.name,
        status: "completed", arguments: '{"route":"approved"}' }
    const response = { id: "resp_smoke", object: "response", created_at: 1, model: "deployment", status: "completed",
      output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
    const events = [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
      ...(respondWithText ? [
        { type: "response.content_part.added", item_id: message.id, output_index: 0, content_index: 0,
        part: { type: "output_text", text: "", annotations: [] } },
        { type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: "READY" },
        { type: "response.output_text.done", item_id: message.id, output_index: 0, content_index: 0, text: "READY" },
      ] : [
        { type: "response.function_call_arguments.delta", item_id: message.id, output_index: 0, delta: message.arguments },
        { type: "response.function_call_arguments.done", item_id: message.id, output_index: 0, arguments: message.arguments },
      ]),
      { type: "response.output_item.done", output_index: 0, item: message },
      { type: "response.completed", response },
    ]
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "Content-Type": "text/event-stream" } })
  })
  const session = new HostedHarnessSession({
    harness, id: "smoke", cwd: process.cwd(), env: {}, instructions: "Use provider_read, then reply READY.",
    tools: [{ name: "provider_read", description: "Read the approved route",
      parameters: { type: "object", properties: { route: { type: "string" } }, required: ["route"] },
      execute: async input => { assert.deepEqual(input, { route: "approved" }); toolCalled = true; return "read result" } }],
    modelConfig: { endpoint, model: "deployment", getAccessToken: async () => "smoke-only-token" },
    prepare: async () => ({ harness, command: "trusted" }),
    spawnProcess: (_command, args, options) => {
      const executable = process.env[`HOSTED_${harness.toUpperCase()}_TEST_EXECUTABLE`]
      if (executable.endsWith(".dll")) return spawn("dotnet", [executable, ...args.slice(3)], options)
      return harness === "pi" ? spawn(process.execPath, [executable, ...args.slice(3)], options) :
        spawn(executable, args.slice(3), options)
    },
  })
  const timeout = setTimeout(() => session.interrupt(), 35_000)
  t.after(async () => { clearTimeout(timeout); await session.dispose() })
  const output = []
  session.on("output", event => output.push(event.data))
  const result = await session.write("Reply READY.")
  assert.equal(result.exitCode, 0, `${result.error ?? ""}\n${output.join("")}`)
  assert.ok(requested)
  assert.ok(toolCalled)
  assert.ok(output.join("").includes("READY"))
})
}
