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
  const toolEvents = []
  const bridge = await startHostedHarnessBridge({
    endpoint, model: "deployment", signal: controller.signal, getAccessToken: async () => "private-model-token",
    onError: error => errors.push(error),
    onToolEvent: event => toolEvents.push(event),
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
  assert.deepEqual(toolEvents.map(event => ({ id: event.id, phase: event.phase, name: event.name })), [
    { id: 1, phase: "start", name: "publish_pull_request" },
    { id: 1, phase: "end", name: "publish_pull_request" },
  ])
  assert.deepEqual(toolEvents[1].output, { registered: true })
  assert.deepEqual(errors, [])
})

for (const harness of ["opencode", "pi"]) {
  test(`${harness} runs a separate CLI with assignment credentials and trusted tools`, async t => {
    const fetchOriginal = globalThis.fetch
    const modelRequests = []
    t.mock.method(globalThis, "fetch", async (url, options) => {
      if (!String(url).startsWith("https://model.example")) return fetchOriginal(url, options)
      modelRequests.push(JSON.parse(options.body))
      return new Response('{"output":[]}', { headers: { "Content-Type": "application/json" } })
    })
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
        const model = await fetch(configuration.baseUrl + "/openai/v1/responses", {
          method: "POST", headers: { Authorization: "Bearer " + configuration.secret, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "unapproved", instructions: "Policy run-secret",
            metadata: { apiKey: "unregistered-credential" },
            input: [{ role: "user", content: "Task " + configuration.secret },
              { type: "reasoning", summary: [{ type: "summary_text", text: "HIDDEN_REASONING" }] }] })
        });
        if (!model.ok) throw new Error("Model bridge failed");
        await model.text();
        ${harness === "pi" ? `console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "1", toolName: "provider_read", args: { route: "approved" } }));` : ""}
        const response = await fetch(configuration.baseUrl + "/mcp", {
          method: "POST", headers: { Authorization: "Bearer " + configuration.secret, "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "provider_read", arguments: { route: "approved" } } })
        });
        if (!response.ok || (await response.json()).result.isError) throw new Error("Tool bridge failed");
        ${harness === "pi" ? `
          console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "1", toolName: "provider_read", result: { content: [{ type: "text", text: "read result" }] }, isError: false }));
          console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "native-1", toolName: "bash", args: { command: "echo run-secret" } }));
          console.log(JSON.stringify({ type: "tool_execution_update", toolCallId: "native-1", toolName: "bash", partialResult: { content: [{ type: "text", text: "partial run-secret" }] } }));
          console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "native-1", toolName: "bash", result: { content: [{ type: "text", text: "shell result" }] }, isError: false }));
        ` : `
          console.log(JSON.stringify({ type: "tool_start", part: { id: "native-1", tool: "shell", state: { status: "running", input: { command: "echo run-secret" } } } }));
          console.log(JSON.stringify({ type: "tool_use", part: { id: "native-1", tool: "shell", state: { status: "completed", input: { command: "echo run-secret" }, output: "shell result" } } }));
        `}
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
    const version = harness === "pi" ? "1.4.0-beta.1" : "2.2.5-beta.1"
    const output = []
    const events = []
    const activities = []
    let invocation
    const session = new HostedHarnessSession({
      harness, id: "run", cwd: process.cwd(), instructions: "Trusted worker policy",
      env: { PAPERCLIP_API_KEY: "run-secret", IDENTITY_ENDPOINT: "private", OPENAI_API_KEY: "private" },
      tools: [{ name: "provider_read", description: "Trusted read", parameters: { type: "object" },
        execute: async input => { calls.push(input); return "read result" } }],
      modelConfig: { endpoint, model: "deployment", getAccessToken: async () => "private-token" },
      prepare: async (selected, id) => { assert.equal(selected, harness); assert.equal(id, "run"); return { harness, command: "trusted-contained-entrypoint", version } },
      spawnProcess: (command, args, options) => {
        assert.deepEqual(output, [`using ${harness}.contained.${version} harness\n`])
        invocation = { command, args, options }
        return spawn(process.execPath, ["--input-type=module", "-e", script], options)
      },
    })
    t.after(() => session.dispose())
    session.on("output", event => { output.push(event.data); events.push(event) })
    session.on("activity", event => activities.push(event))
    assert.deepEqual(await session.write("Assigned task\n"), { exitCode: 0 })
    assert.deepEqual(calls, [{ route: "approved" }])
    assert.equal(invocation.args.some(arg => arg.includes("Assigned task") || arg.includes("run-secret")), false)
    assert.ok(output.join("").includes("Finished"))
    assert.equal(modelRequests[0].model, "deployment")
    assert.equal(modelRequests[0].metadata.apiKey, "unregistered-credential")
    assert.ok(activities.some(event => event.kind === "prompt" && event.summary.includes("Assigned task")))
    assert.ok(activities.every(event => ["prompt", "model_action", "tool_result", "error"].includes(event.kind)))
    assert.equal(activities.find(event => event.kind === "prompt").turn, undefined)
    assert.ok(activities.some(event => event.action === "model_request" && event.turn === 1))
    assert.deepEqual(activities.filter(event => event.action === "provider_read").map(event => event.kind), ["model_action", "tool_result"])
    assert.deepEqual(activities.filter(event => event.target === "native-1").map(event => event.kind), ["model_action", "tool_result"])
    assert.ok(activities.some(event => event.kind === "tool_result" && event.summary.includes("shell result")))
    assert.ok(events.some(event => event.stream === "command" && event.data.includes("# system instructions")))
    assert.ok(events.some(event => event.stream === "command" && event.data.includes("# model request 1")))
    const logs = JSON.stringify({ events, activities })
    for (const secret of ["run-secret", "private-token", "unregistered-credential", "HIDDEN_REASONING"]) assert.ok(!logs.includes(secret), secret)
  })
}

