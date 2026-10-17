import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import vm from "node:vm"
import test from "node:test"

const CLI = fileURLToPath(new URL("../cli.js", import.meta.url))
const SERVER = fileURLToPath(new URL("../server/index.js", import.meta.url))
const LAUNCHER = fileURLToPath(new URL("../../minicode.ps1", import.meta.url))
const TENANT = "11111111-1111-1111-1111-111111111111"

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "minicode model auth "))
  const config = path.join(root, "config")
  const env = { ...process.env, MINICODE_CONFIG_HOME: config, MINICODE_WEB_OPEN: "0", MINICODE_WEB_PORT: "0" }
  for (const key of [
    "OPENCODE_API_KEY", "OPENAI_API_KEY", "OPENCODE_MODEL", "OPENAI_MODEL",
    "AZURE_OPENAI_DEPLOYMENT", "AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_MODEL",
    "MINICODE_AUTH_ENTRY",
  ]) delete env[key]
  const children = []
  t.after(async () => {
    for (const { child, closed, powershell } of children) {
      if (child.exitCode === null && child.signalCode === null) {
        if (powershell) {
          const stop = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" })
          await once(stop, "close")
        } else child.kill()
      }
      await closed
    }
    await fs.rm(root, { recursive: true, force: true })
  })
  function start(script, args = [], input = "") {
    const powershell = script.endsWith(".ps1")
    const child = spawn(powershell ? "pwsh" : process.execPath,
      [...(powershell ? ["-NoProfile", "-File"] : []), script, ...args], { cwd: root, env, windowsHide: true })
    let output = ""
    child.stdout.on("data", (chunk) => { output += chunk })
    child.stderr.on("data", (chunk) => { output += chunk })
    const closed = once(child, "close").then(([code]) => ({ code, output }))
    children.push({ child, closed, powershell })
    child.stdin.end(input)
    return { child, closed, get output() { return output } }
  }
  return {
    config, start, env,
    async cli(args, input) {
      const result = await start(CLI, args, input).closed
      assert.equal(result.code, 0, result.output)
      assert.ok(!result.output.includes("fixture-secret"))
      return result.output.replace(/\u001b\[[0-9;]*m/g, "")
    },
  }
}

