import assert from "node:assert/strict"
import childProcess from "node:child_process"
import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import timers from "node:timers/promises"
import test, { after, before } from "node:test"
import { AgentSession, callModelOnce } from "../server/agent-session.js"
import {
  addAzureDeployment,
  addCopilotAuth,
  authFilePath,
  clearAuth,
  getActiveAzureDeployment,
  getActiveAuthSummary,
  getAzureAccessToken,
  listAzureDeployments,
  listAuthConfigs,
  readAuth,
  setActiveAzureDeployment,
  setActiveAuth,
  resolveModelConfig,
  loginActiveDeployment,
  listAvailableModels,
} from "../server/auth.js"

let configHome

test("model discovery uses the current provider endpoint and credentials", async t => {
  const config = {
    api: "responses", endpoint: "https://resource.test/openai/v1/responses?api-version=fixture",
    model: "current", getAccessToken: async () => "fixture-token", headers: { "X-Provider": "fixture" },
  }
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(String(url), "https://resource.test/openai/v1/models?api-version=fixture")
    assert.equal(options.headers.Authorization, "Bearer fixture-token")
    assert.equal(options.headers["X-Provider"], "fixture")
    return Response.json({ data: [{ id: "gpt-6.1-sol" }, { id: "kimi-k3" }, { id: "kimi-k3" }, {}, { id: "\u001b[31m" }] })
  })
  assert.deepEqual(await listAvailableModels(config), [
    { id: "gpt-6.1-sol", api: "responses", endpoint: config.endpoint },
    { id: "kimi-k3", api: "responses", endpoint: config.endpoint },
  ])
  assert.equal(config.model, "current")
})

test("Copilot discovery filters unavailable models and selects each model's API", async t => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(String(url), "https://api.githubcopilot.com/models")
    assert.equal(options.headers.Authorization, "Bearer fixture-key")
    return Response.json({ data: [
      { id: "gpt-6.1-sol", supported_endpoints: ["/responses"] },
      { id: "kimi-k3", supported_endpoints: ["/chat/completions"] },
      { id: "disabled", policy: { state: "disabled" } },
      { id: "hidden", model_picker_enabled: false },
      { id: "unsupported", supported_endpoints: ["/embeddings"] },
    ] })
  })

  assert.deepEqual(await listAvailableModels({
    provider: "github-copilot", api: "responses", apiKey: "fixture-key",
    endpoint: "https://api.githubcopilot.com/responses",
  }), [
    { id: "gpt-6.1-sol", api: "responses", endpoint: "https://api.githubcopilot.com/responses" },
    { id: "kimi-k3", api: "chat-completions", endpoint: "https://api.githubcopilot.com/chat/completions" },
  ])
})

test("Azure discovery lists deployed names, filters non-chat models, and follows pagination", async t => {
  const resourceId = "/subscriptions/sub/resourceGroups/group/providers/Microsoft.CognitiveServices/accounts/resource"
  const requests = []
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const target = new URL(url)
    requests.push(target.href)
    if (target.hostname === "resource.services.ai.azure.com") {
      assert.equal(options.headers.Authorization, "Bearer model-token")
      return Response.json({ data: [
        { id: "gpt-6.1-sol", capabilities: { chat_completion: true } },
        { id: "Kimi-K3", capabilities: { chat_completion: true } },
        { id: "image-model", capabilities: { chat_completion: false } },
      ] })
    }
    assert.equal(target.origin, "https://management.azure.com")
    assert.equal(options.headers.Authorization, "Bearer management-token")
    if (target.pathname.includes("ResourceGraph")) {
      assert.equal(options.method, "POST")
      assert.match(JSON.parse(options.body).query, /name =~ 'resource'/)
      return Response.json({ data: [{ id: resourceId }] })
    }
    if (target.searchParams.has("page")) {
      return Response.json({ value: [
        { name: "kimi-k3", properties: { provisioningState: "Succeeded", model: { name: "Kimi-K3", format: "MoonshotAI" } } },
      ] })
    }
    return Response.json({ value: [
      { name: "my-gpt", properties: { provisioningState: "Succeeded", model: { name: "gpt-6.1-sol", format: "OpenAI" } } },
      { name: "failed-gpt", properties: { provisioningState: "Failed", model: { name: "gpt-6.1-sol", format: "OpenAI" } } },
      { name: "images", properties: { provisioningState: "Succeeded", model: { name: "image-model", format: "OpenAI" } } },
    ], nextLink: `https://management.azure.com${resourceId}/deployments?page=2` })
  })
  assert.deepEqual(await listAvailableModels({
    api: "responses", endpoint: "https://resource.services.ai.azure.com/openai/v1/responses",
    getAccessToken: async () => "model-token", getManagementAccessToken: async () => "management-token",
  }), [
    { id: "my-gpt", api: "responses", endpoint: "https://resource.services.ai.azure.com/openai/v1/responses" },
    { id: "kimi-k3", api: "chat-completions", endpoint: "https://resource.services.ai.azure.com/openai/v1/chat/completions" },
  ])
  assert.equal(requests.length, 4)
})

