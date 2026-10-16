import assert from "node:assert/strict"
import { spawn, execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { once } from "node:events"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { WebSocketServer } from "ws"
import { killTree } from "../server/kill-tree.js"

const execFileAsync = promisify(execFile)

async function fixture(t, entry, { initialize = true, rootFlag, chat = false, command } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "worker launcher test "))
  const app = path.join(root, "minicode")
  const caller = path.join(root, "caller")
  const source = path.join(root, "clippy-worker")
  await Promise.all([
    fs.mkdir(path.join(app, "server"), { recursive: true }),
    fs.mkdir(path.join(root, "bootstrap")),
    fs.mkdir(caller),
  ])
  for (const file of ["cli.js", "package.json", "server/agent-pool-worker.js", "server/agent-session.js", "server/auth.js", "server/kill-tree.js"]) {
    await fs.copyFile(new URL(`../${file}`, import.meta.url), path.join(app, file))
  }
  await fs.symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), path.join(app, "node_modules"),
    process.platform === "win32" ? "junction" : "dir")
  await fs.copyFile(new URL("../../minicode.ps1", import.meta.url), path.join(root, "minicode.ps1"))
  await fs.copyFile(new URL("../../bootstrap/minicode.cmd", import.meta.url), path.join(root, "bootstrap", "minicode.cmd"))
  await execFileAsync("git", ["init", "--initial-branch=main", caller], { windowsHide: true })
  await fs.writeFile(path.join(caller, "source.txt"), "fixture")
  await execFileAsync("git", ["-C", caller, "add", "source.txt"], { windowsHide: true })
  await execFileAsync("git", ["-C", caller, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "-c", "commit.gpgsign=false", "commit", "-m", "Fixture"], { windowsHide: true })
  if (initialize) {
    await execFileAsync("git", ["clone", "--no-hardlinks", "--separate-git-dir", path.join(root, "submodule-git"),
      caller, source], { windowsHide: true })
  }
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  await once(server, "listening")
  let connected
  const ready = new Promise((resolve) => { connected = resolve })
  server.on("connection", (socket) => socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString())
    if (message.type === "hello") socket.send(JSON.stringify({
      type: "welcome", serverInstanceId: randomUUID(), runId: null, ack: 0, completed: false,
    }))
    else if (message.type === "ready") connected()
  }))
  const workerId = randomUUID()
  const args = chat ? [] : command ? [command]
    : ["worker", "--server", `http://127.0.0.1:${server.address().port}`, "--worker-id", workerId]
  if (rootFlag) args.push(rootFlag, source)
  let executable, parameters
  if (entry === "direct") {
    executable = process.execPath
    parameters = [path.join(app, "cli.js"), ...args]
  } else if (entry === "powershell") {
    executable = "powershell.exe"
    parameters = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "minicode.ps1"), ...args]
  } else {
    executable = process.env.ComSpec
    parameters = ["/d", "/s", "/c", `""${path.join(root, "bootstrap", "minicode.cmd")}" ${args.map((arg) => `"${arg}"`).join(" ")}"`]
  }
  const config = path.join(root, "config")
  const child = spawn(executable, parameters, {
    cwd: caller, windowsHide: true, windowsVerbatimArguments: entry === "cmd",
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env, MINICODE_CONFIG_HOME: config, MINICODE_REPO_ROOT: caller,
      MINICODE_AGENT_POOL_PAIRING_TOKEN: "",
      OPENCODE_API_KEY: "fixture-only", OPENCODE_BASE_URL: "http://127.0.0.1:1/v1", OPENCODE_MODEL: "fixture",
    },
  })
  let output = ""
  child.stdout.on("data", (chunk) => { output += chunk })
  child.stderr.on("data", (chunk) => { output += chunk })
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", resolve)
  })
  child.stdin.end(chat ? "exit\n" : "")
  t.after(async () => {
    for (const socket of server.clients) socket.close(1008, "fixture finished")
    const timer = setTimeout(() => killTree(child.pid), 5000)
    timer.unref()
    try { await closed } finally {
      clearTimeout(timer)
      for (const socket of server.clients) socket.terminate()
      await new Promise((resolve) => server.close(resolve))
      await fs.rm(root, { recursive: true, force: true })
    }
  })
  return {
    source, caller, closed, get output() { return output },
    async sourceRoot() {
      await Promise.race([ready, closed.then((code) => { throw new Error(`Worker exited ${code}: ${output}`) })])
      const credential = JSON.parse(await fs.readFile(path.join(config, "agent-pool", `${workerId}.json`), "utf8"))
      return credential.cwd
    },
  }
}

for (const entry of ["direct", "powershell", "cmd"]) {
  const options = { skip: entry !== "direct" && process.platform !== "win32", timeout: 15_000 }
  test(`${entry} worker preserves the caller directory when no source is passed`, options, async (t) => {
    const result = await fixture(t, entry)
    assert.equal(await result.sourceRoot(), await fs.realpath(result.caller))
  })
  test(`${entry} worker uses the full submodule path passed as its source`, options, async (t) => {
    const result = await fixture(t, entry, { rootFlag: "--repo-root" })
    assert.equal(await result.sourceRoot(), await fs.realpath(result.source))
  })
  test(`${entry} worker honors a full source path through the legacy root option`, options, async (t) => {
    const result = await fixture(t, entry, { rootFlag: "-repo_root" })
    assert.equal(await result.sourceRoot(), await fs.realpath(result.source))
  })
}

test("a missing explicitly selected source fails instead of falling back to the caller directory", { timeout: 15_000 }, async (t) => {
  const result = await fixture(t, "direct", { initialize: false, rootFlag: "--repo-root" })
  assert.equal(await result.closed, 1)
  assert.match(result.output, /ENOENT/)
  assert.ok(result.output.includes(result.source), result.output)
})

test("the CMD launcher preserves normal chat's current-directory default", { skip: process.platform !== "win32", timeout: 15_000 }, async (t) => {
  const result = await fixture(t, "cmd", { initialize: false, chat: true })
  assert.equal(await result.closed, 0, result.output)
  assert.ok(result.output.includes(`repo: ${result.caller}`), result.output)
})

test("the PowerShell launcher preserves a single command when forwarding an explicit root", { skip: process.platform !== "win32", timeout: 15_000 }, async (t) => {
  const result = await fixture(t, "powershell", { initialize: false, rootFlag: "--repo-root", command: "auth" })
  assert.equal(await result.closed, 0, result.output)
  assert.match(result.output, /No Azure deployments configured/)
})
