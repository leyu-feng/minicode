import assert from "node:assert/strict"
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

const execFileAsync = promisify(execFile)
const windows = process.platform === "win32"

async function publish(t, { buildOnly = false, fail = "", dirty = false, tag, latestMismatch = false, invalidLogin = false, engine = "linux", connectionEnv = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "clippy publish test "))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const context = path.join(root, "clippy")
  const tools = path.join(root, "tools")
  await fs.mkdir(context)
  await fs.mkdir(tools)
  await fs.copyFile(new URL("../../publish-clippy.ps1", import.meta.url), path.join(root, "publish-clippy.ps1"))
  await fs.writeFile(path.join(root, "fixture.ps1"), `
param([string]$RegistryName, [string]$Subscription, [string]$Tag, [switch]$BuildOnly)
try { & (Join-Path $PSScriptRoot "publish-clippy.ps1") @PSBoundParameters }
finally {
  @{ CONTAINER_HOST = $env:CONTAINER_HOST; CONTAINER_CONNECTION = $env:CONTAINER_CONNECTION; CONTAINER_SSHKEY = $env:CONTAINER_SSHKEY } |
    ConvertTo-Json | Set-Content -LiteralPath $env:PUBLISH_TEST_RESTORED
}
`)
  await fs.writeFile(path.join(context, "Dockerfile"), "FROM scratch\n")
  await fs.writeFile(path.join(context, ".gitattributes"), "* text=auto eol=lf\n")
  await fs.writeFile(path.join(context, ".gitignore"), ".env\nnode_modules/\n")
  const git = (...args) => execFileAsync("git", args, { cwd: root, windowsHide: true })
  await git("init", "--initial-branch=main")
  await git("add", "clippy")
  await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "Fixture")
  const commit = (await git("rev-parse", "HEAD")).stdout.trim()
  await fs.writeFile(path.join(context, ".env"), "SECRET=local-fixture-secret")
  await fs.mkdir(path.join(context, "node_modules"))
  if (dirty) await fs.writeFile(path.join(context, "uncommitted.js"), "// uncommitted\n")
  const npmrc = path.join(root, "user.npmrc")
  await fs.writeFile(npmrc, "registry=https://feed.example.test/\n//feed.example.test/:_authToken=fixture-secret\n")
  const callsFile = path.join(root, "calls.jsonl")
  const stub = path.join(tools, "stub.cjs")
  await fs.writeFile(stub, `
const fs = require("node:fs")
const path = require("node:path")
const [tool, ...args] = process.argv.slice(2)
const stage = tool + ":" + args[0]
const call = { tool, args, connectionHost: process.env.CONTAINER_HOST || null,
  namedConnection: process.env.CONTAINER_CONNECTION || null, connectionKey: process.env.CONTAINER_SSHKEY || null }
if (stage === "podman:build") {
  const context = args.at(-1)
  call.secretIncluded = fs.existsSync(path.join(context, ".env"))
  call.dependenciesIncluded = fs.existsSync(path.join(context, "node_modules"))
  call.gitIncluded = fs.existsSync(path.join(context, ".git"))
  call.dockerfile = fs.readFileSync(path.join(context, "Dockerfile"), "utf8")
  call.recipe = fs.readFileSync(args[args.indexOf("--file") + 1], "utf8")
  call.connectionHost = process.env.CONTAINER_HOST
  call.namedConnection = process.env.CONTAINER_CONNECTION || null
}
fs.appendFileSync(process.env.PUBLISH_TEST_CALLS, JSON.stringify(call) + "\\n")
if (stage === process.env.PUBLISH_TEST_FAIL) process.exit(23)
if (stage === "podman:push" && args.at(-1).endsWith(":latest") && process.env.PUBLISH_TEST_FAIL === "latest") process.exit(23)
if (stage === "podman:info") console.log(process.env.PUBLISH_TEST_ENGINE)
if (stage === "podman:system") console.log(JSON.stringify([
  { Name: "fixture-machine", Default: true, IsMachine: true,
    URI: "ssh://fixture@localhost:12345/run/podman.sock", Identity: "fixture-private-key-path" },
  { Name: "fixture-explicit", Default: false, IsMachine: true,
    URI: "ssh://fixture@localhost:54321/run/podman.sock", Identity: "explicit-private-key-path" }]))
if (stage === "podman:image") console.log("linux/amd64")
if (stage === "podman:login") {
  if (fs.readFileSync(0, "utf8").trim() !== "registry-private-fixture") process.exit(24)
  fs.writeFileSync(args[args.indexOf("--authfile") + 1], "private-fixture-auth")
}
if (tool === "npm") console.log(process.env.PUBLISH_TEST_NPMRC)
if (tool === "az" && args[1] === "show") console.log("fixture.azurecr.io")
if (tool === "az" && args[1] === "login") console.log(JSON.stringify({ accessToken: "registry-private-fixture",
  loginServer: process.env.PUBLISH_TEST_INVALID_LOGIN === "1" ? "other.azurecr.io" : "fixture.azurecr.io" }))
if (tool === "az" && args[1] === "repository") console.log("sha256:" + (args.includes("clippy:latest") && process.env.PUBLISH_TEST_LATEST_MISMATCH === "1" ? "d" : "c").repeat(64))
`)
  for (const tool of ["podman", "az", "npm"]) {
    await fs.writeFile(path.join(tools, `${tool}.cmd`), `@echo off\r\n"${process.execPath}" "${stub}" ${tool} %*\r\nexit /b %errorlevel%\r\n`)
  }
  const args = buildOnly ? ["-BuildOnly"] : ["-RegistryName", "fixture", "-Subscription", "fixture-subscription"]
  if (tag) args.push("-Tag", tag)
  const child = spawn("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", path.join(root, "fixture.ps1"), ...args,
  ], {
    cwd: os.tmpdir(), windowsHide: true,
    env: {
      ...process.env, PATH: `${tools}${path.delimiter}${process.env.PATH}`,
      PUBLISH_TEST_CALLS: callsFile, PUBLISH_TEST_FAIL: fail, PUBLISH_TEST_NPMRC: npmrc,
      PUBLISH_TEST_LATEST_MISMATCH: latestMismatch ? "1" : "0",
      PUBLISH_TEST_INVALID_LOGIN: invalidLogin ? "1" : "0", PUBLISH_TEST_ENGINE: engine,
      CONTAINER_HOST: "", CONTAINER_CONNECTION: "", CONTAINER_SSHKEY: "",
      ...connectionEnv, PUBLISH_TEST_RESTORED: path.join(root, "restored.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  child.stdout.on("data", (chunk) => { output += chunk })
  child.stderr.on("data", (chunk) => { output += chunk })
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", resolve)
  })
  const calls = (await fs.readFile(callsFile, "utf8")).trim().split("\n").map(JSON.parse)
  const restored = JSON.parse((await fs.readFile(path.join(root, "restored.json"), "utf8")).replace(/^\uFEFF/, ""))
  return { code, output, calls, commit, restored }
}

