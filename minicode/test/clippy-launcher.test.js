import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

async function launch(t, { version = "9.15.4", bootstrapExit = 0, devExit = 0 } = {}) {
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
  await fs.writeFile(path.join(packagePath, "bin", "pnpm.cjs"), `
const fs = require("node:fs")
const call = {
  args: process.argv.slice(2), parent: process.ppid,
  root: process.env.CLIPPY_REPO_ROOT, port: process.env.PORT,
  home: process.env.PAPERCLIP_HOME, native: process.env.PAPERCLIP_DISABLE_NATIVE_RUNNER,
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
  const child = spawn("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", path.join(root, "clippy.ps1"), "-repo_root", root, "-port", "43210",
  ], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      PAPERCLIP_HOME: path.join(root, "data"),
      LAUNCHER_TEST_CALLS: callsPath,
      LAUNCHER_TEST_BOOTSTRAP: bootstrapPath,
      LAUNCHER_TEST_SHIM: shim,
      LAUNCHER_TEST_BOOTSTRAP_EXIT: String(bootstrapExit),
      LAUNCHER_TEST_DEV_EXIT: String(devExit),
    },
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
    calls: calls.trim() ? calls.trim().split("\n").map(JSON.parse) : [],
    bootstrap: await fs.readFile(bootstrapPath, "utf8"),
  }
}

test("Clippy resolves the pin once and runs install/server directly under PowerShell", { skip: process.platform !== "win32" }, async (t) => {
  const result = await launch(t, { devExit: 17 })
  assert.equal(result.code, 17, result.output)
  assert.deepEqual(result.calls.map((call) => call.args), [["install"], ["dev:once"]])
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