test("Azure discovery reports management access failures without listing undeployed models", async t => {
  for (const [response, expected] of [
    [Response.json({ error: "access denied" }, { status: 403 }), /management-plane read access is required/],
    [Response.json({ data: [] }), /Could not uniquely find Azure resource/],
  ]) {
    t.mock.method(globalThis, "fetch", async url => new URL(url).hostname === "resource.test"
      ? Response.json({ data: [{ id: "undeployed-base-model" }] }) : response)
    await assert.rejects(listAvailableModels({
      api: "responses", endpoint: "https://resource.test/openai/v1/responses", apiKey: "fixture",
      getManagementAccessToken: async () => "management-token",
    }), expected)
    t.mock.restoreAll()
  }
})

test("model discovery reports provider errors, invalid catalogs, and empty lists", async t => {
  const config = { api: "chat-completions", endpoint: "https://provider.test/v1/chat/completions", apiKey: "fixture-key" }
  for (const [response, expected] of [
    [Response.json({ error: "access denied" }, { status: 403 }), /Could not list models \(HTTP 403\)/],
    [Response.json({ unexpected: [] }), /invalid model catalog/],
    [Response.json({ data: [] }), /No available models/],
  ]) {
    t.mock.method(globalThis, "fetch", async () => response)
    await assert.rejects(listAvailableModels(config), expected)
    t.mock.restoreAll()
  }
})

before(async () => {
  configHome = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-auth-test-"))
  process.env.MINICODE_CONFIG_HOME = configHome
})

after(async () => {
  delete process.env.MINICODE_CONFIG_HOME
  await fs.rm(configHome, { recursive: true, force: true })
})

test("stores named Azure deployments and selects the active one", async () => {
  await addAzureDeployment({ name: "primary-resource", model: "gpt-5.6-sol" })
  await addAzureDeployment({ name: "other-resource", model: "gpt-5.4", activate: false })

  assert.deepEqual(await getActiveAzureDeployment(), {
    name: "primary-resource",
    endpoint: "https://primary-resource.services.ai.azure.com/openai/v1/responses",
    model: "gpt-5.6-sol",
  })

  await setActiveAzureDeployment("other-resource")
  const deployments = await listAzureDeployments()
  assert.equal(deployments.length, 2)
  assert.equal(deployments.find((item) => item.name === "other-resource").active, true)
  assert.equal(authFilePath(), path.join(configHome, "auth.json"))
})

test("rejects deployment names that cannot form an Azure hostname", async () => {
  await assert.rejects(
    addAzureDeployment({ name: "https://invalid.example", model: "gpt-5.6-sol" }),
    /only letters, numbers, and hyphens/,
  )
})

test("clears deployment configuration without requiring an existing file", async () => {
  assert.equal(await clearAuth(), true)
  assert.deepEqual(await listAzureDeployments(), [])
  assert.equal(await clearAuth(), false)
})

test("preserves legacy Copilot credentials and Azure deployments without rewriting configuration", async () => {
  await fs.writeFile(
    authFilePath(),
    JSON.stringify({
      active: { provider: "github-copilot", name: "copilot" },
      "azure-entra": {
        active: "primary-resource",
        deployments: {
          "primary-resource": {
            endpoint: "https://primary-resource.services.ai.azure.com/openai/v1/responses",
            model: "gpt-5.6-sol",
          },
        },
      },
      "github-copilot": { refresh: "legacy-token", model: "legacy-picked-model" },
    }),
  )

  const saved = await fs.readFile(authFilePath(), "utf8")
  const auth = await readAuth()
  assert.equal(auth["github-copilot"].refresh, "legacy-token")
  assert.equal((await getActiveAuthSummary()).name, "@copilot")
  assert.equal((await listAuthConfigs()).find(item => item.name === "@copilot").active, true)
  assert.equal(auth["azure-entra"].deployments["primary-resource"].model, "gpt-5.6-sol")
  assert.equal(await fs.readFile(authFilePath(), "utf8"), saved)
})