test("external harness rejects missing or multiline package versions before handoff", async t => {
  for (const version of [undefined, "1.4.0-beta.1\nunexpected output"]) {
    let spawned = false
    const output = []
    const session = new HostedHarnessSession({
      harness: "pi", id: "run", cwd: process.cwd(), env: {}, instructions: "Policy", tools: [],
      modelConfig: { endpoint, model: "deployment", getAccessToken: async () => "token" },
      prepare: async () => ({ harness: "pi", command: "trusted", version }),
      spawnProcess: () => { spawned = true; throw new Error("Unexpected spawn") },
    })
    t.after(() => session.dispose())
    session.on("output", event => output.push(event.data))
    assert.deepEqual(await session.write("Task"), { exitCode: 1, error: "Hosted parent returned an invalid harness launch descriptor" })
    assert.equal(spawned, false)
    assert.deepEqual(output, [])
  }
})

test("external model failures retain bounded redacted prompt evidence only when enabled", async t => {
  const fetchOriginal = globalThis.fetch
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (!String(url).startsWith("https://model.example")) return fetchOriginal(url, options)
    return new Response('{"error":"rejected"}', { status: 403, headers: { "x-request-id": "model-request-1" } })
  })
  for (const mode of ["disabled", "enabled", "too_large"]) {
    const script = `
      await new Promise(resolve => { process.stdin.resume(); process.stdin.on("end", resolve); });
      const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).provider.hosted.options;
      const response = await fetch(config.baseURL + "/responses", {
        method: "POST", headers: { Authorization: "Bearer " + config.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "unapproved", input: ${mode === "too_large" ? '"x".repeat(1024 * 1024)' : '"Assigned task run-secret upstream-secret"'},
          metadata: { access_token: "unknown-credential" }, reasoning: "HIDDEN_REASONING" })
      });
      await response.text();
      console.log(JSON.stringify({ type: "error", error: { message: "Model refused request" } }));
      console.log(JSON.stringify({ type: "step_finish" }));
    `
    const session = new HostedHarnessSession({
      harness: "opencode", id: mode, cwd: process.cwd(), env: { PAPERCLIP_API_KEY: "run-secret" }, instructions: "Policy", tools: [],
      modelConfig: { endpoint, model: "deployment", getAccessToken: async () => "upstream-secret" },
      captureFailedPrompt: mode !== "disabled",
      prepare: async () => ({ harness: "opencode", command: "trusted", version: "2.2.5-beta.2" }),
      spawnProcess: (_command, _args, options) => spawn(process.execPath, ["--input-type=module", "-e", script], options),
    })
    t.after(() => session.dispose())
    const logs = []
    session.on("output", event => logs.push(event.data))
    const result = await session.write("Task")
    assert.equal(result.exitCode, 1)
    assert.equal(result.error, "Hosted model request failed (HTTP 403)")
    assert.equal(result.modelFailure.code, "http_403")
    assert.equal(result.modelFailure.httpStatus, 403)
    assert.equal(result.modelFailure.requestId, "model-request-1")
    assert.ok(!JSON.stringify(result).includes("requestBody"))
    if (mode === "disabled") assert.equal(result.promptEvidence, undefined)
    else if (mode === "too_large") assert.deepEqual(result.promptEvidence, { status: "too_large" })
    else {
      assert.equal(JSON.parse(result.promptEvidence.requestBody).model, "deployment")
      assert.ok(result.promptEvidence.requestBody.includes("Assigned task"))
    }
    for (const secret of ["run-secret", "upstream-secret", "unknown-credential", "HIDDEN_REASONING"]) {
      assert.ok(!JSON.stringify({ logs, evidence: result.promptEvidence }).includes(secret), `${mode}: ${secret}`)
    }
  }
})

