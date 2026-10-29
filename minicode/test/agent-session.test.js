import assert from "node:assert/strict"
import childProcess from "node:child_process"
import { EventEmitter } from "node:events"
import { fileURLToPath } from "node:url"
import test, { afterEach } from "node:test"
import { AgentSession, callModelOnce } from "../server/agent-session.js"
import { ShellSession } from "../server/shell-session.js"

const originalFetch = globalThis.fetch

function shellProcessFixture() {
  const proc = new EventEmitter()
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.stdin = new EventEmitter()
  proc.stdin.destroy = () => {}
  proc.stdin.end = () => {}
  proc.stdin.write = script => {
    const marker = script.match(/__MINICODE_[a-f0-9]+_DONE__:/)?.[0]
    if (marker) queueMicrotask(() => {
      proc.stdout.emit("data", `${marker}0:END__`)
      proc.stderr.emit("data", `${marker}0:END__`)
    })
  }
  if (process.platform !== "win32") queueMicrotask(() => proc.emit("close", 0))
  return proc
}

for (const api of ["responses", "chat-completions"]) {
  test(`${api} requests include Git-scoped discovery guidance alongside worker instructions`, async t => {
    let request
    globalThis.fetch = async (_url, options) => {
      request = JSON.parse(options.body)
      const content = JSON.stringify({ type: "final", message: "done" })
      return Response.json(api === "responses" ? { output_text: content } : { choices: [{ message: { content } }] })
    }
    const instructions = "Inspect the assigned service before making changes."
    const session = new AgentSession({ id: "git-discovery", cwd: process.cwd(), instructions })
    session.config = { api, endpoint: "https://provider.test", apiKey: "fixture", model: "fixture" }
    t.after(() => session.dispose())
    assert.equal((await session.write("Find the implementation")).exitCode, 0)
    const guidance = api === "responses" ? request.instructions : request.messages[0].content
    assert.match(guidance, /only Git-managed files with git ls-files -- <task-relevant pathspecs>/)
    assert.match(guidance, /Search tracked file contents with git grep/)
    assert.match(guidance, /Do not map a repository with Get-ChildItem/)
    assert.match(guidance, /If Git is unavailable or the directory is not in a Git worktree/)
    assert.match(guidance, /do not silently fall back to recursive filesystem scans/)
    assert.ok(guidance.includes(instructions))
  })
}

test("model command aliases list and switch session models without losing context", async t => {
  let catalogs = 0
  const config = { api: "responses", endpoint: "https://provider.test/responses", model: "original", apiKey: "fixture" }
  const models = [
    { id: "gpt-6.1-sol", api: "responses", endpoint: config.endpoint },
    { id: "kimi-k3", api: "chat-completions", endpoint: "https://provider.test/chat/completions" },
  ]
  const session = new AgentSession({ id: "models", cwd: process.cwd(),
    modelConfigProvider: async () => config,
    modelCatalogProvider: async () => { catalogs++; return models },
  })
  const other = new AgentSession({ id: "other", cwd: process.cwd() })
  other.config = config
  t.after(() => { session.dispose(); other.dispose() })
  const output = []
  session.on("output", event => output.push(event.data))
  const history = [{ role: "user", content: "Remember the conversation" }]
  session.messages.push(...history)
  let done = 0
  session.on("done", () => done++)
  const modelEvents = []
  session.on("model", event => modelEvents.push(event.model))

  for (const command of ["/model", "/models"]) {
    assert.equal((await session.write(command)).exitCode, 0)
    assert.equal(output.at(-1), "01 gpt-6.1-sol\r\n02 kimi-k3\r\n")
  }
  for (const [command, expected] of [
    ["/model 02", models[1]], ["/models 01", models[0]],
    ["/model kimi-k3", models[1]], ["/models gpt-6.1-sol", models[0]],
  ]) {
    assert.equal((await session.write(command)).exitCode, 0)
    assert.equal(session.config.model, expected.id)
    assert.equal(session.config.api, expected.api)
    assert.equal(session.config.endpoint, expected.endpoint)
  }
  assert.equal(catalogs, 2)
  assert.equal(done, 6)
  assert.deepEqual(session.messages, history)
  assert.equal(other.config.model, "original")
  assert.deepEqual(modelEvents, ["original", "kimi-k3", "gpt-6.1-sol", "kimi-k3", "gpt-6.1-sol"])
  await session.write("/model")
  assert.equal(output.at(-1), "01 gpt-6.1-sol (current)\r\n02 kimi-k3\r\n")
  await session.write("/models 02")
  await session.write("/models")
  assert.equal(output.at(-1), "01 gpt-6.1-sol\r\n02 kimi-k3 (current)\r\n")
  await session.write("/model 01")

  const requests = []
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body))
    return Response.json({ output_text: JSON.stringify({ type: "final", message: "done" }) })
  }
  assert.equal((await session.write("Continue")).exitCode, 0)
  assert.equal(requests[0].model, "gpt-6.1-sol")
  assert.equal(requests[0].input[0].content, history[0].content)
})

test("model selection before listing discovers models and rejects invalid selections", async t => {
  const session = new AgentSession({ id: "model-selection", cwd: process.cwd(),
    modelConfigProvider: async () => ({ model: "original", api: "responses", endpoint: "https://provider.test/responses" }),
    modelCatalogProvider: async () => [{ id: "kimi-k3", api: "responses", endpoint: "https://provider.test/responses" }],
  })
  t.after(() => session.dispose())
  const output = []
  session.on("output", event => output.push(event))
  assert.equal((await session.write("/model kimi-k3")).exitCode, 0)
  const selected = session.config
  for (const command of ["/model 00", "/models 02", "/model 1.5", "/model missing"]) {
    assert.equal((await session.write(command)).exitCode, 1)
    assert.equal(session.config, selected)
    assert.equal(output.at(-1).stream, "stderr")
    assert.match(output.at(-1).data, /Unknown model/)
  }
  assert.deepEqual(session.messages, [])
})

test("model discovery failures and interrupted listings leave session state unchanged", async t => {
  let finish
  const session = new AgentSession({ id: "model-errors", cwd: process.cwd(),
    modelConfigProvider: async () => ({ model: "original" }),
    modelCatalogProvider: async () => { throw new Error("Provider unavailable") },
  })
  t.after(() => session.dispose())
  assert.equal((await session.write("/models")).error, "Provider unavailable")
  assert.equal(session.config.model, "original")
  session.modelCatalogProvider = () => new Promise(resolve => { finish = resolve })
  const listing = session.write("/model")
  session.interrupt()
  finish([{ id: "late", api: "responses", endpoint: "https://provider.test/responses" }])
  await listing
  assert.equal(session.availableModels, undefined)
  assert.equal(session.config.model, "original")
  assert.deepEqual(session.messages, [])
})