function mockCopilot(t, {
  polls = [{ access_token: "fixture-copilot-secret" }],
  device = {},
  account = { login: "octocat" },
  catalog = { data: [{ id: "gpt-5.4", supported_endpoints: ["/responses"] }] },
  catalogStatus = 200,
  credentialStatus = 200,
  credential,
} = {}) {
  const requests = [], waits = []
  let now = Date.now()
  t.mock.method(Date, "now", () => now)
  t.mock.method(timers, "setTimeout", async ms => { waits.push(ms); now += ms })
  t.mock.method(childProcess, "execFile", assert.fail)
  t.mock.method(childProcess, "spawn", assert.fail)
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, init })
    let data, status = 200
    if (url === "https://github.com/login/device/code") {
      data = { device_code: "fixture-device", user_code: "ABCD-EFGH",
        verification_uri: "https://github.com/login/device", expires_in: 900, interval: 1, ...device }
    } else if (url === "https://github.com/login/oauth/access_token") {
      data = polls.shift() || { error: "authorization_pending" }
    } else if (url === "https://api.github.com/user") {
      assert.equal(init.headers.Authorization, "token fixture-copilot-secret")
      assert.equal(init.headers["X-GitHub-Api-Version"], "2022-11-28")
      data = account
    } else if (url === "https://api.github.com/copilot_internal/v2/token") {
      assert.equal(init.headers.Authorization, "token fixture-copilot-secret")
      assert.equal(init.headers["X-GitHub-Api-Version"], "2022-11-28")
      data = credential ?? { token: "fixture-copilot-api-token", expires_at: Math.floor(now / 1000) + 3600, refresh_in: 1800 }
      status = credentialStatus
    } else if (url === "https://api.githubcopilot.com/models") {
      assert.equal(init.headers.Authorization, "Bearer fixture-copilot-api-token")
      data = catalog
      status = catalogStatus
    } else if (url === "https://api.githubcopilot.com/responses" || url === "https://api.githubcopilot.com/chat/completions") {
      data = { output_text: "Copilot response", choices: [{ message: { content: "Copilot response" } }] }
    } else assert.fail(`Unexpected URL: ${url}`)
    return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } })
  })
  return { requests, waits, advance(ms) { now += ms } }
}

test("Copilot device sign-in honors polling, preserves Azure profiles, and pins model credentials across auth switches", async t => {
  await clearAuth()
  await addAzureDeployment({ name: "kept-azure" })
  const azure = (await readAuth())["azure-entra"]
  const { requests, waits } = mockCopilot(t, { polls: [
    { error: "authorization_pending" }, { error: "slow_down", interval: 4 }, { access_token: "fixture-copilot-secret" },
  ] })
  const prompts = []
  const added = await addCopilotAuth({ onPrompt: prompt => prompts.push(prompt), selectModel: models => {
    assert.deepEqual(models, [{ id: "gpt-5.4", name: "gpt-5.4" }])
    return models[0].id
  } })
  assert.equal(added.name, "@copilot")
  assert.equal(added.user, "octocat@github.com")
  assert.deepEqual(prompts, [{ verificationUri: "https://github.com/login/device", userCode: "ABCD-EFGH" }])
  assert.deepEqual(waits, [4000, 4000, 9000])
  assert.deepEqual((await readAuth())["azure-entra"], azure)
  assert.equal((await getActiveAuthSummary()).provider, "github-copilot")
  const entries = await listAuthConfigs()
  assert.equal(entries.find(item => item.name === "@copilot").active, true)
  assert.equal(entries.find(item => item.name === "kept-azure").active, false)
  assert.ok(!JSON.stringify(entries).includes("fixture-copilot-secret"))
  assert.ok(!JSON.stringify(await getActiveAuthSummary()).includes("fixture-copilot-secret"))
  const config = await resolveModelConfig()
  assert.equal(config.api, "responses")
  assert.equal(config.deployment, "@copilot")
  await setActiveAuth("kept-azure")
  assert.equal(await callModelOnce(config, [{ role: "user", content: "hello" }]), "Copilot response")
  const request = requests.at(-1)
  assert.equal(request.init.headers.Authorization, "Bearer fixture-copilot-api-token")
  assert.equal(request.init.headers["Copilot-Integration-Id"], "vscode-chat")
  assert.equal(request.init.headers["Editor-Version"], "vscode/1.104.3")
  assert.match(request.init.headers["X-Request-Id"], /^[0-9a-f-]{36}$/)
  assert.equal(request.init.headers["x-initiator"], "user")
  assert.equal(request.init.headers["Openai-Intent"], "conversation-panel")
  assert.equal(request.init.headers["User-Agent"], "GitHubCopilotChat/0.26.7")
  assert.equal(request.init.headers["Editor-Plugin-Version"], "copilot-chat/0.26.7")
  assert.equal(request.init.headers["X-GitHub-Api-Version"], "2025-04-01")
  assert.equal((await getActiveAuthSummary()).name, "kept-azure")
  await setActiveAuth("@copilot")
  assert.equal((await getActiveAuthSummary()).name, "@copilot")
})

