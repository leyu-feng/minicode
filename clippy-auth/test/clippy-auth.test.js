import assert from "node:assert/strict"
import childProcess from "node:child_process"
import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, test } from "node:test"

import { isEasyAuthChallenge, parseChallenge, readChallenge } from "../src/challenge.js"
import { exchangeForSession, jwtExpiry, sessionAccepted } from "../src/easyauth.js"
import { readSession, removeSession, serverOrigin, sessionPath, writeSession } from "../src/session-store.js"
import { EXIT_ERROR, main, parseArgs } from "../cli.js"
import { acquireToken, acquireTokenWithAzureCli, azureCliConfigDir, azureCliInvocation, createBrokerApplication, InteractionRequiredError } from "../src/wam.js"

const SERVER = "https://clippy.example.net"
const CHALLENGE = 'Bearer realm="clippy.example.net" authorization_uri="https://login.microsoftonline.com/tenant-id/oauth2/v2.0/authorize" resource_id="app-id"'

function response(status, { headers = {}, json } = {}) {
  return new Response(json === undefined ? null : JSON.stringify(json), { status, headers })
}

function jwt(claims) {
  return ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".")
}

let configHome
beforeEach(async () => {
  configHome = await fs.mkdtemp(path.join(os.tmpdir(), "clippy-auth-test-"))
  process.env.MINICODE_CONFIG_HOME = configHome
})
afterEach(async () => {
  delete process.env.MINICODE_CONFIG_HOME
  await fs.rm(configHome, { recursive: true, force: true })
})

test("parses the tenant and audience out of Easy Auth's challenge", () => {
  assert.deepEqual(parseChallenge(CHALLENGE), {
    authority: "https://login.microsoftonline.com/tenant-id",
    resource: "app-id",
  })
  assert.equal(parseChallenge('Bearer realm="x"'), null)
  assert.equal(parseChallenge(undefined), null)
})

test("tells Easy Auth's 401 from Clippy's", () => {
  assert.equal(isEasyAuthChallenge(401, CHALLENGE), true)
  assert.equal(isEasyAuthChallenge(401, null), false)
  assert.equal(isEasyAuthChallenge(403, CHALLENGE), false)
})

test("reads the challenge from an unauthenticated health probe", async () => {
  const seen = []
  const challenge = await readChallenge(SERVER, async (url, init) => {
    seen.push([String(url), init.headers.authorization])
    return response(401, { headers: { "www-authenticate": CHALLENGE } })
  })
  assert.equal(challenge.resource, "app-id")
  assert.deepEqual(seen, [[`${SERVER}/api/health`, "Bearer clippy-auth-probe"]])
  await assert.rejects(readChallenge(SERVER, async () => response(200)), /did not answer with an Easy Auth challenge/)
})

test("exchanges an Entra token for an Easy Auth session and reads its expiry", async () => {
  const session = jwt({ exp: 1_800_000_000 })
  const result = await exchangeForSession(SERVER, "entra-token", async (url, init) => {
    assert.equal(String(url), `${SERVER}/.auth/login/aad`)
    assert.deepEqual(JSON.parse(init.body), { access_token: "entra-token" })
    return response(200, { json: { authenticationToken: session } })
  })
  assert.equal(result.sessionToken, session)
  assert.equal(result.expiresAt, new Date(1_800_000_000 * 1000).toISOString())
  await assert.rejects(exchangeForSession(SERVER, "t", async () => response(403)), /allowedApplications/)
  assert.equal(jwtExpiry("not-a-jwt"), null)
})

test("treats anything but Easy Auth's own 401 as an accepted session", async () => {
  assert.equal(await sessionAccepted(SERVER, "s", async (_url, init) => {
    assert.equal(init.headers["x-zumo-auth"], "s")
    return response(200)
  }), true)
  assert.equal(await sessionAccepted(SERVER, "s", async () => response(401, { headers: { "www-authenticate": 'Bearer realm="clippy"' } })), true)
  assert.equal(await sessionAccepted(SERVER, "s", async () => response(401, { headers: { "www-authenticate": CHALLENGE } })), false)
})

