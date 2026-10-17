import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, test } from "node:test"

import { isEasyAuthChallenge, parseChallenge, readChallenge } from "../src/challenge.js"
import { exchangeForSession, jwtExpiry, sessionAccepted } from "../src/easyauth.js"
import { readSession, removeSession, sessionPath, writeSession } from "../src/session-store.js"
import { EXIT_ERROR, main, parseArgs } from "../cli.js"

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

test("status without a saved session says how to sign in", async () => {
  const lines = []
  assert.equal(await main(["status", "--server", SERVER], (line) => lines.push(line)), EXIT_ERROR)
  assert.match(lines[0], /clippy-auth login --server https:\/\/clippy\.example\.net/)
})