test("Copilot auth HTTP errors expose provider details without credentials or changing saved auth", async t => {
  await clearAuth()
  await addAzureDeployment({ name: "kept-azure" })
  const saved = await fs.readFile(authFilePath(), "utf8")
  mockCopilot(t, {
    catalogStatus: 400,
    catalog: { message: "Bad Request", errors: "Unsupported API version; fixture-copilot-api-token" },
  })
  await assert.rejects(addCopilotAuth({ model: "gpt-5.4", onPrompt() {} }), error => {
    assert.match(error.message, /HTTP 400.*https:\/\/api\.githubcopilot\.com\/models/)
    assert.match(error.message, /Bad Request; Unsupported API version; \[redacted\]/)
    assert.ok(!error.message.includes("fixture-copilot-api-token"))
    return true
  })
  assert.equal(await fs.readFile(authFilePath(), "utf8"), saved)
})

test("Copilot renews API credentials on demand and never falls back to an expired token", async t => {
  await clearAuth()
  const { requests, advance } = mockCopilot(t)
  await addCopilotAuth({ model: "gpt-5.4", onPrompt() {} })
  const config = await resolveModelConfig()
  const exchanges = () => requests.filter(request => request.url.endsWith("/copilot_internal/v2/token")).length
  assert.equal(exchanges(), 1)
  advance(1_739_000)
  await callModelOnce(config, [{ role: "user", content: "cached" }])
  assert.equal(exchanges(), 1)
  advance(2_000)
  await callModelOnce(config, [{ role: "user", content: "renewed" }])
  assert.equal(exchanges(), 2)
  advance(1_741_000)
  t.mock.method(globalThis, "fetch", url => {
    if (url.endsWith("/copilot_internal/v2/token")) {
      return Promise.resolve(new Response(JSON.stringify({ message: "Authorization revoked" }), { status: 401 }))
    }
    assert.fail(`Must not send a model request after failed renewal: ${url}`)
  })
  await assert.rejects(callModelOnce(config, [{ role: "user", content: "must fail" }]), /HTTP 401[\s\S]*Authorization revoked/)
})

test("Copilot credential caches and resolved sessions stay bound to their GitHub account", async t => {
  await clearAuth()
  mockCopilot(t)
  await addCopilotAuth({ model: "gpt-5.4", onPrompt() {} })
  const first = await resolveModelConfig()
  const auth = await readAuth()
  auth["github-copilot"].refresh = "another-github-credential"
  await fs.writeFile(authFilePath(), JSON.stringify(auth))
  const authorizations = []
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url.endsWith("/copilot_internal/v2/token")) {
      assert.equal(init.headers.Authorization, "token another-github-credential")
      return Response.json({ token: "another-api-credential", expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_in: 1800 })
    }
    if (url.endsWith("/models")) {
      assert.equal(init.headers.Authorization, "Bearer another-api-credential")
      return Response.json({ data: [{ id: "gpt-5.4", supported_endpoints: ["/responses"] }] })
    }
    authorizations.push(init.headers.Authorization)
    return Response.json({ output_text: "OK" })
  })
  const second = await resolveModelConfig()
  await callModelOnce(first, [{ role: "user", content: "first account" }])
  await callModelOnce(second, [{ role: "user", content: "second account" }])
  assert.deepEqual(authorizations, ["Bearer fixture-copilot-api-token", "Bearer another-api-credential"])
})

test("Copilot process selection overrides API keys and Azure settings without changing the shared selection", async t => {
  await clearAuth()
  await addAzureDeployment({ name: "shared-azure" })
  mockCopilot(t, { polls: [{ access_token: "fixture-copilot-secret" }, { access_token: "fixture-copilot-secret" }], catalog: { data: [
    { id: "gpt-4.1", supported_endpoints: ["/chat/completions"] },
  ] } })
  await addCopilotAuth({ model: "gpt-4.1", onPrompt() {}, activate: false })
  const saved = await fs.readFile(authFilePath(), "utf8")
  const keys = ["MINICODE_AUTH_ENTRY", "OPENCODE_API_KEY", "AZURE_OPENAI_DEPLOYMENT", "AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_MODEL"]
  const originals = keys.map(key => process.env[key])
  t.after(() => keys.forEach((key, index) => {
    if (originals[index] === undefined) delete process.env[key]
    else process.env[key] = originals[index]
  }))
  Object.assign(process.env, {
    MINICODE_AUTH_ENTRY: "@copilot", OPENCODE_API_KEY: "unused-api-key",
    AZURE_OPENAI_DEPLOYMENT: "shared-azure", AZURE_OPENAI_ENDPOINT: "https://unused.test",
    AZURE_OPENAI_MODEL: "unused-azure-model",
  })
  const config = await resolveModelConfig()
  assert.equal(config.api, "chat-completions")
  assert.equal(config.model, "gpt-4.1")
  assert.equal(config.endpoint, "https://api.githubcopilot.com/chat/completions")
  assert.equal((await getActiveAuthSummary()).user, "octocat@github.com")
  assert.equal(await callModelOnce(config, [{ role: "user", content: "hello" }]), "Copilot response")
  assert.equal(await fs.readFile(authFilePath(), "utf8"), saved)
  await loginActiveDeployment({ onPrompt() {} })
  assert.deepEqual((await readAuth()).active, { provider: "azure-entra", name: "shared-azure" })
})

