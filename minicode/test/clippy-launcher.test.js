import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

async function launch(t, { version = "9.15.4", bootstrapExit = 0, devExit = 0, localHome = false, existingDatabase = false, databaseUrl = null, useCurrentFolder = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "clippy launcher test "))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.copyFile(new URL("../../clippy.ps1", import.meta.url), path.join(root, "clippy.ps1"))
  const app = path.join(root, "clippy")
  const bin = path.join(root, "tools")
  const packagePath = path.join(root, "resolved", "node_modules", "pnpm")
  const shim = path.join(packagePath, "..", ".bin", "pnpm.cmd")
  await Promise.all([
    fs.mkdir(app, { recursive: true }),
    fs.mkdir(bin, { recursive: true }),
    fs.mkdir(path.dirname(shim), { recursive: true }),
    fs.mkdir(path.join(packagePath, "bin"), { recursive: true }),
  ])
  await fs.writeFile(path.join(app, "package.json"), JSON.stringify({ packageManager: "pnpm@9.15.4" }))
  await fs.writeFile(path.join(packagePath, "package.json"), JSON.stringify({ version }))
  await fs.writeFile(shim, `@echo off\r\necho ${version}\r\n`)
  const home = path.join(root, localHome ? ".clippy" : "data")
  const databaseVersionFile = path.join(home, "instances", "default", "db", "PG_VERSION")
  if (existingDatabase) {
    await fs.mkdir(path.dirname(databaseVersionFile), { recursive: true })
    await fs.writeFile(databaseVersionFile, "18")
  }
  await fs.writeFile(path.join(packagePath, "bin", "pnpm.cjs"), `
const fs = require("node:fs")
const call = {
  args: process.argv.slice(2), parent: process.ppid,
  root: process.env.CLIPPY_REPO_ROOT, port: process.env.PORT,
  home: process.env.PAPERCLIP_HOME, native: process.env.PAPERCLIP_DISABLE_NATIVE_RUNNER,
  existingDatabase: Boolean(process.env.PAPERCLIP_HOME && fs.existsSync(require("node:path").join(process.env.PAPERCLIP_HOME, "instances", "default", "db", "PG_VERSION"))),
  databaseUrl: process.env.DATABASE_URL,
}
if (process.argv[2] === "dev:once") {
  call.nestedVersion = require("node:child_process").execFileSync(
    process.env.ComSpec, ["/d", "/c", "pnpm.cmd --version"], { encoding: "utf8", windowsHide: true },
  ).trim()
}
fs.appendFileSync(process.env.LAUNCHER_TEST_CALLS, JSON.stringify(call) + "\\n")
if (process.argv[2] === "install") fs.mkdirSync("node_modules")
else process.exit(Number(process.env.LAUNCHER_TEST_DEV_EXIT))
`)
  await fs.writeFile(path.join(bin, "npm.cmd"), `@echo off
echo %*>> "%LAUNCHER_TEST_BOOTSTRAP%"
echo %LAUNCHER_TEST_SHIM%
exit /b %LAUNCHER_TEST_BOOTSTRAP_EXIT%
`)
  const callsPath = path.join(root, "calls.jsonl")
  const bootstrapPath = path.join(root, "bootstrap.txt")
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    LAUNCHER_TEST_CALLS: callsPath,
    LAUNCHER_TEST_BOOTSTRAP: bootstrapPath,
    LAUNCHER_TEST_SHIM: shim,
    LAUNCHER_TEST_BOOTSTRAP_EXIT: String(bootstrapExit),
    LAUNCHER_TEST_DEV_EXIT: String(devExit),
  }
  if (localHome) delete env.PAPERCLIP_HOME
  else env.PAPERCLIP_HOME = home
  if (databaseUrl) env.DATABASE_URL = databaseUrl
  else delete env.DATABASE_URL
  const child = spawn("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", path.join(root, "clippy.ps1"),
    ...(!useCurrentFolder ? ["-repo_root", root] : []),
    "-port", "43210",
  ], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    cwd: root,
    env,
  })
  let output = ""
  child.stdout.on("data", (chunk) => { output += chunk })
  child.stderr.on("data", (chunk) => { output += chunk })
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", resolve)
  })
  const calls = await fs.readFile(callsPath, "utf8").catch((error) => {
    if (error.code !== "ENOENT") throw error
    return ""
  })
  return {
    root, pid: child.pid, code, output,
    databaseVersion: existingDatabase ? await fs.readFile(databaseVersionFile, "utf8") : null,
    calls: calls.trim() ? calls.trim().split("\n").map(JSON.parse) : [],
    bootstrap: await fs.readFile(bootstrapPath, "utf8"),
  }
}

test("Clippy preserves an explicitly configured database and warns that it is not workspace-local", { skip: process.platform !== "win32" }, async (t) => {
  const databaseUrl = "postgres://localhost/launcher-test"
  const result = await launch(t, { databaseUrl, localHome: true })
  assert.equal(result.code, 0, result.output)
  const server = result.calls.find((call) => call.args[0] === "dev:once")
  assert.equal(server.databaseUrl, databaseUrl)
  assert.match(result.output, /DATABASE_URL is set/)
  assert.ok(!result.output.includes(databaseUrl))
})

test("Clippy resolves the pin once and runs install/server directly under PowerShell", { skip: process.platform !== "win32" }, async (t) => {
  const result = await launch(t, { devExit: 17 })
  assert.equal(result.code, 17, result.output)
  assert.deepEqual(result.calls.map((call) => call.args), [["install"], ["dev:once", "--data-dir", path.join(result.root, "data")]])
  assert.ok(result.calls.every((call) => call.parent === result.pid))
  const server = result.calls[1]
  assert.equal(server.root, result.root)
  assert.equal(server.port, "43210")
  assert.equal(server.home, path.join(result.root, "data"))
  assert.equal(server.native, "true")
  assert.equal(server.nestedVersion, "9.15.4")
  assert.equal(result.bootstrap.trim().split(/\r?\n/).length, 1)
  assert.match(result.bootstrap, /--package=pnpm@9\.15\.4 -- where\.exe pnpm/)
})

for (const existingDatabase of [false, true]) {
  test(`Clippy uses workspace-local data without replacing an existing database (existing: ${existingDatabase})`, { skip: process.platform !== "win32" }, async (t) => {
    const result = await launch(t, { localHome: true, existingDatabase, useCurrentFolder: true })
    assert.equal(result.code, 0, result.output)
    const server = result.calls.find((call) => call.args[0] === "dev:once")
    const home = path.join(result.root, ".clippy")
    assert.equal(server.home, home)
    assert.deepEqual(server.args, ["dev:once", "--data-dir", home])
    assert.equal(server.existingDatabase, existingDatabase)
    if (existingDatabase) assert.equal(result.databaseVersion, "18")
  })
}

test("Clippy rejects a discovered pnpm that does not match the project pin", { skip: process.platform !== "win32" }, async (t) => {
  const result = await launch(t, { version: "1.0.0" })
  assert.equal(result.code, 1)
  assert.deepEqual(result.calls, [])
  assert.match(result.output, /Could not resolve the pinned pnpm@9\.15\.4/)
})

test("Clippy preserves a failed pnpm bootstrap exit code without starting the server", { skip: process.platform !== "win32" }, async (t) => {
  const result = await launch(t, { bootstrapExit: 23 })
  assert.equal(result.code, 23, result.output)
  assert.deepEqual(result.calls, [])
})
