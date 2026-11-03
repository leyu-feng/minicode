import assert from "node:assert/strict"
import test from "node:test"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createServer } from "node:http"
import { once } from "node:events"
import { HostedHarnessSession } from "../server/hosted-harness-session.js"
import { startHostedHarnessBridge } from "../server/hosted-harness-bridge.js"
import { createHostedHarnessWorkspaceTools } from "../server/agent-session.js"
import { createPaperclipTaskTools } from "../server/paperclip-task-tools.js"

const endpoint = "https://model.example/openai/v1/responses"

test("native workspace tools edit files explicitly and strip inherited credentials from shell execution", async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "native-tools-"))
  t.after(() => fs.rm(cwd, { recursive: true, force: true }))
  const tools = Object.fromEntries(createHostedHarnessWorkspaceTools({ cwd, env: {
    ...process.env, GH_TOKEN: "private-token", GITHUB_TOKEN: "private-token", COPILOT_GITHUB_TOKEN: "private-token",
    ANTHROPIC_AUTH_TOKEN: "private-token", AZURE_CLIENT_SECRET: "private-token", IDENTITY_HEADER: "private-token",
    WORKSPACE_TEST_FLAG: "retained",
  } }).map(tool => [tool.name, tool]))
  const context = { signal: new AbortController().signal }
  await tools.write_file.execute({ path: "created.txt", content: "original" }, context)
  await tools.edit_file.execute({ path: "created.txt", find: "original", replace: "updated" }, context)
  assert.equal(await fs.readFile(path.join(cwd, "created.txt"), "utf8"), "updated")
  await assert.rejects(tools.write_file.execute({ path: "created.txt" }, context), /content must be a string/)
  await assert.rejects(tools.edit_file.execute({ path: "created.txt", find: "updated" }, context), /content must be a string/)
  assert.equal(await fs.readFile(path.join(cwd, "created.txt"), "utf8"), "updated")
  const result = await tools.run_shell.execute({ command: `"${process.execPath}" -e "console.log(process.env.WORKSPACE_TEST_FLAG, Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.COPILOT_GITHUB_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN || process.env.AZURE_CLIENT_SECRET || process.env.IDENTITY_HEADER))"` }, context)
  assert.ok(result.includes("retained false"), result)
  assert.ok(!result.includes("private-token"))
})

