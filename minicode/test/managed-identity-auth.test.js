import assert from "node:assert/strict"
import childProcess from "node:child_process"
import { ManagedIdentityCredential } from "@azure/identity"
import test from "node:test"
import { getActiveAuthSummary, resolveModelConfig } from "../server/auth.js"

function configure(t, overrides = {}) {
  const values = {
    MINICODE_AUTH_MODE: "managed-identity", MINICODE_AUTH_ENTRY: undefined,
    AZURE_OPENAI_ENDPOINT: "https://model-resource.services.ai.azure.com",
    AZURE_OPENAI_MODEL: "deployment-model", OPENCODE_MODEL: undefined,
    AZURE_CLIENT_ID: "11111111-1111-1111-1111-111111111111", ...overrides,
  }
  for (const [key, value] of Object.entries(values)) {
    const old = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
    t.after(() => {
      if (old === undefined) delete process.env[key]
      else process.env[key] = old
    })
  }
  t.mock.method(childProcess, "execFile", assert.fail)
  t.mock.method(childProcess, "spawn", assert.fail)
}

test("managed identity resolves without saved auth, caches tokens and renews before expiry", async t => {
  configure(t, { MINICODE_CONFIG_HOME: "not-an-auth-profile", OPENCODE_MODEL: "override-model" })
  let now = Date.now()
  t.mock.method(Date, "now", () => now)
  let calls = 0
  t.mock.method(ManagedIdentityCredential.prototype, "getToken", async (scope, options) => {
    assert.equal(scope, "https://cognitiveservices.azure.com/.default")
    assert.ok(options.abortSignal)
    calls++
    return { token: `fixture-token-${calls}`, expiresOnTimestamp: now + 3600_000 }
  })
  const config = await resolveModelConfig()
  assert.equal(config.api, "responses")
  assert.equal(config.endpoint, "https://model-resource.services.ai.azure.com/openai/v1/responses")
  assert.equal(config.model, "override-model")
  assert.equal(config.user, "managed-identity")
  assert.equal(await config.getAccessToken(), "fixture-token-1")
  assert.equal(calls, 1)
  now += 56 * 60_000
  assert.equal(await config.getAccessToken(), "fixture-token-2")
  assert.equal(calls, 2)
  assert.equal((await getActiveAuthSummary()).provider, "managed-identity")
  assert.equal(calls, 2)
})

test("managed identity validates configuration instead of prompting or falling back", async t => {
  configure(t)
  for (const endpoint of ["http://example.test", "https://example.test/other", "https://example.test/?key=secret"]) {
    process.env.AZURE_OPENAI_ENDPOINT = endpoint
    await assert.rejects(resolveModelConfig(), /HTTPS Azure account origin or Responses URL/)
  }
  process.env.AZURE_OPENAI_ENDPOINT = "https://example.test/openai/v1/responses"
  delete process.env.AZURE_OPENAI_MODEL
  await assert.rejects(resolveModelConfig(), /requires AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_MODEL/)
})

test("managed identity uses separate cached model and management tokens for the same identity", async t => {
  configure(t)
  const scopes = []
  t.mock.method(ManagedIdentityCredential.prototype, "getToken", async scope => {
    scopes.push(scope)
    return { token: `fixture-${scope}`, expiresOnTimestamp: Date.now() + 3600_000 }
  })
  const config = await resolveModelConfig()
  await config.getManagementAccessToken()
  await config.getManagementAccessToken()
  await config.getAccessToken()
  assert.deepEqual(scopes, [
    "https://cognitiveservices.azure.com/.default",
    "https://management.azure.com/.default",
  ])
})

test("managed identity errors and invalid tokens are surfaced without Azure CLI fallback", async t => {
  configure(t)
  const getToken = t.mock.method(ManagedIdentityCredential.prototype, "getToken", async () => {
    throw new Error("Managed identity unavailable")
  })
  await assert.rejects(resolveModelConfig(), /Managed identity unavailable/)
  getToken.mock.mockImplementation(async () => ({ token: "expired", expiresOnTimestamp: 0 }))
  await assert.rejects(resolveModelConfig(), /no valid model access token/)
})