test("saves sessions per server host and user, and picks the newest without a user", async () => {
  const base = { server: SERVER, clientId: "c", resource: "app-id", expiresAt: null }
  await writeSession({ ...base, user: "Alice@Contoso.com", sessionToken: "a", createdAt: "2026-10-01T00:00:00.000Z" })
  await writeSession({ ...base, user: "bob@contoso.com", sessionToken: "b", createdAt: "2026-10-02T00:00:00.000Z" })

  assert.equal(sessionPath(SERVER, "Alice@Contoso.com"), path.join(configHome, "entra", "clippy.example.net", "alice@contoso.com.json"))
  assert.equal((await readSession(SERVER, "alice@contoso.com")).sessionToken, "a")
  assert.equal((await readSession(SERVER)).user, "bob@contoso.com")
  assert.equal(await readSession("https://other.example.net"), null)

  assert.equal((await removeSession(SERVER, "bob@contoso.com")).user, "bob@contoso.com")
  assert.equal((await readSession(SERVER)).user, "Alice@Contoso.com")
})

test("ignores session files it does not understand", async () => {
  const file = sessionPath(SERVER, "eve@contoso.com")
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify({ version: 99, sessionToken: "x" }))
  assert.equal(await readSession(SERVER, "eve@contoso.com"), null)
})

test("parses commands and rejects incomplete ones", () => {
  assert.deepEqual(parseArgs(["login", "--server", `${SERVER}/some/path`, "--user", "a@b.c", "--silent"]), {
    command: "login", server: SERVER, user: "a@b.c", silent: true,
  })
  assert.throws(() => parseArgs(["login"]), /Usage/)
  assert.throws(() => parseArgs(["login", "--server"]), /Usage|incomplete/)
  assert.throws(() => parseArgs(["frob", "--server", SERVER]), /Usage/)
  assert.throws(() => parseArgs(["status", "--server", "ftp://x"]), /HTTP\(S\)/)
})

test("board-token verifies the human bearer and returns private JSON without saving a worker session", async () => {
  const accessToken = jwt({ exp: 1_800_000_000 })
  const lines = []
  const errors = []
  const seen = []
  const exit = await main(["board-token", "--server", SERVER, "--user", "alice@contoso.com", "--silent"],
    line => lines.push(line), line => errors.push(line), {
      acquireToken: async options => {
        assert.equal(options.user, "alice@contoso.com")
        assert.equal(options.silentOnly, true)
        assert.deepEqual(options.scopes, ["app-id/user_impersonation"])
        return { accessToken, account: { username: "alice@contoso.com" } }
      },
      fetchImpl: async (url, init) => {
        seen.push(String(url))
        if (url.pathname === "/api/health") return response(401, { headers: { "www-authenticate": CHALLENGE } })
        assert.equal(init.redirect, "error")
        assert.equal(init.headers.authorization, `Bearer ${accessToken}`)
        assert.equal(init.headers["x-zumo-auth"], undefined)
        return response(200, { json: { user: { id: "mapped-user" }, session: { id: "board-session" } } })
      },
    })
  assert.equal(exit, 0)
  assert.deepEqual(errors, [])
  assert.equal(lines.length, 1)
  assert.deepEqual(JSON.parse(lines[0]), {
    accessToken, expiresAt: new Date(1_800_000_000 * 1000).toISOString(), user: "alice@contoso.com", server: SERVER,
  })
  assert.deepEqual(seen, [`${SERVER}/api/health`, `${SERVER}/api/auth/get-session`])
  assert.equal(await readSession(SERVER), null)
})