for (const harness of ["claudecode", "copilotcli"]) {
  const command = process.env[`MINICODE_${harness.toUpperCase()}_COMMAND`]
  test(`installed ${harness} completes an explicitly permitted MCP tool call with an offline model`, { skip: !command }, async t => {
    let toolCalled = false
    const issue = { id: "assigned", companyId: "company", assigneeAgentId: "agent", status: "in_progress" }
    const originalFetch = globalThis.fetch
    t.mock.method(globalThis, "fetch", async (url, options) => {
      if (!String(url).startsWith("https://paperclip.example/api/")) return originalFetch(url, options)
      assert.equal(options.headers.Authorization, "Bearer private-paperclip-token")
      assert.equal(options.headers["X-Paperclip-Run-Id"], "native-run")
      if (options.method === "PATCH") {
        assert.deepEqual(JSON.parse(options.body), { status: "done", comment: "NATIVE_SAVED" })
        issue.status = "done"
        toolCalled = true
      }
      return Response.json(issue)
    })
    let sawAssignment = false
    let requestCount = 0
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), `native-${harness}-`))
    t.after(() => fs.rm(cwd, { recursive: true, force: true }))
    const output = []
    const requests = []
    const server = createServer((request, response) => {
      void (async () => {
        let body = ""
        for await (const chunk of request) body += chunk
        const input = JSON.parse(body)
        if (++requestCount > 12) throw new Error("Unexpected native model retry loop")
        requests.push({ path: request.url, tools: (input.tools ?? []).map(tool => tool.name ?? tool.function?.name) })
        if (JSON.stringify(input.messages).includes("NATIVE_ASSIGNMENT")) sawAssignment = true
        if (request.url.endsWith("/count_tokens")) {
          response.writeHead(200, { "Content-Type": "application/json" }).end('{"input_tokens":100}')
          return
        }
        const tool = input.tools?.find(tool => /paperclip_update_issue/.test(tool.name ?? tool.function?.name))
        if (!tool && !toolCalled && input.tools?.length) throw new Error(`Missing approved tool: ${JSON.stringify(requests.at(-1))}`)
        const name = tool?.name ?? tool?.function?.name
        const call = Boolean(name && !toolCalled)
        if (harness === "copilotcli") {
          const message = call ? { role: "assistant", content: null,
            tool_calls: [{ id: "approved-call", type: "function", function: { name, arguments: '{"status":"done","comment":"NATIVE_SAVED"}' } }] }
            : { role: "assistant", content: "NATIVE_DONE" }
          const chunk = { id: "offline", object: input.stream ? "chat.completion.chunk" : "chat.completion",
            created: 1, model: input.model, choices: [{ index: 0,
              ...(input.stream ? { delta: { ...message, ...(call ? { tool_calls: message.tool_calls.map(item => ({ index: 0, ...item })) } : {}) } }
                : { message }),
              finish_reason: call ? "tool_calls" : "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }
          response.writeHead(200, { "Content-Type": input.stream ? "text/event-stream" : "application/json" })
          response.end(input.stream ? `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n` : JSON.stringify(chunk))
        } else {
          const content = call ? { type: "tool_use", id: "approved-call", name, input: { status: "done", comment: "NATIVE_SAVED" } }
            : { type: "text", text: "NATIVE_DONE" }
          const message = { id: "offline", type: "message", role: "assistant", model: input.model,
            content: [content], stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null,
            usage: { input_tokens: 100, output_tokens: 10 } }
          response.writeHead(200, { "Content-Type": input.stream ? "text/event-stream" : "application/json" })
          if (!input.stream) { response.end(JSON.stringify(message)); return }
          const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
          event("message_start", { message: { ...message, content: [], stop_reason: null } })
          event("content_block_start", { index: 0, content_block: call ? { ...content, input: {} } : { type: "text", text: "" } })
          event("content_block_delta", { index: 0, delta: call
            ? { type: "input_json_delta", partial_json: '{"status":"done","comment":"NATIVE_SAVED"}' }
            : { type: "text_delta", text: "NATIVE_DONE" } })
          event("content_block_stop", { index: 0 })
          event("message_delta", { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } })
          event("message_stop", {})
          response.end()
        }
      })().catch(error => {
        output.push(error.message)
        response.writeHead(500, { "Content-Type": "application/json" }).end('{"error":{"message":"Offline fixture failed","type":"api_error"}}')
      })
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    t.after(async () => { const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed })
    const baseUrl = `http://127.0.0.1:${server.address().port}`
    const session = new HostedHarnessSession({
      harness, id: "native-run", cwd, env: {}, instructions: "Use the supplied paperclip_update_issue tool to save completion with comment NATIVE_SAVED, then report NATIVE_DONE.",
      harnessModel: harness === "copilotcli" ? "gpt-4.1" : "claude-sonnet-4-20250514",
      githubCredential: { accessToken: "offline-fixture-token", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), runId: "native-run" },
      tools: createPaperclipTaskTools({ apiUrl: "https://paperclip.example", authToken: "private-paperclip-token",
        runId: "native-run", issueId: issue.id, agentId: issue.assigneeAgentId, companyId: issue.companyId }),
      modelConfig: { endpoint, model: "unused" },
      prepare: async () => ({ harness, command, version: "offline-fixture" }),
      spawnProcess: (file, args, options) => spawn(file, args, { ...options, env: { ...options.env,
        ...(harness === "copilotcli" ? {
          COPILOT_PROVIDER_BASE_URL: `${baseUrl}/v1`, COPILOT_PROVIDER_TYPE: "openai", COPILOT_PROVIDER_WIRE_API: "completions",
          COPILOT_PROVIDER_API_KEY: "offline-key",
        } : { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: "offline-key", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }),
      } }),
    })
    const timeout = setTimeout(() => session.interrupt(), 45_000)
    t.after(async () => { clearTimeout(timeout); await session.dispose() })
    session.on("output", event => output.push(event.data))
    const result = await session.write("NATIVE_ASSIGNMENT: Save completion using paperclip_update_issue, then reply NATIVE_DONE.")
    assert.equal(result.exitCode, 0, `${result.error ?? ""}\n${output.join("")}\n${JSON.stringify(requests)}`)
    assert.ok(sawAssignment, `The real CLI must receive the assignment over stdin\n${output.join("")}\n${JSON.stringify(requests)}`)
    assert.ok(toolCalled, `The real CLI must invoke the permitted MCP tool: ${output.join("")}`)
    assert.ok(output.join("").includes("NATIVE_DONE"))
    assert.equal(result.summary, "NATIVE_DONE")
    assert.equal(issue.status, "done")
    assert.ok(!output.join("").includes("private-paperclip-token"))
  })
}