test("worker shell uses its selected Azure context instead of the model context", async t => {
  const actions = [{ type: "tool", command: "echo fixture" }, { type: "final", message: "done" }]
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify(actions.shift()) } }] })
  let shellEnv
  t.mock.method(childProcess, "spawn", (_file, _args, options) => {
    shellEnv = options.env
    return shellProcessFixture()
  })
  const session = new AgentSession({ id: "azure-context", cwd: process.cwd(),
    env: { AZURE_CONFIG_DIR: "inherited", OTHER_SETTING: "kept" }, toolAzureConfigDir: "resource-context" })
  t.after(() => session.dispose())
  session.config = { api: "chat-completions", endpoint: "https://example.test", apiKey: "fixture",
    model: "fixture", azureConfigDir: "model-context" }
  assert.equal((await session.write("Check context")).exitCode, 0)
  assert.equal(shellEnv.AZURE_CONFIG_DIR, "resource-context")
  assert.equal(shellEnv.OTHER_SETTING, "kept")
  assert.equal(session.config.azureConfigDir, "model-context")
})

test("without a tool override the model Azure context remains the shell default", async t => {
  const actions = [{ type: "tool", command: "echo fixture" }, { type: "final", message: "done" }]
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify(actions.shift()) } }] })
  let shellEnv
  t.mock.method(childProcess, "spawn", (_file, _args, options) => {
    shellEnv = options.env
    return shellProcessFixture()
  })
  const session = new AgentSession({ id: "azure-default", cwd: process.cwd(), env: { AZURE_CONFIG_DIR: "inherited" } })
  t.after(() => session.dispose())
  session.config = { api: "chat-completions", endpoint: "https://example.test", apiKey: "fixture",
    model: "fixture", azureConfigDir: "model-context" }
  assert.equal((await session.write("Check context")).exitCode, 0)
  assert.equal(shellEnv.AZURE_CONFIG_DIR, "model-context")
})

test("tool identity is sourced from the harness, not inherited environment", async t => {
  const outputs = []
  const actions = []
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify(actions.shift()) } }] })
  t.mock.method(childProcess, "spawn", (_file, _args, options) => {
    outputs.push(options.env)
    return shellProcessFixture()
  })
  const sessions = [
    new AgentSession({ id: "model-user", cwd: process.cwd(), env: { MINICODE_AGENT_USER_UPN: "spoof@example.com" } }),
    new AgentSession({ id: "worker-user", cwd: process.cwd(), signedInUpn: "worker@example.com" }),
    new AgentSession({ id: "no-user", cwd: process.cwd(), env: { minicode_agent_user_upn: "spoof@example.com" } }),
    new AgentSession({ id: "hosted", cwd: process.cwd(), signedInUpn: "" }),
  ]
  t.after(() => sessions.forEach(session => session.dispose()))
  for (const [index, session] of sessions.entries()) {
    session.config = { api: "chat-completions", endpoint: "https://example.test", apiKey: "fixture", model: "fixture",
      ...(index !== 2 ? { signedInUpn: "model@example.com" } : {}) }
    actions.push({ type: "tool", command: "echo fixture" }, { type: "final", message: "done" })
    assert.equal((await session.write("Check identity")).exitCode, 0)
  }
  assert.equal(outputs[0].MINICODE_AGENT_USER_UPN, "model@example.com")
  assert.equal(outputs[1].MINICODE_AGENT_USER_UPN, "worker@example.com")
  assert.equal(outputs[2].MINICODE_AGENT_USER_UPN, undefined)
  assert.equal(outputs[2].minicode_agent_user_upn, undefined)
  assert.equal(outputs[3].MINICODE_AGENT_USER_UPN, undefined)
})

test("secret store is opt-in for interactive sessions and inherited capabilities are stripped otherwise", async t => {
  const outputs = []
  const actions = []
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify(actions.shift()) } }] })
  t.mock.method(childProcess, "spawn", (_file, _args, options) => {
    outputs.push(options.env)
    return shellProcessFixture()
  })
  const inherited = { MINICODE_SECRET_STORE_PORT: "1234", MINICODE_SECRET_STORE_CAPABILITY: "inherited", OTHER_SETTING: "kept" }
  const sessions = [
    new AgentSession({ id: "worker", cwd: process.cwd(), env: inherited }),
    new AgentSession({ id: "interactive-1", cwd: process.cwd(), env: inherited, interactiveSecretStore: true }),
    new AgentSession({ id: "interactive-2", cwd: process.cwd(), env: inherited, interactiveSecretStore: true }),
  ]
  t.after(() => sessions.forEach(session => session.dispose()))
  for (const session of sessions) {
    session.config = { api: "chat-completions", endpoint: "https://example.test", apiKey: "fixture", model: "fixture" }
    actions.push({ type: "tool", command: "echo fixture" }, { type: "final", message: "done" })
    assert.equal((await session.write("Check store")).exitCode, 0)
  }
  assert.equal(outputs[0].MINICODE_SECRET_STORE_PORT, undefined)
  assert.equal(outputs[0].MINICODE_SECRET_STORE_CAPABILITY, undefined)
  assert.equal(outputs[0].OTHER_SETTING, "kept")
  assert.match(outputs[1].MINICODE_SECRET_STORE_CAPABILITY, /^[a-f0-9]{64}$/)
  assert.notEqual(outputs[1].MINICODE_SECRET_STORE_CAPABILITY, "inherited")
  assert.equal(outputs[1].MINICODE_SECRET_STORE_CAPABILITY, outputs[2].MINICODE_SECRET_STORE_CAPABILITY)
  assert.equal(outputs[1].MINICODE_SECRET_STORE_PORT, outputs[2].MINICODE_SECRET_STORE_PORT)
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("policy rejection returns safe structured failure metadata without retrying the rejected task", async t => {
  const requests = []
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body))
    return Response.json({ error: { code: "invalid_prompt", type: "invalid_request_error", message: "A private provider explanation" } },
      { status: 400, headers: { "x-request-id": "safe-request-id" } })
  }
  const session = new AgentSession({ id: "policy-evidence", cwd: process.cwd(), instructions: "Private system instructions" })
  t.after(() => session.dispose())
  session.config = { api: "responses", endpoint: "https://fixture.test", apiKey: "private-key", model: "gpt-5.6-sol" }
  const result = await session.write("Private original task")
  assert.equal(result.exitCode, 1)
  assert.equal(requests.length, 1)
  assert.equal(result.modelFailure.code, "invalid_prompt")
  assert.equal(result.modelFailure.httpStatus, 400)
  assert.equal(result.modelFailure.requestId, "safe-request-id")
  assert.equal(result.modelFailure.model, "gpt-5.6-sol")
  assert.ok(result.modelFailure.contextCharacters > "Private original task".length)
  assert.ok(!Number.isNaN(Date.parse(result.modelFailure.occurredAt)))
  assert.doesNotMatch(JSON.stringify(result.modelFailure), /Private|private-key|explanation/)
})