test("board-token never releases a token when Clippy rejects it or returns no board identity", async () => {
  for (const result of [response(401), response(403), response(200, { json: {} })]) {
    const lines = [], errors = []
    const exit = await main(["board-token", "--server", SERVER], line => lines.push(line), line => errors.push(line), {
      acquireToken: async () => ({ accessToken: "private-token-canary", account: { username: "alice@contoso.com" } }),
      fetchImpl: async url => url.pathname === "/api/health"
        ? response(401, { headers: { "www-authenticate": CHALLENGE } }) : result,
    })
    assert.equal(exit, EXIT_ERROR)
    assert.deepEqual(lines, [])
    assert.equal(errors.length, 1)
    assert.ok(!errors[0].includes("private-token-canary"))
    assert.equal(await readSession(SERVER), null)
  }
})

test("board-token refuses a different account before making a board request", async () => {
  const lines = [], errors = []
  const exit = await main(["board-token", "--server", SERVER, "--user", "alice@contoso.com"],
    line => lines.push(line), line => errors.push(line), {
      acquireToken: async () => ({ accessToken: "private-token-canary", account: { username: "bob@contoso.com" } }),
      fetchImpl: async url => {
        assert.equal(url.pathname, "/api/health")
        return response(401, { headers: { "www-authenticate": CHALLENGE } })
      },
    })
  assert.equal(exit, EXIT_ERROR)
  assert.deepEqual(lines, [])
  assert.match(errors[0], /Signed in as bob@contoso.com, not alice@contoso.com/)
})

test("status without a saved session says how to sign in", async () => {
  const lines = []
  assert.equal(await main(["status", "--server", SERVER], (line) => lines.push(line)), EXIT_ERROR)
  assert.match(lines[0], /clippy-auth login --server https:\/\/clippy\.example\.net/)
})

test("rejects the removed model-token commands", () => {
  assert.throws(() => parseArgs(["login", "--resource", "https://cognitiveservices.azure.com", "--user", "alice@contoso.com"]), /Unknown/)
  assert.throws(() => parseArgs(["get-access-token", "--server", SERVER]), /Usage/)
})

const WAM_OPTIONS = {
  authority: "https://login.microsoftonline.com/tenant-id", clientId: "public-client",
  scopes: ["app-id/user_impersonation"], user: "alice@contoso.com",
}
class MockInteractionRequiredAuthError extends Error {}

async function fakeAzureCli() {
  const directory = path.join(configHome, "azure-cli-install", "wbin")
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, "az.cmd"), "not executed")
  await fs.writeFile(path.join(directory, "..", "python.exe"), "")
  return { ...process.env, PATH: directory }
}

function brokerApplication(app) {
  return async () => ({ app, InteractionRequiredAuthError: MockInteractionRequiredAuthError })
}

test("worker WAM interaction delegates window discovery to MSAL without invoking PowerShell", { skip: process.platform !== "win32" }, async (t) => {
  t.mock.method(childProcess, "execFile", assert.fail)
  const token = { accessToken: "worker-token" }
  const result = await acquireToken(WAM_OPTIONS, brokerApplication({
    getAllAccounts: async () => [],
    acquireTokenInteractive: async (request) => {
      assert.deepEqual(request.scopes, WAM_OPTIONS.scopes)
      assert.equal(request.loginHint, WAM_OPTIONS.user)
      assert.equal(request.windowHandle, undefined)
      await assert.rejects(request.openBrowser(), /WAM should handle sign-in without a browser/)
      return token
    },
  }))
  assert.equal(result, token)
})

test("worker WAM renewal selects the requested account and never opens UI silently", { skip: process.platform !== "win32" }, async (t) => {
  t.mock.method(childProcess, "execFile", assert.fail)
  const account = { username: "Alice@Contoso.com" }
  const token = { accessToken: "worker-token" }
  const app = {
    getAllAccounts: async () => [{ username: "bob@contoso.com" }, account],
    acquireTokenSilent: async (request) => { assert.equal(request.account, account); return token },
    acquireTokenInteractive: assert.fail,
  }
  assert.equal(await acquireToken({ ...WAM_OPTIONS, silentOnly: true }, brokerApplication(app)), token)
  app.acquireTokenSilent = async () => { throw new MockInteractionRequiredAuthError() }
  await assert.rejects(acquireToken({ ...WAM_OPTIONS, silentOnly: true }, brokerApplication(app)), InteractionRequiredError)
})