test("Copilot authorization, identity, entitlement and model failures do not overwrite saved auth", async t => {
  for (const [options, expected] of [
    [{ polls: [{ error: "access_denied" }] }, /access_denied/],
    [{ polls: [{ error: "expired_token" }] }, /expired_token/],
    [{ polls: [{}], device: { expires_in: 1 } }, /device code expired/],
    [{ device: { device_code: undefined } }, /invalid device-authorization/],
    [{ polls: [{ access_token: 123 }] }, /invalid authorization response/],
    [{ account: {} }, /account login/],
    [{ credentialStatus: 403, credential: { message: "Copilot access denied" } }, /HTTP 403[\s\S]*Copilot access denied/],
    [{ credential: { token: "", expires_at: 1, refresh_in: 1800 } }, /invalid or expired API credential/],
    [{ credential: { token: "fixture-copilot-api-token", expires_at: 1, refresh_in: 1800 } }, /invalid or expired API credential/],
    [{ catalogStatus: 403 }, /HTTP 403/],
    [{ catalog: {} }, /invalid model catalog/],
    [{ catalog: { data: [] } }, /not available/],
    [{ catalog: { data: [{ id: "gpt-5.4", policy: { state: "disabled" } }] } }, /disabled/],
    [{ catalog: { data: [{ id: "gpt-5.4", supported_endpoints: ["/v1/messages"] }] } }, /does not support/],
  ]) {
    await t.test(expected.source, async t => {
      await clearAuth()
      await addAzureDeployment({ name: "preserved" })
      const saved = await fs.readFile(authFilePath(), "utf8")
      mockCopilot(t, options)
      await assert.rejects(addCopilotAuth({ model: "gpt-5.4", onPrompt() {} }), error => {
        assert.match(error.message, expected)
        assert.ok(!error.message.includes("fixture-copilot-secret"))
        return true
      })
      assert.equal(await fs.readFile(authFilePath(), "utf8"), saved)
    })
  }
})

test("Copilot model selection uses the account catalog without a default and leaves auth unchanged on failed selection", async t => {
  for (const [selectModel, expected] of [
    [models => {
      assert.deepEqual(models, [{ id: "account-model", name: "Account Model" }])
      return "account-model"
    }, undefined],
    [() => "", /No Copilot model selected/],
    [() => "hidden-model", /not in the available model list/],
    [undefined, /Select a Copilot model interactively/],
  ]) {
    await t.test(expected?.source || "selected account model", async t => {
      await clearAuth()
      await addAzureDeployment({ name: "preserved" })
      const saved = await fs.readFile(authFilePath(), "utf8")
      mockCopilot(t, { catalog: { data: [
        { id: "account-model", name: "Account Model", supported_endpoints: ["/chat/completions"] },
        { id: "hidden-model", model_picker_enabled: false },
        { id: "disabled-model", policy: { state: "disabled" } },
        { id: "messages-only", supported_endpoints: ["/v1/messages"] },
        null,
      ] } })
      if (expected) {
        await assert.rejects(addCopilotAuth({ onPrompt() {}, selectModel }), expected)
        assert.equal(await fs.readFile(authFilePath(), "utf8"), saved)
      } else {
        const added = await addCopilotAuth({ onPrompt() {}, selectModel })
        assert.equal(added.model, "account-model")
        assert.equal((await readAuth())["github-copilot"].model, "account-model")
        assert.equal((await resolveModelConfig()).api, "chat-completions")
      }
    })
  }
})

test("Copilot profiles without a selected model require setup instead of silently choosing a model", async t => {
  await clearAuth()
  await fs.writeFile(authFilePath(), JSON.stringify({
    active: { provider: "github-copilot", name: "@copilot" },
    "github-copilot": { refresh: "fixture-copilot-secret" },
  }))
  t.mock.method(globalThis, "fetch", assert.fail)
  await assert.rejects(getActiveAuthSummary(), /no selected model.*auth add --copilot/)
  await assert.rejects(resolveModelConfig(), /no selected model.*auth add --copilot/)
})

const TENANT = "11111111-1111-1111-1111-111111111111"

test("old helper model profiles require explicit Azure CLI setup without invoking either credential CLI", async (t) => {
  await clearAuth()
  await addAzureDeployment({ name: "legacy-helper" })
  const auth = await readAuth()
  Object.assign(auth["azure-entra"].deployments["legacy-helper"], {
    credentialProvider: "clippy-auth", user: "alice@contoso.com", tenant: TENANT,
  })
  await fs.writeFile(authFilePath(), JSON.stringify(auth))
  const saved = await fs.readFile(authFilePath(), "utf8")
  t.mock.method(childProcess, "spawn", assert.fail)
  t.mock.method(childProcess, "execFile", assert.fail)
  await assert.rejects(resolveModelConfig(), /no longer supported.*Re-add this deployment/)
  await assert.rejects(loginActiveDeployment(), /no longer supported.*Re-add this deployment/)
  assert.equal(await fs.readFile(authFilePath(), "utf8"), saved)

  mockAzureIdentity(t)
  await addAzureDeployment({ name: "legacy-helper", entraUser: "alice@contoso.com" })
  assert.equal((await getActiveAzureDeployment()).credentialProvider, "azure-cli")
})