test("structured failure identifiers cannot retain a reflected model credential", async t => {
  globalThis.fetch = async () => Response.json({ error: { code: "reflected-private-key" } },
    { status: 400, headers: { "x-request-id": "reflected-private-key" } })
  const session = new AgentSession({ id: "credential-evidence", cwd: process.cwd() })
  t.after(() => session.dispose())
  session.config = { api: "responses", endpoint: "https://fixture.test", apiKey: "private-key", model: "gpt-6-luna" }
  const result = await session.write("Investigate")
  assert.equal(result.modelFailure.code, "model_request_failed")
  assert.equal(result.modelFailure.requestId, undefined)
  assert.doesNotMatch(JSON.stringify(result.modelFailure), /private-key/)
})

test("failed prompt capture retains only the terminal request body, redacts credentials, and stays out of normal result serialization", async t => {
  const requests = []
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body))
    if (requests.length === 1) return Response.json({ output_text: '{"type":"tool","name":"read_fixture","arguments":{}}' })
    return Response.json({ error: { code: "invalid_prompt" } }, { status: 400 })
  }
  const session = new AgentSession({
    id: "failed-request", cwd: process.cwd(), captureFailedPrompt: true,
    env: { PAPERCLIP_API_KEY: "private-runtime-key" },
    tools: [{ name: "read_fixture", description: "Read a fixture", execute: async () => "Final tool evidence" }],
  })
  t.after(() => session.dispose())
  session.config = { api: "responses", endpoint: "https://fixture.test", apiKey: "private-model-key", model: "fixture" }
  const result = await session.write("Original task private-runtime-key private-model-key")
  assert.equal(requests.length, 2)
  const snapshot = JSON.parse(result.promptEvidence.requestBody)
  assert.equal(snapshot.model, "fixture")
  assert.equal(snapshot.input.length, requests[1].input.length)
  assert.match(result.promptEvidence.requestBody, /Final tool evidence/)
  assert.doesNotMatch(result.promptEvidence.requestBody, /private-runtime-key|private-model-key|Authorization/)
  assert.doesNotMatch(JSON.stringify(result), /Original task|Final tool evidence|requestBody/)
})

test("successful requests never expose a prompt snapshot and oversized failures are explicit rather than truncated", async t => {
  const session = new AgentSession({ id: "capture-limit", cwd: process.cwd(), captureFailedPrompt: true })
  t.after(() => session.dispose())
  session.config = { api: "responses", endpoint: "https://fixture.test", apiKey: "fixture", model: "fixture" }
  globalThis.fetch = async () => Response.json({ output_text: '{"type":"final","message":"done"}' })
  assert.equal((await session.write("Successful request")).promptEvidence, undefined)
  globalThis.fetch = async () => Response.json({ error: { code: "invalid_prompt" } }, { status: 400 })
  const result = await session.write("x".repeat(1024 * 1024))
  assert.deepEqual(result.promptEvidence, { status: "too_large" })
})

test("failed request capture accepts bodies above 512 KiB without truncating them", async t => {
  let requestBody
  globalThis.fetch = async (_url, init) => {
    requestBody = init.body
    return Response.json({ error: { code: "invalid_prompt" } }, { status: 400 })
  }
  const session = new AgentSession({ id: "larger-capture", cwd: process.cwd(), captureFailedPrompt: true })
  t.after(() => session.dispose())
  session.config = { api: "responses", endpoint: "https://fixture.test", apiKey: "fixture-key", model: "fixture" }
  const result = await session.write("x".repeat(768 * 1024))
  assert.ok(Buffer.byteLength(requestBody, "utf8") > 512 * 1024)
  assert.equal(result.promptEvidence.requestBody, requestBody)
})

test("failed request capture bounds UTF-8 bytes rather than character count", async t => {
  globalThis.fetch = async () => Response.json({ error: { code: "invalid_prompt" } }, { status: 400 })
  const session = new AgentSession({ id: "multibyte-capture-limit", cwd: process.cwd(), captureFailedPrompt: true })
  t.after(() => session.dispose())
  session.config = { api: "responses", endpoint: "https://fixture.test", apiKey: "fixture-key", model: "fixture" }
  const result = await session.write("\u00e9".repeat(600 * 1024))
  assert.deepEqual(result.promptEvidence, { status: "too_large" })
})

test("fallback capture identifies the final failed model rather than retaining an earlier request", async t => {
  const requests = []
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body))
    return Response.json({ error: { code: requests.length === 1 ? "rate_limit_exceeded" : "invalid_prompt" } },
      { status: requests.length === 1 ? 429 : 400 })
  }
  const session = new AgentSession({ id: "terminal-fallback-request", cwd: process.cwd(), captureFailedPrompt: true })
  t.after(() => session.dispose())
  session.config = { api: "responses", endpoint: "https://fixture.test", apiKey: "fixture-key", model: "gpt-5.6-sol" }
  const result = await session.write("Investigate fixture")
  assert.equal(requests.length, 2)
  assert.equal(result.modelFailure.model, "gpt-6-sol")
  assert.equal(JSON.parse(result.promptEvidence.requestBody).model, "gpt-6-sol")
})

test("exhausted headers timeouts retain the terminal structured transport code", async t => {
  globalThis.fetch = async () => { throw new TypeError("fetch failed", { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } }) }
  const session = new AgentSession({ id: "timeout-evidence", cwd: process.cwd() })
  t.after(() => session.dispose())
  session.config = { api: "responses", endpoint: "https://fixture.test", apiKey: "private-key", model: "gpt-6-luna" }
  const result = await session.write("Investigate")
  assert.equal(result.modelFailure.code, "UND_ERR_HEADERS_TIMEOUT")
  assert.equal(result.modelFailure.model, "gpt-6-luna")
  assert.equal(result.modelFailure.httpStatus, undefined)
})