test("large repeated model diagnostics are explicitly truncated without failing the assignment", async t => {
  const fetchOriginal = globalThis.fetch
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (!String(url).startsWith("https://model.example")) return fetchOriginal(url, options)
    return new Response('{"output":[]}')
  })
  const session = new HostedHarnessSession({
    harness: "opencode", id: "run", cwd: process.cwd(), env: {}, instructions: "Policy", tools: [],
    modelConfig: { endpoint, model: "deployment", getAccessToken: async () => "upstream-secret" },
    prepare: async () => ({ harness: "opencode", command: "trusted", version: "2.2.5-beta.2" }),
    spawnProcess: (_command, _args, options) => spawn(process.execPath, ["--input-type=module", "-e", `
      await new Promise(resolve => { process.stdin.resume(); process.stdin.on("end", resolve); });
      const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).provider.hosted.options;
      for (let i = 0; i < 30; i++) {
        const response = await fetch(config.baseURL + "/responses", {
          method: "POST", headers: { Authorization: "Bearer " + config.apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({ input: "x".repeat(40000) })
        });
        await response.text();
      }
      console.log(JSON.stringify({ type: "step_finish" }));
    `], options),
  })
  t.after(() => session.dispose())
  const diagnostics = []
  session.on("output", event => { if (event.stream === "command") diagnostics.push(event.data) })
  assert.deepEqual(await session.write("Task"), { exitCode: 0 })
  assert.ok(diagnostics.join("").includes("[message truncated]"))
  assert.equal(diagnostics.filter(data => data.includes("[Hosted diagnostic log limit reached]")).length, 1)
  assert.ok(Buffer.byteLength(diagnostics.join("")) <= 512 * 1024 + 100)
})