for (const harness of ["claudecode", "copilotcli"]) {
  test(`${harness} isolates assignment authentication and uses only explicitly provided tools`, async t => {
    let invocation
    let mcpPath
    const logs = []
    const calls = []
    const script = `
      import fs from "node:fs/promises";
      let input = "";
      for await (const chunk of process.stdin) input += chunk;
      if (!input.includes("Assigned task")) throw new Error("Missing assignment");
      if (process.env.COPILOT_GITHUB_TOKEN !== "private-github-token") throw new Error("Missing assignment token");
      if (process.env.GH_TOKEN || process.env.IDENTITY_ENDPOINT) throw new Error("Leaked inherited credential");
      const config = JSON.parse(await fs.readFile(process.env.TEST_MCP_PATH, "utf8")).mcpServers.hosted;
      const response = await fetch(config.url, {
        method: "POST", headers: { ...config.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
          params: { name: "provider_read", arguments: { route: "approved" } } })
      });
      if (!response.ok || (await response.json()).result.isError) throw new Error("Trusted MCP call failed");
      console.log(JSON.stringify({ type: "result", subtype: "success", result: "Finished private-github-token" }));
    `
    const session = new HostedHarnessSession({
      harness, id: "run", cwd: process.cwd(), instructions: "Trusted instructions", harnessModel: "gpt-4.1",
      env: { GH_TOKEN: "inherited-user-token", IDENTITY_ENDPOINT: "private" },
      githubCredential: { accessToken: "private-github-token", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), runId: "run" },
      tools: [{ name: "provider_read", description: "Trusted read", parameters: { type: "object" },
        execute: async input => { calls.push(input); return "result" } }],
      modelConfig: { endpoint, model: "deployment", getAccessToken: async () => { throw new Error("Azure model auth must not run") } },
      prepare: async () => ({ harness, command: "trusted-shim", version: "2.1.0" }),
      spawnProcess: (command, args, options) => {
        invocation = { command, args, options }
        const index = args.indexOf(harness === "claudecode" ? "--mcp-config" : "--additional-mcp-config")
        mcpPath = args[index + 1].replace(/^@/, "")
        return spawn(process.execPath, ["--input-type=module", "-e", script],
          { ...options, env: { ...options.env, TEST_MCP_PATH: mcpPath } })
      },
    })
    t.after(() => session.dispose())
    session.on("output", event => logs.push(event.data))
    session.on("activity", event => logs.push(JSON.stringify(event)))
    assert.deepEqual(await session.write("Assigned task"), { exitCode: 0, summary: "Finished [redacted]" })
    assert.deepEqual(calls, [{ route: "approved" }])
    assert.ok(!JSON.stringify(invocation.args).includes("private-github-token"))
    assert.ok(!logs.join("").includes("private-github-token"))
    for (const flag of ["--allow-all", "--allow-all-tools", "--yolo", "--dangerously-skip-permissions", "--trust-folder"]) {
      assert.ok(!invocation.args.includes(flag))
    }
    assert.equal(invocation.options.env.HOME, invocation.options.env.USERPROFILE)
    if (harness === "claudecode") assert.equal(invocation.options.env.ANTHROPIC_MODEL, "gpt-4.1")
    await assert.rejects(fs.stat(mcpPath), { code: "ENOENT" })
  })

  test(`${harness} fails before preparation when assignment GitHub login is missing`, async () => {
    const session = new HostedHarnessSession({
      harness, id: "run", cwd: process.cwd(), env: {}, instructions: "Policy", tools: [],
      modelConfig: { endpoint, model: "deployment" },
      prepare: () => { throw new Error("Preparation must not run") },
    })
    assert.deepEqual(await session.write("Task"), {
      exitCode: 1, error: "The native harness requires a valid assignment-scoped GitHub access token",
    })
  })
}