test("live activity labels tools, strips terminal codes and redacts configured secrets", async t => {
  const actions = [
    { type: "tool", name: "shell_read", arguments: {} },
    { type: "final", message: "done" },
  ]
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify(actions.shift()) } }] })
  const session = new AgentSession({
    id: "live-activity", cwd: process.cwd(), env: { FIXTURE_API_KEY: "sensitive-fixture" },
    tools: [{ name: "shell_read", description: "Read fixture", execute: async () => "\u001b[31msensitive-fixture\u001b[0m" }],
  })
  session.config = { api: "chat-completions", endpoint: "https://example.test", apiKey: "fixture", model: "fixture" }
  t.after(() => session.dispose())
  const activity = []
  session.on("activity", event => activity.push(event))
  await session.write("Inspect sensitive-fixture")
  assert.equal(activity[0].kind, "prompt")
  assert.ok(activity.some(event => event.target === "shell_read"))
  assert.ok(!JSON.stringify(activity).includes("sensitive-fixture"))
  assert.ok(!activity.some(event => event.summary.includes("\u001b")))
})

test("live activity preserves 24000 characters and marks messages exceeding that limit", async t => {
  globalThis.fetch = async () => Response.json({ output_text: '{"type":"final","message":"done"}' })
  const session = new AgentSession({ id: "larger-live-activity", cwd: process.cwd() })
  t.after(() => session.dispose())
  session.config = { api: "responses", endpoint: "https://fixture.test", apiKey: "fixture-key", model: "fixture" }
  const activity = []
  session.on("activity", event => activity.push(event))
  const prompt = "x".repeat(24000)
  await session.write(prompt)
  assert.equal(activity.find(event => event.kind === "prompt").summary, prompt)
  activity.length = 0
  await session.write(`${prompt}y`)
  const summary = activity.find(event => event.kind === "prompt").summary
  assert.equal(summary.length, 24000)
  assert.ok(summary.endsWith("\n[message truncated]"))
})

test("Windows agent commands use PowerShell 7 and serialize file contents as plain strings", { skip: process.platform !== "win32" }, async t => {
  const file = fileURLToPath(new URL("../README.md", import.meta.url)).replaceAll("'", "''")
  const requests = []
  const actions = [
    { type: "tool", command: `$ErrorActionPreference='Stop'; if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 required' }; $text=Get-Content -Raw -LiteralPath '${file}'; $body=(@{body=$text}|ConvertTo-Json -Depth 4|ConvertFrom-Json).body; if ($body -isnot [string] -or $body -cne $text) { throw 'Report body did not serialize as a plain string' }; Write-Output 'plain-string-verified'` },
    { type: "final", message: "done" },
  ]
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body))
    return Response.json({ choices: [{ message: { content: JSON.stringify(actions.shift()) } }] })
  }
  const session = new AgentSession({ id: "powershell-7", cwd: process.cwd() })
  session.config = { api: "chat-completions", endpoint: "https://example.test", apiKey: "fixture", model: "fixture" }
  t.after(() => session.dispose())
  assert.equal((await session.write("Inspect the report")).exitCode, 0)
  assert.match(requests[0].messages[0].content, /execute directly in PowerShell 7/)
  assert.match(requests[1].messages.at(-1).content, /exitCode: 0[\s\S]*plain-string-verified/)
})

test("Windows terminal shells use PowerShell 7 and preserve state between commands", { skip: process.platform !== "win32", timeout: 15_000 }, async t => {
  const session = new ShellSession({ id: "terminal-powershell-7", cwd: process.cwd() })
  t.after(() => session.dispose())
  let output = ""
  session.on("output", ({ data }) => { output += data })
  function execute(command) {
    const done = new Promise(resolve => session.once("done", resolve))
    session.write(command)
    return done
  }
  assert.equal((await execute("$savedMajor=$PSVersionTable.PSVersion.Major; if ($savedMajor -lt 7) { throw 'PowerShell 7 required' }")).exitCode, 0)
  assert.equal((await execute("Write-Output ('saved-major=' + $savedMajor)")).exitCode, 0)
  assert.match(output, /saved-major=[7-9]\d*/)
})

test("Windows agent commands can explicitly use PowerShell 5.1 without changing the default", { skip: process.platform !== "win32", timeout: 15_000 }, async t => {
  const requests = []
  const actions = [
    { type: "tool", shell: "powershell-5.1", command: "if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) { throw 'Expected Windows PowerShell 5.1' }; $savedLegacy=42; Write-Output 'legacy-verified'" },
    { type: "tool", command: "if ($PSVersionTable.PSVersion.Major -lt 7 -or $savedLegacy) { throw 'Expected independent PowerShell 7' }; Write-Output 'default-verified'" },
    { type: "tool", shell: "powershell-7", command: "Write-Output $PSVersionTable.PSEdition" },
    { type: "final", message: "done" },
  ]
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body))
    return Response.json({ choices: [{ message: { content: JSON.stringify(actions.shift()) } }] })
  }
  const diagnostics = []
  const session = new AgentSession({ id: "legacy-powershell", cwd: process.cwd(), workerLabel: "worker-fixture", shellLog: message => diagnostics.push(message) })
  session.config = { api: "chat-completions", endpoint: "https://example.test", apiKey: "fixture", model: "fixture" }
  t.after(() => session.dispose())
  let output = ""
  session.on("output", event => { output += event.data })
  assert.equal((await session.write("Run a legacy command then a normal command")).exitCode, 0)
  assert.match(requests[0].messages[0].content, /"shell":"powershell-5.1"/)
  assert.match(requests[1].messages.at(-1).content, /shell: powershell-5.1[\s\S]*exitCode: 0[\s\S]*legacy-verified/)
  assert.match(requests[2].messages.at(-1).content, /exitCode: 0[\s\S]*default-verified/)
  assert.match(requests[3].messages.at(-1).content, /shell: powershell-7[\s\S]*exitCode: 0[\s\S]*Core/)
  assert.match(output, /\[Windows PowerShell 5.1\]/)
  actions.push({ type: "tool", shell: "powershell-5.1", command: "Write-Output $savedLegacy" }, { type: "final", message: "done" })
  assert.equal((await session.write("Continue in the same legacy shell")).exitCode, 0)
  assert.match(requests.at(-1).messages.at(-1).content, /exitCode: 0[\s\S]*42/)
  const legacyPids = diagnostics.filter(line => line.includes("powershell-5.1")).map(line => /pid=(\d+)/.exec(line)[1])
  assert.equal(legacyPids.length, 2)
  assert.equal(legacyPids[0], legacyPids[1])
  const defaultPids = diagnostics.filter(line => line.includes("powershell-7")).map(line => /pid=(\d+)/.exec(line)[1])
  assert.equal(defaultPids[0], defaultPids[1])
  assert.notEqual(defaultPids[0], legacyPids[0])
  assert.ok(diagnostics.every(line => line.includes("worker=worker-fixture")))
  assert.ok(!output.includes("pid="), "Backend diagnostics must not enter the browser transcript")
  const other = new AgentSession({ id: "separate-conversation", cwd: process.cwd() })
  other.config = session.config
  t.after(() => other.dispose())
  actions.push({ type: "tool", shell: "powershell-5.1", command: "if ($savedLegacy) { throw 'Conversation state leaked' }; Write-Output 'isolated'" }, { type: "final", message: "done" })
  assert.equal((await other.write("Check independent context")).exitCode, 0)
  assert.match(requests.at(-1).messages.at(-1).content, /exitCode: 0[\s\S]*isolated/)
})