test("unavailable native broker fails before constructing a browser client", async () => {
  await assert.rejects(createBrokerApplication(WAM_OPTIONS, async () => ({
    msal: { PublicClientApplication: class { constructor() { assert.fail("No browser client may be created") } } },
    extensions: { NativeBrokerPlugin: class { isBrokerAvailable = false } },
  })), /WAM native broker is unavailable/)
})

test("unavailable native broker falls back to Azure CLI", { skip: process.platform !== "win32" }, async () => {
  const expected = { accessToken: "azure-cli-token" }
  assert.equal(await acquireToken(WAM_OPTIONS, async () => {
    throw new Error("WAM native broker is unavailable.")
  }, async (options) => {
    assert.equal(options, WAM_OPTIONS)
    return expected
  }), expected)
})

test("Azure CLI fallback uses an isolated cache and validates account and token identity", { skip: process.platform !== "win32" }, async () => {
  const accessToken = jwt({ preferred_username: WAM_OPTIONS.user, tid: "tenant-id" })
  const calls = []
  const result = await acquireTokenWithAzureCli({ ...WAM_OPTIONS, silentOnly: true }, {
    env: await fakeAzureCli(),
    run: async (command, args, options) => {
      calls.push({ command, args, env: options.env })
      if (args[2] === "account" && args[3] === "show") return { stdout: JSON.stringify({
        user: { type: "user", name: WAM_OPTIONS.user }, tenantId: "tenant-id",
      }) }
      return { stdout: JSON.stringify({ accessToken }) }
    },
  })
  assert.equal(result.accessToken, accessToken)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].command, path.join(configHome, "azure-cli-install", "python.exe"))
  assert.deepEqual(calls[1].args, ["-IBm", "azure.cli", "account", "get-access-token",
    "--scope", "app-id/user_impersonation", "--tenant", "tenant-id", "--output", "json"])
  assert.equal(calls[0].env.AZURE_CONFIG_DIR, azureCliConfigDir(WAM_OPTIONS))
  assert.match(calls[0].env.AZURE_CONFIG_DIR, /azure-cli[\\/]clippy-auth/)
})

test("Azure CLI fallback rejects a different signed-in user before requesting a token", { skip: process.platform !== "win32" }, async () => {
  let calls = 0
  await assert.rejects(acquireTokenWithAzureCli({ ...WAM_OPTIONS, silentOnly: true }, {
    env: await fakeAzureCli(),
    run: async () => {
      calls++
      return { stdout: JSON.stringify({ user: { type: "user", name: "mallory@contoso.com" }, tenantId: "tenant-id" }) }
    },
  }), InteractionRequiredError)
  assert.equal(calls, 1)
})

test("rejects untrusted authorities and malformed challenge resources", () => {
  for (const authority of [
    "http://login.microsoftonline.com/tenant-id/oauth2/authorize",
    "https://login.microsoftonline.com.attacker.test/tenant-id/oauth2/authorize",
    "https://login.microsoftonline.com@attacker.test/tenant-id/oauth2/authorize",
    "https://login.microsoftonline.com/tenant-id&invalid/oauth2/authorize",
    "https://login.microsoftonline.com/tenant-id/oauth2/authorize?unexpected=1",
  ]) {
    assert.equal(parseChallenge(CHALLENGE.replace(
      "https://login.microsoftonline.com/tenant-id/oauth2/v2.0/authorize", authority,
    )), null)
  }
  for (const resource of ["app-id&invalid", "app-id%PATH%", "app-id\ninvalid", "https://", "http://api.example.net"]) {
    assert.equal(parseChallenge(CHALLENGE.replace('resource_id="app-id"', `resource_id="${resource}"`)), null)
  }
  for (const cloud of ["login.microsoftonline.com", "login.microsoftonline.us", "login.microsoftonline.de", "login.chinacloudapi.cn"]) {
    for (const resource of ["app-id", "api://app-id", "https://api.example.net/service"]) {
      assert.equal(parseChallenge(CHALLENGE.replace("login.microsoftonline.com", cloud)
        .replace('resource_id="app-id"', `resource_id="${resource}"`)).resource, resource)
    }
  }
})