test("Clippy publishes committed Linux production source and verifies its registry digest", { skip: !windows }, async (t) => {
  const result = await publish(t)
  assert.equal(result.code, 0, result.output)
  const build = result.calls.find((call) => call.args[0] === "build")
  assert.ok(build)
  assert.equal(build.secretIncluded, false)
  assert.equal(build.dependenciesIncluded, false)
  assert.equal(build.gitIncluded, false)
  assert.equal(build.dockerfile, "FROM scratch\n")
  assert.equal(build.recipe, "FROM scratch\n")
  assert.equal(build.connectionHost, "ssh://fixture@localhost:12345/run/podman.sock")
  assert.equal(build.namedConnection, null)
  assert.equal(result.calls.find((call) => call.args[0] === "image").connectionHost, null)
  assert.deepEqual(result.calls.find((call) => call.tool === "npm").args, ["config", "get", "userconfig"])
  assert.equal(build.args[build.args.indexOf("--target") + 1], "production")
  assert.equal(build.args[build.args.indexOf("--platform") + 1], "linux/amd64")
  assert.equal(build.args[build.args.indexOf("--format") + 1], "docker")
  assert.ok(!build.args.includes("--load"))
  assert.ok(build.args.includes(`PAPERCLIP_BUILD_COMMIT=${result.commit}`))
  assert.ok(build.args.includes("PROVIDER_PACK_EXCLUDE=pi,cursor"))
  const secret = build.args[build.args.indexOf("--secret") + 1]
  assert.match(secret, /^id=npmrc,src=.*user\.npmrc$/)
  assert.ok(!JSON.stringify(build.args).includes("fixture-secret"))
  assert.ok(!result.output.includes("fixture-secret"))
  const image = build.args[build.args.indexOf("--tag") + 1]
  assert.match(image, /^fixture\.azurecr\.io\/clippy:\d{8}-\d{6}-[a-f0-9]{12}$/)
  const login = result.calls.find((call) => call.tool === "podman" && call.args[0] === "login")
  const authfile = login.args[login.args.indexOf("--authfile") + 1]
  assert.ok(login.args.includes("--password-stdin"))
  assert.deepEqual(result.calls.filter((call) => call.args[0] === "push").map((call) => call.args), [
    ["push", "--authfile", authfile, image], ["push", "--authfile", authfile, "fixture.azurecr.io/clippy:latest"],
  ])
  assert.deepEqual(result.calls.find((call) => call.args[0] === "tag").args, ["tag", image, "fixture.azurecr.io/clippy:latest"])
  assert.ok(result.output.includes(`Published image: ${image}`))
  assert.ok(result.output.includes("Published image: fixture.azurecr.io/clippy:latest"))
  const azure = result.calls.filter((call) => call.tool === "az")
  assert.deepEqual(azure.map((call) => call.args.slice(0, 2)), [["acr", "show"], ["acr", "login"], ["acr", "repository"], ["acr", "repository"]])
  assert.ok(azure.every((call) => call.args[call.args.indexOf("--subscription") + 1] === "fixture-subscription"))
  assert.ok(azure.find((call) => call.args[1] === "login").args.includes("--expose-token"))
  assert.ok(!JSON.stringify(result.calls).includes("registry-private-fixture"))
  assert.ok(!result.output.includes("registry-private-fixture"))
  assert.ok(result.output.includes(`fixture.azurecr.io/clippy@sha256:${"c".repeat(64)}`))
  await assert.rejects(fs.stat(path.dirname(build.args.at(-1))), { code: "ENOENT" })
})