test("PowerShell backend diagnostics summarize commands and script paths without exposing configured secrets", { skip: process.platform !== "win32" }, async t => {
  const script = "C:\\a-very-long-directory\\another-long-directory\\diagnostic-script.ps1"
  const command = "Write-Output 'diagnostic-secret'; " + "x".repeat(80)
  const actions = [
    { type: "tool", command },
    { type: "tool", command: `& '${script}' -Argument fixture` },
    { type: "final", message: "done" },
  ]
  globalThis.fetch = async () => Response.json({ output_text: JSON.stringify(actions.shift()) })
  t.mock.method(childProcess, "spawn", () => {
    const proc = shellProcessFixture()
    proc.pid = 321
    return proc
  })
  const diagnostics = []
  const session = new AgentSession({ id: "diagnostics", workerLabel: "worker-1", cwd: process.cwd(),
    env: { EXAMPLE_SECRET: "diagnostic-secret" }, shellLog: line => diagnostics.push(line) })
  session.config = { api: "responses", endpoint: "https://example.test", apiKey: "fixture", model: "fixture" }
  t.after(() => session.dispose())
  assert.equal((await session.write("Run commands")).exitCode, 0)
  assert.deepEqual(diagnostics, [
    `[minicode] [worker=worker-1 powershell-7 pid=321] ${command.replace("diagnostic-secret", "[redacted]").slice(0, 40)}`,
    `[minicode] [worker=worker-1 powershell-7 pid=321] ${script.slice(-40)}`,
  ])
})

test("interrupted PowerShell context loss is reported to the next model turn", { skip: process.platform !== "win32", timeout: 15000 }, async t => {
  const requests = []
  const actions = [
    { type: "tool", shell: "powershell-5.1", command: "[Console]::Out.Write('shell-ready'); Start-Sleep -Seconds 60" },
    { type: "final", message: "Context was reset" },
  ]
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body))
    return Response.json({ output_text: JSON.stringify(actions.shift()) })
  }
  const session = new AgentSession({ id: "interrupted-context", cwd: process.cwd() })
  session.config = { api: "responses", endpoint: "https://example.test", apiKey: "fixture", model: "fixture" }
  t.after(() => session.dispose())
  let started
  const ready = new Promise(resolve => { started = resolve })
  session.on("output", event => { if (event.stream === "command" && event.data.includes("shell-ready")) started() })
  const running = session.write("Run a long command")
  await ready
  session.interrupt()
  assert.equal((await running).exitCode, 130)
  assert.equal((await session.write("Continue after cancelling")).exitCode, 0)
  assert.ok(requests.at(-1).input.some(message => /SHELL_STATE_NOTICE[\s\S]*powershell-5.1 session state was lost/.test(message.content)))
})

test("invalid or non-Windows shell selections fail explicitly without launching a process", async t => {
  t.mock.method(childProcess, "spawn", assert.fail)
  for (const shell of ["cmd", "", null, ...(process.platform === "win32" ? [] : ["powershell-5.1", "powershell-7"])]) {
    globalThis.fetch = async () => Response.json({ output_text: JSON.stringify({ type: "tool", command: "echo test", shell }) })
    const session = new AgentSession({ id: "invalid-shell", cwd: process.cwd() })
    session.config = { api: "responses", endpoint: "https://example.test", apiKey: "fixture", model: "fixture" }
    try {
      const result = await session.write("Run command")
      assert.equal(result.exitCode, 1)
      assert.match(result.error, /Unsupported shell selection/)
    } finally { session.dispose() }
  }
})

test("missing requested Windows PowerShell 5.1 fails without falling back to PowerShell 7", { skip: process.platform !== "win32" }, async t => {
  const launches = []
  t.mock.method(childProcess, "spawn", file => {
    launches.push(file)
    const proc = shellProcessFixture()
    queueMicrotask(() => proc.emit("error", Object.assign(new Error("spawn failed"), { code: "ENOENT" })))
    return proc
  })
  const requests = []
  const actions = [
    { type: "tool", shell: "powershell-5.1", command: "Write-Output test" },
    { type: "final", message: "Blocked", error: "Legacy PowerShell unavailable" },
  ]
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body))
    return Response.json({ output_text: JSON.stringify(actions.shift()) })
  }
  const session = new AgentSession({ id: "missing-legacy-shell", cwd: process.cwd() })
  session.config = { api: "responses", endpoint: "https://example.test", apiKey: "fixture", model: "fixture" }
  t.after(() => session.dispose())
  assert.equal((await session.write("Run a legacy command")).exitCode, 1)
  assert.match(requests[1].input.find(message => message.content.startsWith("TOOL_RESULT")).content, /exitCode: 1[\s\S]*Windows PowerShell 5.1 was requested but powershell.exe is unavailable/)
  assert.deepEqual(launches, ["powershell.exe"])
})