async function portalOrigin(portal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Portal did not start: ${portal.output}`)), 10_000)
    portal.child.stdout.on("data", () => {
      const match = portal.output.match(/minicode web portal: (http:\/\/127\.0\.0\.1:\d+)/)
      if (match) { clearTimeout(timer); resolve(match[1]) }
    })
    portal.closed.then(() => { clearTimeout(timer); reject(new Error(`Portal exited: ${portal.output}`)) })
  })
}

test("model auth rejects the removed helper flag and identity flags outside auth add", { timeout: 15_000 }, async (t) => {
  const app = await fixture(t)
  const removed = await app.start(CLI, ["auth", "add", "azure-resource",
    "--entra-user", "alice@contoso.com", "--clippy-auth", "old-helper.js"]).closed
  assert.equal(removed.code, 1)
  assert.match(removed.output, /only supported with worker.*Model sign-in uses Azure CLI/)
  const wrongLogin = await app.start(CLI, ["auth", "login", "--entra-user", "bob@contoso.com"]).closed
  assert.equal(wrongLogin.code, 1)
  assert.match(wrongLogin.output, /only supported with auth add/)
})

test("web API and toolbar show the selected UPN or Azure CLI marker without obtaining a token", { timeout: 15_000 }, async (t) => {
  const app = await fixture(t)
  await app.cli(["auth", "add", "azure-resource"])
  const file = path.join(app.config, "auth.json")
  const auth = JSON.parse(await fs.readFile(file, "utf8"))
  Object.assign(auth["azure-entra"].deployments["azure-resource"], {
    credentialProvider: "azure-cli", user: "alice@contoso.com", tenant: TENANT,
    azureConfigDir: path.join(app.config, "azure-cli", "fixture-cache"),
  })
  await fs.writeFile(file, JSON.stringify(auth))
  const portal = app.start(SERVER)
  const origin = await portalOrigin(portal)
  const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8")
  async function assertDisplay(user) {
    const response = await fetch(`${origin}/api/info`)
    assert.equal(response.status, 200)
    const info = await response.json()
    assert.equal(info.user, user)
    const repoEl = {}
    await vm.runInNewContext(source, {
      window: { Terminal: {}, FitAddon: { FitAddon: {} }, addEventListener() {} },
      document: { getElementById: () => repoEl, querySelectorAll: () => [] },
      fetch: async () => ({ json: async () => info }),
      location: { host: new URL(origin).host },
      WebSocket: class { addEventListener() {} },
    })
    assert.equal(repoEl.textContent, `${info.repoRoot} · ${info.deployment} · ${info.model} · ${user}`)
    assert.ok(!JSON.stringify(info).includes("fixture-secret"))
  }
  await assertDisplay("alice@contoso.com")
  await app.cli(["auth", "add", "cli-resource"])
  await assertDisplay("login@az.cli")
})

test("web auth overrides stay independent across launcher processes without changing the saved active entry", {
  skip: process.platform !== "win32", timeout: 20_000,
}, async (t) => {
  const app = await fixture(t)
  await app.cli(["auth", "add", "azure-alice", "--model", "alice-model"])
  await app.cli(["auth", "add", "azure-bob", "--model", "bob-model"])
  const file = path.join(app.config, "auth.json")
  const auth = JSON.parse(await fs.readFile(file, "utf8"))
  for (const user of ["alice", "bob"]) {
    Object.assign(auth["azure-entra"].deployments[`azure-${user}`], {
      credentialProvider: "azure-cli", user: `${user}@contoso.com`, tenant: TENANT,
      azureConfigDir: path.join(app.config, "azure-cli", user),
    })
  }
  await fs.writeFile(file, JSON.stringify(auth))
  const saved = await fs.readFile(file, "utf8")
  app.env.AZURE_OPENAI_DEPLOYMENT = "missing-env-entry"
  app.env.OPENCODE_API_KEY = "unused-api-key"
  const alice = app.start(LAUNCHER, ["web", "0", "--auth", "azure-alice"])
  const bob = app.start(CLI, ["web", "--auth", "azure-bob", "0"])
  const origins = await Promise.all([portalOrigin(alice), portalOrigin(bob)])
  assert.equal(await fs.readFile(file, "utf8"), saved)
  await app.cli(["auth", "add", "third-resource"])
  for (const [index, user] of ["alice", "bob"].entries()) {
    const response = await fetch(`${origins[index]}/api/info`)
    assert.equal(response.status, 200)
    const info = await response.json()
    assert.equal(info.deployment, `azure-${user}`)
    assert.equal(info.model, `${user}-model`)
    assert.equal(info.user, `${user}@contoso.com`)
  }
  assert.equal(JSON.parse(await fs.readFile(file, "utf8"))["azure-entra"].active, "third-resource")
})

test("web rejects missing or unknown auth entries before starting a server or changing configuration", { timeout: 15_000 }, async (t) => {
  const app = await fixture(t)
  await app.cli(["auth", "add", "existing-resource"])
  const file = path.join(app.config, "auth.json")
  const saved = await fs.readFile(file, "utf8")
  for (const [args, message] of [
    [["web", "--auth"], /Missing value for --auth/],
    [["web", "--auth", "--model", "some-model"], /Missing value for --auth/],
    [["web", "--auth", "unknown-resource"], /unknown-resource.*not configured/],
  ]) {
    const result = await app.start(CLI, args).closed
    assert.equal(result.code, 1)
    assert.match(result.output, message)
    assert.ok(!result.output.includes("minicode web portal:"))
    assert.equal(await fs.readFile(file, "utf8"), saved)
  }
})

test("worker identity flags still reach the worker's separate Easy Auth flow", { timeout: 10_000 }, async (t) => {
  const app = await fixture(t)
  const helper = path.join(path.dirname(app.config), "missing worker helper.js")
  const worker = app.start(CLI, ["worker", "--server", "https://clippy.example.test",
    "--worker-id", TENANT, "--repo-root", path.dirname(app.config),
    "--entra-user", "worker@contoso.com", "--clippy-auth", helper])
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Worker did not request sign-in: ${worker.output}`)), 5000)
    worker.child.stderr.on("data", () => {
      if (worker.output.includes("Clippy needs an Entra sign-in for worker@contoso.com")) {
        clearTimeout(timer)
        resolve()
      }
    })
    worker.closed.then(() => { clearTimeout(timer); reject(new Error(`Worker exited: ${worker.output}`)) })
  })
  assert.ok(worker.output.includes(helper))
  assert.match(worker.output, /login --server https:\/\/clippy\.example\.test --user worker@contoso\.com/)
})