test("Azure CLI profiles retain their token flow and use login@az.cli as the display name", async (t) => {
  await clearAuth()
  await addAzureDeployment({ name: "legacy-cli" })
  t.mock.method(childProcess, "execFile", (_command, args, _options, callback) => {
    assert.ok(args.join(" ").includes("account get-access-token"))
    callback(null, JSON.stringify({ accessToken: "azure-cli-token", expires_on: Math.floor(Date.now() / 1000) + 3600 }), "")
  })
  const config = await resolveModelConfig()
  assert.equal(config.user, "login@az.cli")
  assert.equal(await config.getAccessToken(), "azure-cli-token")
  assert.equal((await getActiveAuthSummary()).user, "login@az.cli")
  assert.equal((await listAzureDeployments())[0].user, "login@az.cli")
})

test("API-key overrides do not call credential CLIs or display a saved Azure identity", async (t) => {
  await clearAuth()
  await addAzureDeployment({ name: "unused-azure" })
  const originalKey = process.env.OPENCODE_API_KEY
  const originalUrl = process.env.OPENCODE_BASE_URL
  const originalModel = process.env.OPENCODE_MODEL
  process.env.OPENCODE_API_KEY = "fixture-key"
  process.env.OPENCODE_BASE_URL = "https://example.test/v1"
  process.env.OPENCODE_MODEL = "custom-model"
  t.after(() => {
    for (const [key, original] of [
      ["OPENCODE_API_KEY", originalKey], ["OPENCODE_BASE_URL", originalUrl], ["OPENCODE_MODEL", originalModel],
    ]) {
      if (original === undefined) delete process.env[key]
      else process.env[key] = original
    }
  })
  t.mock.method(childProcess, "execFile", assert.fail)
  const config = await resolveModelConfig()
  assert.equal(config.api, "chat-completions")
  assert.equal(config.model, "custom-model")
  assert.deepEqual(await getActiveAuthSummary(), {
    name: "API key", model: "custom-model", user: "API key", provider: "api-key",
  })
})

function azureIdentityToken(user, claims = {}) {
  return `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({
    upn: user, tid: TENANT, ...claims,
  })).toString("base64url")}.fixture-signature`
}

function mockAzureIdentity(t, { wrongUser = false, failedLogin = false, wrongTenant = false } = {}) {
  const calls = []
  const accounts = new Map()
  const originalCache = process.env.AZURE_CONFIG_DIR
  t.mock.method(childProcess, "spawn", (_command, args, options) => {
    calls.push({ args: args.join(" "), env: options.env, login: true })
    assert.notEqual(options.env.AZURE_CONFIG_DIR, originalCache)
    assert.equal(options.env.AZURE_CORE_LOGIN_EXPERIENCE_V2, "off")
    if (!accounts.has(options.env.AZURE_CONFIG_DIR)) {
      accounts.set(options.env.AZURE_CONFIG_DIR, accounts.size ? "bob@contoso.com" : "alice@contoso.com")
    }
    const child = new EventEmitter()
    queueMicrotask(() => child.emit("exit", failedLogin ? 1 : 0))
    return child
  })
  t.mock.method(childProcess, "execFile", (_command, args, options, callback) => {
    const command = args.join(" ")
    calls.push({ args: command, env: options.env })
    const user = accounts.get(options.env.AZURE_CONFIG_DIR)
    const response = command.includes("account show")
      ? { user: { type: "user", name: wrongUser ? "other@contoso.com" : user }, tenantId: TENANT }
      : { accessToken: azureIdentityToken(user), tenant: wrongTenant ? "22222222-2222-2222-2222-222222222222" : TENANT,
        expires_on: Math.floor(Date.now() / 1000) + 3600 }
    callback(null, JSON.stringify(response), "")
  })
  return calls
}