test("Claude defaults to Sonnet 5 rather than inheriting the worker's unrelated model", async t => {
  const session = new HostedHarnessSession({
    harness: "claudecode", id: "run", cwd: process.cwd(), env: {}, instructions: "Policy", tools: [],
    githubCredential: { accessToken: "private-agent-token", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), runId: "run" },
    modelConfig: { endpoint, model: "gpt-5.6-sol" },
    prepare: async () => ({ harness: "claudecode", command: "trusted-shim", version: "2.1.0" }),
    spawnProcess: (_command, args, options) => {
      assert.equal(options.env.ANTHROPIC_MODEL, "claude-sonnet-5")
      assert.equal(args[args.indexOf("--model") + 1], "claude-sonnet-5")
      return spawn(process.execPath, ["--input-type=module", "-e",
        'for await (const chunk of process.stdin) {} console.log(JSON.stringify({ type: "result", subtype: "success", result: "Done" }))'],
      options)
    },
  })
  t.after(() => session.dispose())
  assert.deepEqual(await session.write("Task"), { exitCode: 0, summary: "Done" })
})

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

for (const scenario of [
  { name: "completed Responses stream", frame: 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n', success: true },
  { name: "split CRLF completion", frame: 'data:\r\n\r\n: caf\u00e9\r\ndata: {"type":"response.completed",\r\ndata: "response":{"status":"completed"}}\r\n\r\n', split: true, success: true },
  { name: "completed Chat Completions stream", route: "chat/completions", frame: "data: [DONE]\n\n", success: true },
  { name: "unfinished Responses stream", frame: 'data: {"type":"response.output_text.delta","delta":"response.completed"}\n\n' },
  { name: "unsuccessful Responses completion", frame: 'data: {"type":"response.completed","response":{"status":"incomplete"}}\n\n' },
  { name: "unterminated completion event", frame: 'data: {"type":"response.completed","response":{"status":"completed"}}\n' },
  { name: "malformed stream before completion", frame: 'data: {invalid}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n' },
  { name: "failed Chat Completions stream", route: "chat/completions", frame: 'data: {"error":{"message":"Request failed"}}\n\ndata: [DONE]\n\n' },
  { name: "non-SSE response", frame: 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n', contentType: "application/json" },
]) {
  test(`client closing ${scenario.name} preserves the correct assignment outcome`, { timeout: 10000 }, async t => {
    const fetchOriginal = globalThis.fetch
    let requests = 0
    let cancelled
    const streamCancelled = new Promise(resolve => { cancelled = resolve })
    t.mock.method(globalThis, "fetch", async (url, options) => {
      if (!String(url).startsWith("https://model.example")) return fetchOriginal(url, options)
      if (++requests > 1) return new Response('{"output":[]}')
      return new Response(new ReadableStream({
        start(controller) {
          const bytes = Buffer.from(scenario.frame)
          if (scenario.split) {
            for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.subarray(i, i + 1))
          } else controller.enqueue(bytes)
        },
        cancel() { cancelled() },
      }), { headers: { "Content-Type": scenario.contentType ?? "text/event-stream" } })
    })
    let toolCalls = 0
    const session = new HostedHarnessSession({
      harness: "opencode", id: "stream-close", cwd: process.cwd(), env: {}, instructions: "Policy",
      tools: [{ name: "provider_read", description: "Offline read", parameters: { type: "object" },
        execute: async () => { await streamCancelled; toolCalls++; return "read result" } }],
      modelConfig: { endpoint, model: "deployment", getAccessToken: async () => "offline-fixture-token" },
      prepare: async () => ({ harness: "opencode", command: "trusted-shim", version: "2.2.5-beta.2" }),
      spawnProcess: (_command, _args, options) => spawn(process.execPath, ["--input-type=module", "-e", `
        for await (const chunk of process.stdin) {}
        const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).provider.hosted.options;
        const post = (route, input) => fetch(config.baseURL.replace(/\\/openai\\/v1$/, "") + route, {
          method: "POST", headers: { Authorization: "Bearer " + config.apiKey, "Content-Type": "application/json" },
          body: JSON.stringify(input)
        });
        console.log(JSON.stringify({ type: "step_start" }));
        const response = await post("/openai/v1/${scenario.route ?? "responses"}", { stream: true, input: "Offline request" });
        const reader = response.body.getReader();
        const received = [];
        let bytes = 0;
        while (bytes < ${Buffer.byteLength(scenario.frame)}) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("Expected an open upstream stream");
          bytes += chunk.value.length;
          received.push(Buffer.from(chunk.value));
        }
        if (Buffer.concat(received).toString("utf8") !== ${JSON.stringify(scenario.frame)}) throw new Error("Response bytes changed");
        await reader.cancel();
        const tool = await post("/mcp", {
          jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "provider_read", arguments: {} }
        });
        if ((await tool.json()).result.isError) throw new Error("Offline tool failed");
        console.log(JSON.stringify({ type: "step_finish" }));
        console.log(JSON.stringify({ type: "step_start" }));
        await (await post("/openai/v1/responses", { input: "Follow-up request" })).text();
        console.log(JSON.stringify({ type: "text", part: { text: "Finished" } }));
        console.log(JSON.stringify({ type: "step_finish" }));
      `], options),
    })
    const timeout = setTimeout(() => session.interrupt(), 8000)
    t.after(async () => { clearTimeout(timeout); await session.dispose() })
    const output = []
    session.on("output", event => output.push(event.data))
    const result = await session.write("Offline stream-close reproduction")
    assert.equal(requests, 2, output.join(""))
    assert.equal(toolCalls, 1)
    assert.ok(output.join("").includes("Finished"))
    if (scenario.success) assert.deepEqual(result, { exitCode: 0, summary: "Finished" })
    else {
      assert.equal(result.exitCode, 1)
      assert.equal(result.error, "Premature close")
      assert.equal(result.modelFailure.code, "ERR_STREAM_PREMATURE_CLOSE")
    }
  })
}

test("completed model streams still report upstream transport errors and assignment cancellation", { timeout: 10000 }, async t => {
  const fetchOriginal = globalThis.fetch
  for (const cancelled of [false, true]) {
    let upstream
    t.mock.method(globalThis, "fetch", async (url, options) => {
      if (!String(url).startsWith("https://model.example")) return fetchOriginal(url, options)
      return new Response(new ReadableStream({
        start(controller) {
          upstream = controller
          controller.enqueue(Buffer.from('data: {"type":"response.completed","response":{"status":"completed"}}\n\n'))
        },
      }), { headers: { "Content-Type": "text/event-stream" } })
    })
    const errors = []
    let report
    const reported = new Promise(resolve => { report = resolve })
    const controller = new AbortController()
    const bridge = await startHostedHarnessBridge({
      endpoint, model: "deployment", tools: [], signal: controller.signal, getAccessToken: async () => "offline-fixture-token",
      onError: (message, request) => { errors.push({ message, code: request?.code }); report() },
    })
    try {
      const response = await fetchOriginal(`${bridge.baseUrl}/openai/v1/responses`, {
        method: "POST", headers: { Authorization: `Bearer ${bridge.secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ stream: true, input: "Offline request" }),
      })
      const reader = response.body.getReader()
      assert.ok(new TextDecoder().decode((await reader.read()).value).includes("response.completed"))
      if (cancelled) controller.abort()
      else upstream.error(Object.assign(new Error("Upstream connection reset"), { code: "ECONNRESET" }))
      await assert.rejects(reader.read())
      await reported
      assert.equal(errors.length, 1)
      if (cancelled) assert.equal(errors[0].message, "Hosted harness cancelled")
      else assert.deepEqual(errors[0], { message: "Upstream connection reset", code: "ECONNRESET" })
    } finally {
      controller.abort()
      await bridge.close()
    }
  }
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
        console.log(JSON.stringify({ type: ${JSON.stringify(harness === "pi" ? "turn_start" : "step_start")} }));
        const model = await fetch(configuration.baseUrl + "/openai/v1/responses", {
          method: "POST", headers: { Authorization: "Bearer " + configuration.secret, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "unapproved", instructions: "Policy run-secret",
            metadata: { apiKey: "unregistered-credential" },
            input: [{ role: "user", content: "Task " + configuration.secret },
              { type: "reasoning", summary: [{ type: "summary_text", text: "HIDDEN_REASONING" }] }] })
        });
        if (!model.ok) throw new Error("Model bridge failed");
        await model.text();
        await (await fetch(configuration.baseUrl + "/openai/v1/responses", {
          method: "POST", headers: { Authorization: "Bearer " + configuration.secret, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "unapproved", input: "Auxiliary model request in the same round" })
        })).text();
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
        console.log(JSON.stringify({ type: ${JSON.stringify(harness === "pi" ? "turn_end" : "step_finish")} }));
        console.log(JSON.stringify({ type: ${JSON.stringify(harness === "pi" ? "turn_start" : "step_start")} }));
        await (await fetch(configuration.baseUrl + "/openai/v1/responses", {
          method: "POST", headers: { Authorization: "Bearer " + configuration.secret, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "unapproved", input: "Second round" })
        })).text();
        ${harness === "pi" ? `console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Finished" } }));
          console.log(JSON.stringify({ type: "turn_end" }));
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
    assert.deepEqual(await session.write("Assigned task\n"), { exitCode: 0, summary: "Finished" })
    assert.deepEqual(calls, [{ route: "approved" }])
    assert.equal(invocation.args.some(arg => arg.includes("Assigned task") || arg.includes("run-secret")), false)
    assert.ok(output.join("").includes("Finished"))
    assert.equal(modelRequests[0].model, "deployment")
    assert.equal(modelRequests[0].metadata.apiKey, "unregistered-credential")
    assert.ok(activities.some(event => event.kind === "prompt" && event.summary.includes("Assigned task")))
    assert.ok(activities.every(event => ["prompt", "model_action", "tool_result", "error"].includes(event.kind)))
    assert.equal(activities.find(event => event.kind === "prompt").turn, undefined)
    assert.ok(activities.some(event => event.action === "model_request" && event.turn === 1))
    assert.deepEqual(activities.filter(event => event.action?.startsWith("round_")).map(event => [event.action, event.turn]),
      [["round_start", 1], ["round_end", 1], ["round_start", 2], ["round_end", 2]])
    assert.deepEqual(activities.filter(event => event.action === "model_request").map(event => event.turn), [1, 1, 2])
    assert.deepEqual(activities.filter(event => event.action === "provider_read").map(event => event.kind), ["model_action", "tool_result"])
    assert.deepEqual(activities.filter(event => event.target === "native-1").map(event => event.kind), ["model_action", "tool_result"])
    assert.ok(activities.some(event => event.kind === "tool_result" && event.summary.includes("shell result")))
    assert.ok(events.some(event => event.stream === "command" && event.data.includes("# system instructions")))
    assert.ok(events.some(event => event.stream === "command" && event.data.includes("# model request 1")))
    const logs = JSON.stringify({ events, activities })
    for (const secret of ["run-secret", "private-token", "unregistered-credential", "HIDDEN_REASONING"]) assert.ok(!logs.includes(secret), secret)
  })
}

for (const harness of ["opencode", "pi"]) {
  for (const overLimit of [false, true]) {
    test(`${harness} ${overLimit ? "rejects combined output above 4 MiB" : "accepts raw protocol output between 2 and 4 MiB"}`, async t => {
      const session = new HostedHarnessSession({
        harness, id: "output-budget", cwd: process.cwd(), env: {}, instructions: "Policy", tools: [],
        modelConfig: { endpoint, model: "deployment", getAccessToken: async () => "unused" },
        prepare: async () => ({ harness, command: "trusted-shim", version: "offline-fixture" }),
        spawnProcess: (_command, _args, options) => spawn(process.execPath, ["--input-type=module", "-e", `
          import readline from "node:readline";
          const lines = readline.createInterface({ input: process.stdin });
          await new Promise(resolve => lines.once("line", resolve));
          lines.close();
          process.stdin.pause();
          const line = JSON.stringify({ type: "diagnostic", data: "x".repeat(16000) }) + "\\n";
          for (let bytes = 0; bytes < 3 * 1024 * 1024; bytes += line.length) {
            await new Promise(resolve => process.stdout.write(line, resolve));
          }
          ${overLimit ? `for (let bytes = 0; bytes < 2 * 1024 * 1024; bytes += 16000) {
            await new Promise(resolve => process.stderr.write("x".repeat(16000), resolve));
          }` : ""}
          ${harness === "pi" ? `
            console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Finished" } }));
            console.log(JSON.stringify({ type: "agent_end", messages: [] }));
          ` : `
            console.log(JSON.stringify({ type: "text", part: { text: "Finished" } }));
            console.log(JSON.stringify({ type: "step_finish" }));
          `}
        `], options),
      })
      t.after(() => session.dispose())
      const result = await session.write("Offline output-budget reproduction")
      if (overLimit) assert.deepEqual(result, { exitCode: 1, error: "Hosted harness output exceeded its limit" })
      else assert.deepEqual(result, { exitCode: 0, summary: "Finished" })
    })
  }
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
  const starts = activities.filter(event => event.action === "round_start").map(event => event.turn)
  assert.ok(starts.length >= 2, "The real harness must report both tool and final-response rounds")
  assert.deepEqual(activities.filter(event => event.action === "round_end").map(event => event.turn), starts)
  if (codeMode) assert.deepEqual(activities.filter(event => event.action === "execute").map(event => event.kind), ["model_action", "tool_result"])
})
}