test("auth add entra-user invokes Azure CLI with a persistent isolated cache", { skip: process.platform !== "win32", timeout: 15_000 }, async (t) => {
  const app = await fixture(t)
  const directory = path.dirname(app.config)
  const bin = path.join(directory, "azure cli bin")
  const script = path.join(bin, "az.cjs")
  const log = path.join(directory, "az-calls.jsonl")
  await fs.mkdir(bin)
  await fs.writeFile(script, `
const fs = require("node:fs")
const path = require("node:path")
const args = process.argv.slice(2)
const cache = process.env.AZURE_CONFIG_DIR
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cache }) + "\\n")
const account = path.join(cache, "fixture-account.json")
if (args[0] === "login") {
  fs.writeFileSync(account, JSON.stringify({ user: { type: "user", name: process.env.FIXTURE_AZ_USER }, tenantId: ${JSON.stringify(TENANT)} }))
} else if (args[1] === "show") {
  console.log(fs.readFileSync(account, "utf8"))
} else if (args[1] === "get-access-token") {
  const user = JSON.parse(fs.readFileSync(account, "utf8")).user.name
  const payload = Buffer.from(JSON.stringify({ upn: user, tid: ${JSON.stringify(TENANT)} })).toString("base64url")
  console.log(JSON.stringify({ accessToken: "header." + payload + ".fixture-secret", tenant: ${JSON.stringify(TENANT)}, expires_on: Math.floor(Date.now() / 1000) + 3600 }))
} else process.exit(1)
`)
  await fs.writeFile(path.join(bin, "az.cmd"), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`)
  app.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
  app.env.FIXTURE_AZ_USER = "alice@contoso.com"
  const aliceLabel = "azure-alice · gpt-5.6-sol · alice@contoso.com"
  assert.ok((await app.cli(["auth", "add", "azure-alice", "--entra-user", "alice@contoso.com"])).includes(aliceLabel))
  app.env.FIXTURE_AZ_USER = "bob@contoso.com"
  await app.cli(["auth", "add", "azure-bob", "--entra-user", "bob@contoso.com", "--tenant", TENANT])
  await app.cli(["auth", "use", "azure-alice"])
  assert.ok((await app.cli([], "/model\nexit\n")).includes(aliceLabel))
  const calls = (await fs.readFile(log, "utf8")).trim().split("\n").map(JSON.parse)
  const logins = calls.filter((call) => call.args[0] === "login")
  assert.equal(logins.length, 2)
  assert.notEqual(logins[0].cache, logins[1].cache)
  assert.ok(logins.every((call) => call.args.includes("--allow-no-subscriptions") && !call.args.includes("--username")))
  assert.ok(logins[1].args.includes(TENANT))
  assert.equal(calls.at(-1).cache, logins[0].cache, "new processes reuse the originally selected identity cache")
  const saved = await fs.readFile(path.join(app.config, "auth.json"), "utf8")
  assert.ok(!saved.includes("fixture-secret"))
  assert.equal(JSON.parse(saved)["azure-entra"].deployments["azure-alice"].credentialProvider, "azure-cli")
  assert.ok((await app.cli(["auth", "list"])).includes(aliceLabel))
  app.env.FIXTURE_AZ_USER = "alice@contoso.com"
  assert.ok((await app.cli(["auth", "login"])).includes(aliceLabel))
})
