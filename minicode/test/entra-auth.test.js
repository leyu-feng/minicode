import assert from "node:assert/strict"
import fs from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import { createEntraSession, isEasyAuthChallenge, loginCommand, readSavedSession, runSilentLogin } from "../server/entra-session.js"
import { startEntraProxy } from "../server/entra-proxy.js"

const SERVER = "https://clippy.example.net"
const CHALLENGE = 'Bearer realm="x" authorization_uri="https://login.microsoftonline.com/t/oauth2/v2.0/authorize" resource_id="app"'

let configHome
beforeEach(async () => {
  configHome = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-entra-test-"))
  process.env.MINICODE_CONFIG_HOME = configHome
})
afterEach(async () => {
  delete process.env.MINICODE_CONFIG_HOME
  await fs.rm(configHome, { recursive: true, force: true })
})

async function saveSession(server, user, token, createdAt = new Date().toISOString(), expiresAt = new Date(Date.now() + 86_400_000).toISOString()) {
  const directory = path.join(configHome, "entra", new URL(server).host)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, `${user.toLowerCase()}.json`), JSON.stringify({
    version: 1, server, user, sessionToken: token, createdAt, expiresAt,
  }))
}

async function fakeClippyAuth(source) {
  const directory = path.join(configHome, "clippy-auth")
  await fs.mkdir(path.join(directory, "node_modules"), { recursive: true })
  const file = path.join(directory, "cli.js")
  await fs.writeFile(file, source)
  return file
}

test("tells Easy Auth's challenge from Clippy's own 401", () => {
  assert.equal(isEasyAuthChallenge(401, CHALLENGE), true)
  assert.equal(isEasyAuthChallenge(401, 'Bearer realm="clippy"'), false)
  assert.equal(isEasyAuthChallenge(200, CHALLENGE), false)
})

test("reads the session clippy-auth saved for a user", async () => {
  await saveSession(SERVER, "alice@contoso.com", "alice-session")
  assert.equal((await readSavedSession(SERVER, "Alice@Contoso.com")).sessionToken, "alice-session")
  assert.equal(await readSavedSession(SERVER, "bob@contoso.com"), null)
})

test("silent sign-in reports success, interaction and a missing install", async () => {
  const ok = await fakeClippyAuth("process.exit(0)\n")
  assert.deepEqual(await runSilentLogin({ server: SERVER, user: "a@b.c", clippyAuth: ok }), { ok: true })
  const needsUser = await fakeClippyAuth("process.exit(2)\n")
  assert.match((await runSilentLogin({ server: SERVER, user: "a@b.c", clippyAuth: needsUser })).reason, /needs you/)
  assert.match((await runSilentLogin({ server: SERVER, clippyAuth: path.join(configHome, "missing.js") })).reason, /not found/)
})

test("silent sign-in is killed after the timeout", async () => {
  const hangs = await fakeClippyAuth("setInterval(() => {}, 1000)\n")
  const started = Date.now()
  const result = await runSilentLogin({ server: SERVER, user: "a@b.c", clippyAuth: hangs, timeoutMs: 300 })
  assert.match(result.reason, /did not finish within 0.3s/)
  assert.ok(Date.now() - started < 3000)
})

test("without a session it prints the interactive command and waits for the user to sign in", async () => {
  const logs = []
  const session = createEntraSession({
    server: SERVER, user: "alice@contoso.com", clippyAuth: "C:/tools/clippy-auth/cli.js",
    silentLogin: async () => ({ ok: false, reason: "silent sign-in did not finish within 5s" }),
    log: (line) => logs.push(line), pollMs: 20,
  })
  const ready = session.ensure()
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.match(logs[0], /did not finish within 5s/)
  assert.ok(logs[0].includes(loginCommand({ server: SERVER, user: "alice@contoso.com", clippyAuth: "C:/tools/clippy-auth/cli.js" })))
  await saveSession(SERVER, "alice@contoso.com", "fresh-session")
  await ready
  assert.equal(session.token(), "fresh-session")
  assert.match(logs.at(-1), /Entra session ready for alice@contoso.com/)
})

test("an existing usable session needs no sign-in", async () => {
  await saveSession(SERVER, "alice@contoso.com", "saved-session")
  const session = createEntraSession({
    server: SERVER, user: "alice@contoso.com",
    silentLogin: async () => { throw new Error("should not sign in") }, log: () => {},
  })
  await session.ensure()
  assert.equal(session.token(), "saved-session")
})

test("the proxy adds the session, keeps the agent's token, and renews once on Easy Auth's 401", async (t) => {
  const seen = []
  let refuse = true
  const upstream = http.createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk
    seen.push({ path: request.url, session: request.headers["x-zumo-auth"], auth: request.headers.authorization, body })
    if (refuse && request.headers["x-zumo-auth"] === "old") {
      response.writeHead(401, { "www-authenticate": CHALLENGE }).end()
      return
    }
    response.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }))
  })
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve) => upstream.close(resolve)))

  let token = "old"
  const session = { token: () => token, renew: async () => { token = "new" } }
  const proxy = await startEntraProxy({ server: `http://127.0.0.1:${upstream.address().port}`, session })
  t.after(() => proxy.close())

  const target = proxy.rewrite("https://clippy.example.net/api/issues/1/comments?x=1")
  const response = await fetch(target, {
    method: "POST", headers: { authorization: "Bearer agent-run-token", "content-type": "application/json" },
    body: JSON.stringify({ body: "done" }),
  })
  assert.equal(response.status, 201)
  assert.deepEqual(seen.map((request) => request.session), ["old", "new"])
  assert.ok(seen.every((request) => request.path === "/api/issues/1/comments?x=1"))
  assert.ok(seen.every((request) => request.auth === "Bearer agent-run-token"))
  assert.ok(seen.every((request) => request.body === JSON.stringify({ body: "done" })))

  const outside = new URL(target)
  outside.pathname = "/api/issues/1/comments"
  assert.equal((await fetch(outside)).status, 404)
})

test("the proxy rejects alternate authorities before reading or forwarding credentials", async (t) => {
  const seen = []
  function capture(request, response) {
    seen.push(request.headers)
    response.end("unexpected upstream request")
  }
  const upstream = http.createServer(capture)
  const other = http.createServer(capture)
  for (const server of [upstream, other]) {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    t.after(() => new Promise((resolve) => server.close(resolve)))
  }

  let tokenReads = 0
  let renewals = 0
  const proxy = await startEntraProxy({
    server: `http://127.0.0.1:${upstream.address().port}`,
    session: {
      token: () => { tokenReads++; return "dummy-human-session" },
      renew: async () => { renewals++ },
    },
  })
  t.after(() => proxy.close())
  const proxyUrl = new URL(proxy.origin)
  const authority = `127.0.0.1:${other.address().port}`
  for (const suffix of [
    `//${authority}/capture`,
    `///${authority}/capture`,
    `/\\${authority}/capture`,
    `/\\\\${authority}/capture`,
    `//dummy-user@${authority}/capture`,
    `//127.0.0.1:${upstream.address().port}/capture`,
  ]) {
    const status = await new Promise((resolve, reject) => {
      const request = http.request(proxyUrl, {
        path: `${proxyUrl.pathname}${suffix}`,
        headers: { authorization: "Bearer dummy-agent-token" },
      }, (response) => {
        response.resume()
        response.on("end", () => resolve(response.statusCode))
      })
      request.on("error", reject)
      request.end()
    })
    assert.equal(status, 400, suffix)
  }
  assert.equal(tokenReads, 0)
  assert.equal(renewals, 0)
  assert.deepEqual(seen, [])
})