test("missing PowerShell 7 fails commands explicitly without falling back", { skip: process.platform !== "win32" }, async t => {
  const launches = []
  t.mock.method(childProcess, "spawn", (file) => {
    launches.push(file)
    const proc = shellProcessFixture()
    queueMicrotask(() => {
      proc.emit("error", Object.assign(new Error("spawn failed"), { code: "ENOENT" }))
      proc.emit("close", -2)
    })
    return proc
  })
  const actions = [{ type: "tool", command: "Write-Output test" }, { type: "final", message: "Blocked", error: "PowerShell unavailable" }]
  const requests = []
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body))
    return Response.json({ choices: [{ message: { content: JSON.stringify(actions.shift()) } }] })
  }
  const agent = new AgentSession({ id: "missing-powershell", cwd: process.cwd() })
  agent.config = { api: "chat-completions", endpoint: "https://example.test", apiKey: "fixture", model: "fixture" }
  t.after(() => agent.dispose())
  assert.equal((await agent.write("Run command")).exitCode, 1)
  assert.match(requests[1].messages.find(message => message.content.startsWith("TOOL_RESULT")).content, /exitCode: 1[\s\S]*PowerShell 7 \(pwsh\) is required/)
  const shell = new ShellSession({ id: "missing-terminal-powershell", cwd: process.cwd() })
  let output = ""
  shell.on("output", ({ data }) => { output += data })
  await new Promise(resolve => shell.once("exit", resolve))
  assert.match(output, /PowerShell 7 \(pwsh\) is required/)
  assert.deepEqual(launches, ["pwsh.exe", "pwsh.exe"])
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

test("Azure headers timeout retries once with refreshed credentials and unchanged context", async t => {
  const requests = [], warnings = []
  let tokens = 0
  t.mock.method(console, "warn", message => warnings.push(message))
  globalThis.fetch = async (_url, init) => {
    requests.push({ body: JSON.parse(init.body), authorization: init.headers.Authorization })
    if (requests.length === 1) {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("headers timed out"), { code: "UND_ERR_HEADERS_TIMEOUT" }) })
    }
    return Response.json({ output_text: "retry succeeded" })
  }
  const config = {
    api: "responses", endpoint: "https://example.test/responses", model: "gpt-5.6-sol",
    getAccessToken: async () => `fixture-token-${++tokens}`,
  }
  const messages = [{ role: "user", content: "Inspect this task" }]
  assert.equal(await callModelOnce(config, messages), "retry succeeded")
  assert.deepEqual(requests.map(request => request.body.model), ["gpt-5.6-sol", "gpt-5.6-sol"])
  assert.deepEqual(requests[0].body.input, messages)
  assert.deepEqual(requests[0].body, requests[1].body)
  assert.notEqual(requests[0].authorization, requests[1].authorization)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /gpt-5\.6-sol.*UND_ERR_HEADERS_TIMEOUT.*retrying once/)
})

test("Azure headers timeout exhausts the chain after exactly one retry per model with redacted diagnostics", async t => {
  const models = [], warnings = []
  t.mock.method(console, "warn", message => warnings.push(message))
  globalThis.fetch = async (_url, init) => {
    models.push(JSON.parse(init.body).model)
    throw Object.assign(new Error("headers timed out fixture-secret"), { code: "UND_ERR_HEADERS_TIMEOUT" })
  }
  await assert.rejects(callModelOnce({
    api: "responses", endpoint: "https://example.test/responses", apiKey: "fixture-secret", model: "gpt-5.6-sol",
  }, []), error => {
    assert.match(error.message, /Model fallback exhausted/)
    for (const model of new Set(models)) assert.ok(error.message.includes(`Model ${model} failed after one retry`))
    assert.match(error.message, /UND_ERR_HEADERS_TIMEOUT/)
    assert.ok(!error.message.includes("fixture-secret"))
    assert.ok(error.message.includes("[redacted]"))
    return true
  })
  assert.deepEqual(models, [
    "gpt-5.6-sol", "gpt-5.6-sol", "gpt-6-sol", "gpt-6-sol",
    "gpt-5.6-terra", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-luna",
    "gpt-6-luna", "gpt-6-luna",
  ])
  assert.equal(warnings.length, 9)
  assert.match(warnings[1], /gpt-5\.6-sol.*after one retry.*gpt-6-sol/)
})

test("headers timeout fallback retains the working model and does not replay completed tools", async t => {
  const requests = []
  let tools = 0
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body))
    if (requests.length === 2 || requests.length === 3) {
      throw new TypeError("fetch failed", { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } })
    }
    const action = requests.length === 1 || requests.length === 4
      ? { type: "tool", name: "inspect", arguments: {} }
      : { type: "final", message: "done" }
    return Response.json({ output_text: JSON.stringify(action) })
  }
  const session = new AgentSession({
    id: "timeout-fallback", cwd: process.cwd(),
    tools: [{ name: "inspect", description: "Inspect once", execute: async () => `receipt-${++tools}` }],
    modelConfigProvider: async () => ({
      api: "responses", endpoint: "https://example.test/responses", apiKey: "fixture", model: "gpt-5.6-sol",
    }),
  })
  t.after(() => session.dispose())
  const activity = []
  session.on("activity", event => activity.push(event))
  assert.equal((await session.write("Inspect")).exitCode, 0)
  assert.equal(tools, 2)
  assert.deepEqual(requests.map(request => request.model), [
    "gpt-5.6-sol", "gpt-5.6-sol", "gpt-5.6-sol", "gpt-6-sol", "gpt-6-sol",
  ])
  assert.deepEqual(requests[1].input, requests[2].input)
  assert.deepEqual(requests[2].input, requests[3].input)
  assert.match(requests[3].input.at(-1).content, /receipt-1/)
  assert.match(requests[4].input.at(-1).content, /receipt-2/)
  assert.ok(activity.some(event => /retrying once/.test(event.summary)))
  assert.ok(activity.some(event => /trying gpt-6-sol/.test(event.summary)))
})