test("Entra transport rejects remote HTTP and URL credentials before any request", async () => {
  for (const server of ["http://clippy.example.net", "http://localhost.attacker.test", "https://alice@clippy.example.net"]) {
    assert.throws(() => serverOrigin(server), /HTTPS without URL credentials/)
    await assert.rejects(readChallenge(server, assert.fail), /HTTPS without URL credentials/)
    await assert.rejects(exchangeForSession(server, "token", assert.fail), /HTTPS without URL credentials/)
    await assert.rejects(sessionAccepted(server, "session", assert.fail), /HTTPS without URL credentials/)
  }
  for (const server of ["http://localhost:8080", "http://127.0.0.1:8080", "http://[::1]:8080", SERVER]) {
    assert.equal(serverOrigin(server), server)
  }
  await exchangeForSession(SERVER, "token", async (_url, init) => {
    assert.equal(init.redirect, "error")
    return response(200, { json: { authenticationToken: "session" } })
  })
})

test("Windows Azure CLI resolution never sends arguments through a batch shell", { skip: process.platform !== "win32" }, async () => {
  const env = await fakeAzureCli()
  const args = ["account", "get-access-token", "--scope", 'api://app/a b&|^%PATH%!"c']
  const invocation = await azureCliInvocation(args, { env })
  assert.equal(invocation.command, path.join(env.PATH, "..", "python.exe"))
  assert.deepEqual(invocation.args, ["-IBm", "azure.cli", ...args])
  await fs.writeFile(path.join(env.PATH, "az.exe"), "")
  assert.deepEqual(await azureCliInvocation(args, { env }), { command: path.join(env.PATH, "az.exe"), args })
  await fs.rm(path.join(env.PATH, "az.exe"))
  await fs.rm(invocation.command)
  await assert.rejects(azureCliInvocation(args, { env }), /bundled python.exe was not found/)
  await fs.rm(path.join(env.PATH, "az.cmd"))
  await assert.rejects(azureCliInvocation(args, { env }), /Azure CLI was not found on PATH/)
})

test("interactive Azure CLI fallback preserves scope boundaries and verifies the post-login identity", { skip: process.platform !== "win32" }, async () => {
  const scopes = ["api://app/scope", 'api://app/second&|^%PATH%!"scope']
  const accessToken = jwt({ preferred_username: WAM_OPTIONS.user, tid: "tenant-id" })
  let accountReads = 0
  let logins = 0
  const result = await acquireTokenWithAzureCli({ ...WAM_OPTIONS, scopes }, {
    env: await fakeAzureCli(),
    run: async (_command, args) => {
      if (args[3] === "show") {
        if (accountReads++ === 0) throw new Error("No account")
        return { stdout: JSON.stringify({ user: { type: "user", name: WAM_OPTIONS.user }, tenantId: "tenant-id" }) }
      }
      assert.equal(args[5], scopes.join(" "))
      return { stdout: JSON.stringify({ accessToken }) }
    },
    spawn: (command, args, options) => {
      logins++
      assert.equal(command, path.join(configHome, "azure-cli-install", "python.exe"))
      assert.deepEqual(args, ["-IBm", "azure.cli", "login", "--tenant", "tenant-id",
        "--scope", scopes.join(" "), "--allow-no-subscriptions", "--output", "none"])
      assert.equal(options.stdio, "inherit")
      assert.equal(options.env.AZURE_CONFIG_DIR, azureCliConfigDir(WAM_OPTIONS))
      const child = new EventEmitter()
      queueMicrotask(() => child.emit("exit", 0))
      return child
    },
  })
  assert.equal(result.accessToken, accessToken)
  assert.equal(accountReads, 2)
  assert.equal(logins, 1)
})