test("trusted tool errors produce a correlated result without becoming a model failure", async t => {
  const controller = new AbortController()
  const events = []
  const bridge = await startHostedHarnessBridge({
    endpoint, model: "deployment", signal: controller.signal, getAccessToken: async () => "unused",
    onError: message => assert.fail(message), onToolEvent: event => events.push(event),
    tools: [{ name: "provider_read", parameters: {}, execute: async () => { throw new Error("Read refused") } }],
  })
  t.after(async () => { controller.abort(); await bridge.close() })
  const result = await (await fetch(`${bridge.baseUrl}/mcp`, {
    method: "POST", headers: { Authorization: `Bearer ${bridge.secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "call-failed", method: "tools/call", params: { name: "provider_read", arguments: {} } }),
  })).json()
  assert.equal(result.result.isError, true)
  assert.deepEqual(events.map(event => [event.id, event.phase]), [["call-failed", "start"], ["call-failed", "end"]])
  assert.equal(events[1].error, "Read refused")
})

for (const harness of ["opencode", "pi"]) {
  test(`${harness} records trusted tool failures before the bridge is reached`, async t => {
    const events = harness === "pi" ? [
      { type: "tool_execution_start", toolCallId: "refused", toolName: "provider_read", args: { route: "approved" } },
      { type: "tool_execution_end", toolCallId: "refused", toolName: "provider_read", isError: true, durationMs: 17,
        result: { content: [{ type: "text", text: "Permission refused" }] } },
      { type: "agent_end" },
    ] : [
      { type: "tool_start", part: { id: "refused", tool: "hosted_provider_read", state: { input: { route: "approved" } } } },
      { type: "tool_use", part: { id: "refused", tool: "hosted_provider_read",
        state: { error: "Permission refused", time: { start: 10, end: 27 } } } },
      { type: "step_finish" },
    ]
    const session = new HostedHarnessSession({
      harness, id: "run", cwd: process.cwd(), env: {}, instructions: "Policy",
      tools: [{ name: "provider_read", parameters: {}, execute: async () => assert.fail("Bridge must not be reached") }],
      modelConfig: { endpoint, model: "deployment", getAccessToken: async () => "unused" },
      prepare: async () => ({ harness, command: "trusted", version: "1.0.0" }),
      spawnProcess: (_command, _args, options) => spawn(process.execPath, ["-e",
        `${JSON.stringify(events)}.forEach(event => console.log(JSON.stringify(event)))`], options),
    })
    t.after(() => session.dispose())
    const activities = []
    session.on("activity", event => activities.push(event))
    assert.deepEqual(await session.write("Task"), { exitCode: 0 })
    assert.deepEqual(activities.filter(event => event.target === "refused").map(event => event.kind), ["model_action", "error"])
    assert.ok(activities.some(event => event.kind === "error" && /Permission refused/.test(event.summary) && /17 ms/.test(event.summary)))
  })
}

test("Pi treats terminal model errors as failures even when the process exits zero", async t => {
  const session = new HostedHarnessSession({
    harness: "pi", id: "run", cwd: process.cwd(), env: {}, instructions: "Policy", tools: [],
    modelConfig: { endpoint, model: "deployment", getAccessToken: async () => "token" },
    prepare: async () => ({ harness: "pi", command: "trusted", version: "1.4.0-beta.1" }),
    spawnProcess: (_command, _args, options) => spawn(process.execPath, ["-e",
      'console.log(JSON.stringify({type:"agent_end",messages:[{role:"assistant",stopReason:"error",errorMessage:"Provider rejected request"}]}))'], options),
  })
  t.after(() => session.dispose())
  const result = await session.write("Task")
  assert.equal(result.exitCode, 1)
  assert.equal(result.error, "Provider rejected request")
  assert.equal(result.modelFailure.code, "harness_model_error")
})

test("cancelling an external harness waits for process termination and never falls back", async t => {
  const session = new HostedHarnessSession({
    harness: "opencode", id: "run", cwd: process.cwd(), env: {}, instructions: "Policy", tools: [],
    modelConfig: { endpoint, model: "deployment", getAccessToken: async () => "token" },
    prepare: async () => ({ harness: "opencode", command: "trusted", version: "2.2.5-beta.1" }),
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
      prepare: async () => ({ harness: "opencode", command: "trusted", version: "2.2.5-beta.1" }),
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
  let codeMode = false
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (!String(url).startsWith("https://model.example")) return fetchOriginal(url, options)
    const input = JSON.parse(options.body)
    const directTool = input.tools?.find(tool => tool.name.endsWith("provider_read"))
    const tool = directTool ?? input.tools?.find(tool => tool.name === "execute")
    const respondWithText = toolCalled || !input.tools?.length
    if (!respondWithText) assert.ok(tool, "The real harness must expose the trusted worker tool")
    if (tool) requested = true
    if (!respondWithText && !directTool) codeMode = true
    const message = respondWithText ?
      { id: "msg_smoke", type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "READY", annotations: [] }] } :
      { id: "fc_smoke", type: "function_call", call_id: "call_smoke", name: tool.name,
        status: "completed", arguments: JSON.stringify(directTool ? { route: "approved" }
          : { code: 'return await tools.hosted.provider_read({route:"approved"})' }) }
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
    prepare: async () => ({ harness, command: "trusted", version: harness === "pi" ? "1.4.0-beta.1" : "2.2.5-beta.2" }),
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
  const activities = []
  session.on("output", event => output.push(event.data))
  session.on("activity", event => activities.push(event))
  const result = await session.write("Reply READY.")
  assert.equal(result.exitCode, 0, `${result.error ?? ""}\n${output.join("")}`)
  assert.ok(requested)
  assert.ok(toolCalled)
  assert.ok(output.join("").includes("READY"))
  assert.deepEqual(activities.filter(event => event.action === "provider_read").map(event => event.kind), ["model_action", "tool_result"])
  assert.ok(activities.some(event => event.action === "model_request"))
  if (codeMode) assert.deepEqual(activities.filter(event => event.action === "execute").map(event => event.kind), ["model_action", "tool_result"])
})
}