test("entra-user uses isolated Azure CLI caches and keeps two resolved identities independent on renewal", async (t) => {
  await clearAuth()
  let now = Date.now()
  t.mock.method(Date, "now", () => now)
  const originalCache = process.env.AZURE_CONFIG_DIR
  const calls = mockAzureIdentity(t)
  await addAzureDeployment({ name: "azure-alice", entraUser: "alice@contoso.com", tenant: TENANT })
  const alice = await resolveModelConfig()
  const aliceProfile = await getActiveAzureDeployment()
  assert.equal(aliceProfile.credentialProvider, "azure-cli")
  assert.equal(aliceProfile.tenant, TENANT)
  assert.equal(alice.user, "alice@contoso.com")
  await addAzureDeployment({ name: "azure-bob", entraUser: "bob@contoso.com" })
  const bob = await resolveModelConfig()
  const bobProfile = await getActiveAzureDeployment()
  assert.notEqual(aliceProfile.azureConfigDir, bobProfile.azureConfigDir)
  assert.equal(await alice.getAccessToken(), azureIdentityToken("alice@contoso.com"))
  assert.equal(await bob.getAccessToken(), azureIdentityToken("bob@contoso.com"))
  now += 3_400_000
  assert.equal(await alice.getAccessToken(), azureIdentityToken("alice@contoso.com"))
  assert.equal(await bob.getAccessToken(), azureIdentityToken("bob@contoso.com"))
  assert.equal(calls.filter((call) => call.login).length, 2, "renewal must never start login")
  const requests = calls.filter((call) => call.args.includes("get-access-token"))
  assert.equal(requests.length, 5)
  assert.ok(requests.every((call) => call.args.includes(`--tenant ${TENANT}`)))
  assert.equal(process.env.AZURE_CONFIG_DIR, originalCache, "parent Azure CLI context must not change")
  assert.equal((await listAzureDeployments()).find((item) => item.name === "azure-bob").user, "bob@contoso.com")
  const saved = await fs.readFile(authFilePath(), "utf8")
  assert.ok(!saved.includes("accessToken") && !saved.includes("token-alice"))
  assert.equal((await loginActiveDeployment()).user, "bob@contoso.com")
  assert.equal(calls.filter((call) => call.login).length, 3)
})

test("process auth selection binds model credentials without changing shared active configuration", async (t) => {
  await clearAuth()
  mockAzureIdentity(t)
  await addAzureDeployment({ name: "azure-alice", entraUser: "alice@contoso.com" })
  await addAzureDeployment({ name: "azure-bob", entraUser: "bob@contoso.com" })
  const saved = await fs.readFile(authFilePath(), "utf8")
  const keys = ["MINICODE_AUTH_ENTRY", "OPENCODE_API_KEY", "AZURE_OPENAI_DEPLOYMENT"]
  const originals = keys.map((key) => process.env[key])
  t.after(() => keys.forEach((key, index) => {
    if (originals[index] === undefined) delete process.env[key]
    else process.env[key] = originals[index]
  }))
  process.env.MINICODE_AUTH_ENTRY = "azure-alice"
  process.env.OPENCODE_API_KEY = "unused-api-key"
  process.env.AZURE_OPENAI_DEPLOYMENT = "azure-bob"
  const config = await resolveModelConfig()
  assert.equal(config.deployment, "azure-alice")
  assert.equal(config.user, "alice@contoso.com")
  assert.equal(config.azureConfigDir, (await getActiveAzureDeployment()).azureConfigDir)
  assert.equal(await config.getAccessToken(), azureIdentityToken("alice@contoso.com"))
  assert.equal((await getActiveAuthSummary()).name, "azure-alice")
  assert.equal(await fs.readFile(authFilePath(), "utf8"), saved)
  process.env.MINICODE_AUTH_ENTRY = "missing-profile"
  await assert.rejects(resolveModelConfig(), /missing-profile.*not configured/)
  assert.equal(await config.getAccessToken(), azureIdentityToken("alice@contoso.com"))
})

test("Azure CLI identity setup rejects login failures, wrong accounts and tenants without saving", async (t) => {
  for (const [options, expected] of [
    [{ failedLogin: true }, /exited with code/],
    [{ wrongUser: true }, /did not sign in as/],
    [{ wrongTenant: true }, /different tenant/],
  ]) {
    await t.test(JSON.stringify(options), async (t) => {
      await clearAuth()
      await addAzureDeployment({ name: "existing" })
      const saved = await fs.readFile(authFilePath(), "utf8")
      mockAzureIdentity(t, options)
      await assert.rejects(addAzureDeployment({ name: "rejected", entraUser: "alice@contoso.com" }), expected)
      assert.equal(await fs.readFile(authFilePath(), "utf8"), saved)
    })
  }
})

test("Azure CLI rejects unsafe tenant arguments before starting login", async (t) => {
  t.mock.method(childProcess, "spawn", assert.fail)
  await assert.rejects(addAzureDeployment({
    name: "invalid-tenant", entraUser: "alice@contoso.com", tenant: "tenant&echo unsafe",
  }), /Invalid Entra tenant/)
})

test("Azure CLI runtime refuses an account changed inside an identity cache", async (t) => {
  await clearAuth()
  mockAzureIdentity(t)
  await addAzureDeployment({ name: "bound-account", entraUser: "alice@contoso.com" })
  const profile = await getActiveAzureDeployment()
  await clearAuth()
  t.mock.method(childProcess, "execFile", (_command, args, _options, callback) => {
    assert.ok(args.join(" ").includes("account show"), "no token may be requested for the wrong account")
    callback(null, JSON.stringify({ user: { type: "user", name: "bob@contoso.com" }, tenantId: TENANT }), "")
  })
  await assert.rejects(getAzureAccessToken(profile), /did not sign in as alice@contoso.com/)
})

