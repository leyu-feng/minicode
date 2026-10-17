import assert from "node:assert/strict"
import childProcess from "node:child_process"
import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test, { after, before } from "node:test"
import { AgentSession } from "../server/agent-session.js"
import {
  addAzureDeployment,
  authFilePath,
  clearAuth,
  getActiveAzureDeployment,
  getActiveAuthSummary,
  getAzureAccessToken,
  listAzureDeployments,
  readAuth,
  setActiveAzureDeployment,
  resolveModelConfig,
  loginActiveDeployment,
} from "../server/auth.js"

let configHome

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

test("removes legacy Copilot credentials without changing Azure deployments", async () => {
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
      "github-copilot": { refresh: "legacy-token" },
    }),
  )

  const auth = await readAuth()
  assert.equal(auth["github-copilot"], undefined)
  assert.deepEqual(auth.active, { provider: "azure-entra", name: "primary-resource" })

  const persisted = JSON.parse(await fs.readFile(authFilePath(), "utf8"))
  assert.equal(persisted["github-copilot"], undefined)
  assert.equal(persisted["azure-entra"].deployments["primary-resource"].model, "gpt-5.6-sol")
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