test("Clippy build-only does not authenticate or upload", { skip: !windows }, async (t) => {
  const result = await publish(t, { buildOnly: true })
  assert.equal(result.code, 0, result.output)
  assert.ok(result.calls.every((call) => call.tool !== "az" && call.args[0] !== "push"))
  assert.match(result.output, /Built local image: clippy:/)
})

test("Clippy honors the named Podman machine and restores its transport after success or failure", { skip: !windows }, async (t) => {
  const connectionEnv = {
    CONTAINER_HOST: "ssh://original-host/run/podman.sock",
    CONTAINER_CONNECTION: "fixture-explicit",
    CONTAINER_SSHKEY: "original-private-key-path",
  }
  for (const fail of ["", "podman:build"]) {
    const result = await publish(t, { buildOnly: true, fail, connectionEnv })
    assert.equal(result.code === 0, !fail, result.output)
    const build = result.calls.find((call) => call.args[0] === "build")
    assert.equal(build.connectionHost, "ssh://fixture@localhost:54321/run/podman.sock")
    assert.equal(build.namedConnection, null)
    assert.equal(build.connectionKey, "explicit-private-key-path")
    assert.deepEqual(result.restored, connectionEnv)
  }
})

test("Clippy retains a versioned rollback tag when latest is requested explicitly", { skip: !windows }, async (t) => {
  const result = await publish(t, { tag: "latest" })
  assert.equal(result.code, 0, result.output)
  const pushes = result.calls.filter((call) => call.args[0] === "push")
  assert.match(pushes[0].args.at(-1), /:\d{8}-\d{6}-[a-f0-9]{12}$/)
  assert.equal(pushes[1].args.at(-1), "fixture.azurecr.io/clippy:latest")
})

test("Clippy reports failure if latest cannot be pushed or has a different digest", { skip: !windows }, async (t) => {
  for (const options of [{ fail: "latest" }, { latestMismatch: true }]) {
    const result = await publish(t, options)
    assert.notEqual(result.code, 0)
    assert.match(result.output, /failed \(exit 23\)|latest tag does not match/)
    assert.ok(!result.output.includes("Published image:"))
  }
})

test("Clippy stops on login, build and push failures and cleans temporary source", { skip: !windows }, async (t) => {
  for (const fail of ["az:acr", "podman:login", "podman:build", "podman:push"]) {
    await t.test(fail, async (t) => {
      const result = await publish(t, { fail })
      assert.notEqual(result.code, 0)
      assert.match(result.output, /failed \(exit 23\)/)
      assert.equal(`${result.calls.at(-1).tool}:${result.calls.at(-1).args[0]}`, fail)
      assert.ok(!result.output.includes("Published image:"))
      const build = result.calls.find((call) => call.args[0] === "build")
      if (build) await assert.rejects(fs.stat(path.dirname(build.args.at(-1))), { code: "ENOENT" })
      const login = result.calls.find((call) => call.args[0] === "login")
      if (login) await assert.rejects(fs.stat(path.dirname(login.args[login.args.indexOf("--authfile") + 1])), { code: "ENOENT" })
    })

  }
})

test("Clippy rejects a mismatched registry token and a non-Linux engine before building", { skip: !windows }, async (t) => {
  for (const options of [{ invalidLogin: true }, { engine: "windows" }]) {
    const result = await publish(t, options)
    assert.notEqual(result.code, 0)
    assert.ok(!result.calls.some((call) => call.args[0] === "build"))
    assert.match(result.output, /valid login token|Linux engine/)
  }
})

test("Clippy refuses to silently omit uncommitted application changes", { skip: !windows }, async (t) => {
  const result = await publish(t, { dirty: true })
  assert.notEqual(result.code, 0)
  assert.match(result.output, /image uses committed source only/)
  assert.deepEqual(result.calls.map((call) => call.args[0]), ["config", "info"])
})