test("headers timeout recovery skips missing alternatives and preserves rate-limit fallback", async t => {
  const models = []
  t.mock.method(console, "warn", () => {})
  globalThis.fetch = async (_url, init) => {
    models.push(JSON.parse(init.body).model)
    if (models.length <= 2) throw new TypeError("fetch failed", { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } })
    if (models.length === 3) return Response.json({ error: { code: "DeploymentNotFound" } }, { status: 404 })
    if (models.length === 4) return Response.json({ error: { code: "rate_limit_exceeded" } }, { status: 429 })
    return Response.json({ output_text: "done" })
  }
  assert.equal(await callModelOnce({
    api: "responses", endpoint: "https://example.test/responses", apiKey: "fixture", model: "gpt-5.6-sol",
  }, []), "done")
  assert.deepEqual(models, ["gpt-5.6-sol", "gpt-5.6-sol", "gpt-6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])
})

test("headers timeout handling leaves other errors, APIs, and providers unchanged", async t => {
  for (const fixture of [
    { code: "UND_ERR_BODY_TIMEOUT" },
    { code: "ENETUNREACH" },
    { code: "UND_ERR_HEADERS_TIMEOUT", api: "chat-completions" },
    { code: "UND_ERR_HEADERS_TIMEOUT", provider: "github-copilot" },
    { code: "UND_ERR_HEADERS_TIMEOUT", model: "other-model" },
  ]) {
    await t.test(JSON.stringify(fixture), async () => {
      let requests = 0
      globalThis.fetch = async () => {
        requests++
        throw new TypeError("fetch failed", { cause: { code: fixture.code } })
      }
      await assert.rejects(callModelOnce({
        api: "responses", endpoint: "https://example.test/responses", apiKey: "fixture", model: "gpt-5.6-sol",
        ...fixture,
      }, []), new RegExp(`fetch failed \\(${fixture.code}\\)`))
      assert.equal(requests, 1)
    })
  }
})

test("interrupting headers timeout recovery prevents retries and alternative requests", async t => {
  for (const stopAt of ["retrying once", "trying gpt-6-sol"]) {
    await t.test(stopAt, async t => {
      let requests = 0
      globalThis.fetch = async () => {
        requests++
        throw new TypeError("fetch failed", { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } })
      }
      const session = new AgentSession({ id: "cancel-timeout", cwd: process.cwd() })
      session.config = { api: "responses", endpoint: "https://example.test/responses", apiKey: "fixture", model: "gpt-5.6-sol" }
      t.after(() => session.dispose())
      session.on("output", ({ data }) => {
        if (data.includes(stopAt)) session.interrupt()
      })
      await session.write("Inspect")
      assert.equal(requests, stopAt === "retrying once" ? 1 : 2)
      assert.equal(session.busy, false)
      assert.deepEqual(session.messages, [])
    })
  }
})

test("Azure rate limits advance through the requested model chain with unchanged context and credentials", async t => {
  const requests = [], warnings = []
  t.mock.method(console, "warn", message => warnings.push(message))
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    requests.push({ url, body, authorization: init.headers.Authorization })
    return requests.length < 5
      ? Response.json({ error: { code: "rate_limit_exceeded", message: "Too many tokens" } }, { status: 429 })
      : Response.json({ output_text: "fallback succeeded" })
  }
  const config = {
    api: "responses", endpoint: "https://example.test/openai/v1/responses",
    getAccessToken: async () => "fixture-token", model: "gpt-5.6-sol",
  }
  const messages = [{ role: "user", content: "Inspect this task" }]
  assert.equal(await callModelOnce(config, messages), "fallback succeeded")
  assert.deepEqual(requests.map(request => request.body.model), [
    "gpt-5.6-sol", "gpt-6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-luna",
  ])
  for (const request of requests) {
    assert.equal(request.url, config.endpoint)
    assert.equal(request.authorization, "Bearer fixture-token")
    assert.deepEqual(request.body.input, messages)
  }
  assert.equal(config.model, "gpt-5.6-sol")
  assert.equal(warnings.length, 4)
  assert.match(warnings[0], /gpt-5\.6-sol.*429.*gpt-6-sol/)
  assert.match(warnings[3], /gpt-5\.6-luna.*429.*gpt-6-luna/)
})

test("fallback skips explicitly missing deployments with a warning", async t => {
  for (const code of ["DeploymentNotFound", "model_not_found"]) {
    await t.test(code, async t => {
      const models = [], warnings = []
      t.mock.method(console, "warn", message => warnings.push(message))
      globalThis.fetch = async (_url, init) => {
        models.push(JSON.parse(init.body).model)
        if (models.length === 1) return Response.json({ error: { code: "rate_limit_exceeded" } }, { status: 429 })
        if (models.length === 2) return Response.json({ error: { code, message: "Not deployed" } }, { status: 404 })
        return Response.json({ output_text: "done" })
      }
      assert.equal(await callModelOnce({
        api: "responses", endpoint: "https://example.test/responses", apiKey: "fixture", model: "gpt-5.6-sol",
      }, []), "done")
      assert.deepEqual(models, ["gpt-5.6-sol", "gpt-6-sol", "gpt-5.6-terra"])
      assert.match(warnings[1], /gpt-6-sol.*unavailable.*404.*gpt-5\.6-terra/)
    })
  }
})

test("exhausting rate-limited and missing models fails with redacted per-model diagnostics", async t => {
  const models = []
  t.mock.method(console, "warn", () => {})
  globalThis.fetch = async (_url, init) => {
    models.push(JSON.parse(init.body).model)
    const missing = models.length === 5
    return Response.json({ error: {
      code: missing ? "DeploymentNotFound" : "rate_limit_exceeded",
      message: "Provider diagnostic with fixture-secret",
    } }, { status: missing ? 404 : 429, headers: { "x-request-id": `request-${models.length}` } })
  }
  await assert.rejects(callModelOnce({
    api: "responses", endpoint: "https://example.test/responses", apiKey: "fixture-secret", model: "gpt-5.6-sol",
  }, []), error => {
    assert.match(error.message, /Model fallback exhausted/)
    assert.match(error.message, /gpt-6-luna[\s\S]*DeploymentNotFound/)
    assert.match(error.message, /request-1[\s\S]*request-5/)
    assert.ok(!error.message.includes("fixture-secret"))
    assert.ok(error.message.includes("[redacted]"))
    return true
  })
  assert.equal(models.length, 5)
})

test("fallback does not mask unrelated errors or change other providers and APIs", async t => {
  for (const fixture of [
    { status: 400 },
    { status: 401 },
    { status: 403 },
    { status: 404, code: "DeploymentNotFound" },
    { status: 425 },
    { status: 500 },
    { status: 429, api: "chat-completions" },
    { status: 429, provider: "github-copilot" },
    { status: 429, model: "other-model" },
    { status: 404, preceding429: true, code: "ResourceNotFound" },
    { status: 403, preceding429: true },
  ]) {
    await t.test(JSON.stringify(fixture), async t => {
      let requests = 0
      t.mock.method(console, "warn", () => {})
      globalThis.fetch = async () => {
        requests++
        return fixture.preceding429 && requests === 1
          ? Response.json({ error: { code: "rate_limit_exceeded" } }, { status: 429 })
          : Response.json({ error: { code: fixture.code, message: "Stop here" } }, { status: fixture.status })
      }
      await assert.rejects(callModelOnce({
        api: "responses", endpoint: "https://example.test/responses", apiKey: "fixture", model: "gpt-5.6-sol",
        ...fixture,
      }, []), new RegExp(`Model request failed \\(${fixture.status}\\)`))
      assert.equal(requests, fixture.preceding429 ? 2 : 1)
    })
  }
})

