import assert from "node:assert/strict"
import test from "node:test"
import { acquireAzureDevOpsToken, AZURE_DEVOPS_RESOURCE } from "../src/azure-devops.js"
import { main, parseArgs, EXIT_INTERACTION_REQUIRED } from "../cli.js"
import { InteractionRequiredError } from "../src/wam.js"

const tenant = "11111111-1111-4111-8111-111111111111"
const options = { organization: "https://dev.azure.com/fixture", user: "alice@contoso.test",
  clientId: "fixture-client", silentOnly: true }
const result = () => ({ accessToken: "private-fixture-token", expiresOn: new Date(Date.now() + 3600_000),
  account: { username: options.user, tenantId: tenant } })
const challenge = async (url, init) => {
  assert.equal(url.href, "https://dev.azure.com/fixture/_apis/connectionData?api-version=7.1")
  assert.equal(init.redirect, "manual")
  assert.equal(init.headers, undefined)
  return new Response(null, { status: 302, headers: { "x-vss-resourcetenant": tenant } })
}

test("Azure DevOps MSAL requests its own resource in the challenged tenant without saving an Easy Auth session", async () => {
  const token = await acquireAzureDevOpsToken(options, { fetchImpl: challenge, getToken: async request => {
    assert.deepEqual(request, { authority: `https://login.microsoftonline.com/${tenant}`,
      clientId: options.clientId, scopes: [`${AZURE_DEVOPS_RESOURCE}/.default`], user: options.user, silentOnly: true })
    return result()
  } })
  assert.equal(token.accessToken, "private-fixture-token")
  assert.equal(token.user, options.user)
  assert.equal(token.tenantId, tenant)
  assert.ok(Date.parse(token.expiresAt) > Date.now())
})

test("Azure DevOps authentication rejects unknown tenants, account changes and expired tokens", async () => {
  await assert.rejects(acquireAzureDevOpsToken({ ...options, organization: "https://other.test/fixture" }), /requires https/)
  await assert.rejects(acquireAzureDevOpsToken(options, { fetchImpl: async () => new Response(null, { status: 302 }) }), /did not identify/)
  for (const mutation of [
    token => { token.account.username = "other@contoso.test" },
    token => { token.account.tenantId = "22222222-2222-4222-8222-222222222222" },
    token => { token.expiresOn = new Date(0) },
    token => { token.expiresOn = new Date(NaN) },
    token => { token.accessToken = "" },
  ]) {
    const token = result()
    mutation(token)
    await assert.rejects(acquireAzureDevOpsToken(options, { fetchImpl: challenge, getToken: async () => token }), /different account|expired/)
  }
})

test("ado-login never prints tokens; ado-token returns private JSON and silent failures remain explicit", async () => {
  const args = ["--organization", options.organization, "--user", options.user]
  assert.equal(parseArgs(["ado-token", ...args, "--silent"]).silent, true)
  assert.throws(() => parseArgs(["ado-token", ...args, "--scope", "other-resource"]), /Usage/)
  assert.throws(() => parseArgs(["ado-token", "--organization", options.organization]), /Usage/)
  const logs = [], errors = []
  const token = { accessToken: "private-fixture-token", user: options.user, expiresAt: new Date(Date.now() + 3600_000).toISOString() }
  const dependency = { acquireAzureDevOpsToken: async request => {
    assert.equal(request.user, options.user)
    return token
  } }
  assert.equal(await main(["ado-login", ...args], text => logs.push(text), text => errors.push(text), dependency), 0)
  assert.ok(!logs.join("").includes(token.accessToken))
  logs.length = 0
  assert.equal(await main(["ado-token", ...args, "--silent"], text => logs.push(text), text => errors.push(text), dependency), 0)
  assert.deepEqual(JSON.parse(logs[0]), token)
  logs.length = 0
  assert.equal(await main(["ado-token", ...args, "--silent"], text => logs.push(text), text => errors.push(text), {
    acquireAzureDevOpsToken: async request => {
      assert.equal(request.silentOnly, true)
      throw new InteractionRequiredError("Interactive consent required")
    },
  }), EXIT_INTERACTION_REQUIRED)
  assert.equal(logs.length, 0)
  assert.match(errors.at(-1), /Interactive consent required/)
})