test("Azure CLI checks token identity claims on every acquisition, including renewal", async (t) => {
  await clearAuth()
  let now = Date.now()
  t.mock.method(Date, "now", () => now)
  mockAzureIdentity(t)
  await addAzureDeployment({ name: "token-claims", entraUser: "alice@contoso.com" })
  const profile = await getActiveAzureDeployment()
  now += 3_400_000
  let accessToken
  t.mock.method(childProcess, "execFile", (_command, args, _options, callback) => {
    const response = args.join(" ").includes("account show")
      ? { user: { type: "user", name: profile.user }, tenantId: TENANT }
      : { accessToken, tenant: TENANT, expires_on: Math.floor(now / 1000) + 3600 }
    callback(null, JSON.stringify(response), "")
  })
  for (const [token, expected] of [
    [azureIdentityToken("bob@contoso.com"), /requested user/],
    [azureIdentityToken(profile.user, { tid: "22222222-2222-2222-2222-222222222222" }), /different or missing tenant/],
    [azureIdentityToken(profile.user, { tid: undefined }), /different or missing tenant/],
    [azureIdentityToken(undefined), /requested user/],
    ["not-a-jwt", /could not be read/],
    ["header.invalid-json.signature", /could not be read/],
  ]) {
    accessToken = token
    await assert.rejects(getAzureAccessToken(profile), (error) => {
      assert.match(error.message, expected)
      assert.ok(!error.message.includes(token), "errors must not expose the token")
      return true
    })
  }
  for (const claim of ["upn", "preferred_username", "unique_name"]) {
    accessToken = azureIdentityToken(undefined, { [claim]: "ALICE@CONTOSO.COM", tid: TENANT.toUpperCase() })
    assert.equal(await getAzureAccessToken(profile), accessToken)
    now += 3_400_000
  }
})

test("agent shell commands inherit the bound Azure CLI identity across prompts without changing other sessions", async (t) => {
  await clearAuth()
  const originalCache = process.env.AZURE_CONFIG_DIR
  mockAzureIdentity(t)
  await addAzureDeployment({ name: "shell-alice", entraUser: "alice@contoso.com" })
  const aliceProfile = await getActiveAzureDeployment()
  await addAzureDeployment({ name: "shell-bob", entraUser: "bob@contoso.com" })
  const bobProfile = await getActiveAzureDeployment()
  await setActiveAzureDeployment("shell-alice")

  const requests = []
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    requests.push(init.headers.Authorization)
    const action = requests.length % 2
      ? { type: "tool", command: "az account list" }
      : { type: "final", message: "done" }
    return new Response(JSON.stringify({ output_text: JSON.stringify(action) }), {
      status: 200, headers: { "Content-Type": "application/json" },
    })
  })
  const environments = []
  t.mock.method(childProcess, "spawn", (_command, _args, options) => {
    environments.push(options.env)
    const proc = new EventEmitter()
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    queueMicrotask(() => proc.emit("close", 0))
    return proc
  })
  const customEnv = { ...process.env, WORKER_FIXTURE: "preserved", AZURE_CONFIG_DIR: "overridden-parent-cache" }
  const alice = new AgentSession({ id: "alice-shell", cwd: process.cwd(), env: customEnv })
  const bob = new AgentSession({ id: "bob-shell", cwd: process.cwd() })
  t.after(() => { alice.dispose(); bob.dispose() })
  assert.equal((await alice.write("list my Azure accounts")).exitCode, 0)
  await setActiveAzureDeployment("shell-bob")
  assert.equal((await bob.write("list my Azure accounts")).exitCode, 0)
  alice.clearContext()
  assert.equal((await alice.write("list my Azure accounts again")).exitCode, 0)

  assert.deepEqual(environments.map((env) => env.AZURE_CONFIG_DIR), [
    aliceProfile.azureConfigDir, bobProfile.azureConfigDir, aliceProfile.azureConfigDir,
  ])
  assert.equal(environments[0].WORKER_FIXTURE, "preserved")
  assert.equal(customEnv.AZURE_CONFIG_DIR, "overridden-parent-cache")
  assert.equal(process.env.AZURE_CONFIG_DIR, originalCache)
  assert.deepEqual(requests, [
    ...Array(2).fill(`Bearer ${azureIdentityToken("alice@contoso.com")}`),
    ...Array(2).fill(`Bearer ${azureIdentityToken("bob@contoso.com")}`),
    ...Array(2).fill(`Bearer ${azureIdentityToken("alice@contoso.com")}`),
  ])
})