test("fallback retains the working model for the prompt without replaying completed tools", async t => {
  const requests = []
  let tools = 0
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body))
    if (requests.length === 2) return Response.json({ error: { code: "rate_limit_exceeded" } }, { status: 429 })
    if (requests.length === 3) return Response.json({ error: { code: "DeploymentNotFound" } }, { status: 404 })
    const action = requests.length === 1 || requests.length === 4
      ? { type: "tool", name: "inspect", arguments: {} }
      : { type: "final", message: "done" }
    return Response.json({ output_text: JSON.stringify(action) })
  }
  const session = new AgentSession({
    id: "model-fallback", cwd: process.cwd(),
    tools: [{ name: "inspect", description: "Inspect once", execute: async () => `receipt-${++tools}` }],
    modelConfigProvider: async () => ({
      api: "responses", endpoint: "https://example.test/responses", apiKey: "fixture", model: "gpt-5.6-sol",
    }),
  })
  t.after(() => session.dispose())
  const output = [], activity = []
  session.on("output", event => output.push(event))
  session.on("activity", event => activity.push(event))
  assert.equal((await session.write("Inspect")).exitCode, 0)
  assert.equal(tools, 2)
  assert.equal((await session.write("Follow up")).exitCode, 0)
  assert.deepEqual(requests.map(request => request.model), [
    "gpt-5.6-sol", "gpt-5.6-sol", "gpt-6-sol", "gpt-5.6-terra", "gpt-5.6-terra", "gpt-5.6-sol",
  ])
  assert.deepEqual(requests[1].input, requests[2].input)
  assert.deepEqual(requests[2].input, requests[3].input)
  assert.match(requests[3].input.at(-1).content, /receipt-1/)
  assert.match(requests[4].input.at(-1).content, /receipt-2/)
  assert.ok(output.some(event => event.stream === "stderr" && /rate limited/.test(event.data)))
  assert.ok(activity.some(event => /unavailable/.test(event.summary)))
})

test("interrupting during a fallback warning prevents further model requests", async t => {
  let requests = 0
  globalThis.fetch = async () => {
    requests++
    return Response.json({ error: { code: "rate_limit_exceeded" } }, { status: 429 })
  }
  const session = new AgentSession({ id: "cancel-fallback", cwd: process.cwd() })
  session.config = { api: "responses", endpoint: "https://example.test/responses", apiKey: "fixture", model: "gpt-5.6-sol" }
  t.after(() => session.dispose())
  session.on("output", ({ data }) => {
    if (data.includes("rate limited")) session.interrupt()
  })
  await session.write("Inspect")
  assert.equal(requests, 1)
  assert.equal(session.busy, false)
  assert.deepEqual(session.messages, [])
})

test("model HTTP errors include safe provider details, model, endpoint and request ID", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { message: "Unsupported parameter; fixture-secret", code: "unsupported_parameter", param: "instructions" },
    access_token: "must-not-be-printed",
  }), { status: 400, headers: { "x-github-request-id": "request-123" } })
  await assert.rejects(callModelOnce({
    api: "responses", endpoint: "https://api.githubcopilot.com/responses",
    apiKey: "fixture-secret", model: "selected-model",
  }, [{ role: "user", content: "hello" }]), error => {
    assert.match(error.message, /400.*https:\/\/api\.githubcopilot\.com\/responses.*selected-model/)
    assert.match(error.message, /Unsupported parameter; \[redacted\]; unsupported_parameter; instructions/)
    assert.match(error.message, /x-github-request-id: request-123/)
    assert.ok(!error.message.includes("fixture-secret"))
    assert.ok(!error.message.includes("must-not-be-printed"))
    return true
  })
})

test("empty HTTP errors explicitly report missing provider details", async () => {
  globalThis.fetch = async () => new Response(null, { status: 400 })
  await assert.rejects(callModelOnce({
    api: "responses", endpoint: "https://example.test/responses", apiKey: "fixture", model: "selected",
  }, [{ role: "user", content: "hello" }]), /400[\s\S]*Provider returned no error details/)
})

test("Copilot requests retain provider headers and distinguish user turns from automated continuations", async t => {
  const requests = []
  const actions = [
    { type: "tool", name: "inspect", arguments: {} },
    { type: "final", message: "done" },
    { type: "final", message: "follow-up done" },
  ]
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    requests.push(init)
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(actions.shift()) } }] }),
      { headers: { "Content-Type": "application/json" } })
  })
  const session = new AgentSession({ id: "copilot", cwd: process.cwd(),
    tools: [{ name: "inspect", description: "Read task metadata", execute: async () => "metadata" }] })
  session.config = {
    api: "chat-completions", endpoint: "https://api.githubcopilot.com/chat/completions",
    apiKey: "fixture-only", model: "gpt-5-mini", provider: "github-copilot",
    headers: { "Openai-Intent": "conversation-edits", "User-Agent": "minicode/0.1.0" },
  }
  t.after(() => session.dispose())
  assert.equal((await session.write("Inspect metadata")).exitCode, 0)
  assert.equal((await session.write("One more question")).exitCode, 0)
  assert.deepEqual(requests.map(request => request.headers["x-initiator"]), ["user", "agent", "user"])
  for (const request of requests) {
    assert.equal(request.headers["Openai-Intent"], "conversation-edits")
    assert.equal(request.headers.Authorization, "Bearer fixture-only")
    assert.equal(JSON.parse(request.body).temperature, undefined)
  }
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

test("Hosted model configuration uses parent tokens without local auth resolution or token prompt exposure", async t => {
  let tokens = 0
  const session = new AgentSession({
    id: "hosted-model", cwd: process.cwd(),
    modelConfigProvider: async () => ({
      api: "chat-completions", endpoint: "https://hosted.example/v1/chat/completions", model: "hosted",
      getAccessToken: async () => `parent-token-${++tokens}`,
    }),
  })
  t.after(() => session.dispose())
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://hosted.example/v1/chat/completions")
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer parent-token-${tokens}`)
    assert.equal(init.body.includes("parent-token"), false)
    return Response.json({ choices: [{ message: { content: '{"type":"final","message":"done"}' } }] })
  }
  assert.equal((await session.write("First assignment turn")).exitCode, 0)
  assert.equal((await session.write("Second assignment turn")).exitCode, 0)
  assert.equal(tokens, 2)
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
    return shellProcessFixture()
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
