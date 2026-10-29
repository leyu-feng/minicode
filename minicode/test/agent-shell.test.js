import assert from "node:assert/strict"
import childProcess from "node:child_process"
import { EventEmitter, once } from "node:events"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { AgentPowerShell } from "../server/agent-shell.js"

function fixture(t) {
  const processes = []
  const notices = []
  const kills = []
  t.mock.method(childProcess, "spawn", (file, args) => {
    if (file === "taskkill") {
      kills.push(args)
      return new EventEmitter()
    }
    const proc = new EventEmitter()
    proc.pid = 100 + processes.length
    proc.exitCode = null
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.stdin = new EventEmitter()
    proc.stdin.write = script => { proc.marker = script.match(/__MINICODE_[a-f0-9]+_DONE__:/)?.[0] }
    proc.stdin.destroy = () => { proc.destroyed = true }
    processes.push(proc)
    return proc
  })
  const shell = new AgentPowerShell({ shell: "powershell-5.1", cwd: process.cwd(), env: {}, onStateLost: notice => notices.push(notice) })
  t.after(() => shell.dispose())
  const complete = (proc, stream, code = 0) => proc[stream].emit("data", `${proc.marker}${code}:END__`)
  return { shell, processes, notices, kills, complete }
}

test("completion waits for both output streams and parses split markers without leaking them", async t => {
  const { shell, processes, complete } = fixture(t)
  let live = ""
  const pending = shell.run("fixture", { onData: text => { live += text } })
  const proc = processes[0]
  proc.stdout.emit("data", `out${proc.marker.slice(0, 15)}`)
  proc.stdout.emit("data", `${proc.marker.slice(15)}0:EN`)
  proc.stdout.emit("data", "D__")
  assert.equal(live, "out")
  let finished = false
  pending.then(() => { finished = true })
  await Promise.resolve()
  assert.equal(finished, false)
  proc.stderr.emit("data", "error without newline")
  complete(proc, "stderr")
  assert.deepEqual(await pending, { code: 0, output: "outerror without newline" })
  const next = shell.run("another command")
  assert.equal(processes.length, 1)
  complete(proc, "stdout")
  complete(proc, "stderr")
  assert.equal((await next).output, "")
})

test("command output is bounded and UTF-8 characters split across pipe chunks are preserved", async t => {
  const { shell, processes, complete } = fixture(t)
  const pending = shell.run("large output")
  const proc = processes[0]
  const bytes = Buffer.from("\u4e2d")
  proc.stdout.emit("data", bytes.subarray(0, 1))
  proc.stdout.emit("data", bytes.subarray(1))
  proc.stdout.emit("data", "x".repeat(20000))
  complete(proc, "stdout")
  complete(proc, "stderr")
  const result = await pending
  assert.equal(result.output[0], "\u4e2d")
  assert.equal(result.output.length, 12000 + "\n...<truncated>".length)
  assert.ok(result.output.endsWith("...<truncated>"))
})

test("cancelled commands discard only their process, reject late output and allow a fresh process", async t => {
  const { shell, processes, notices, complete, kills } = fixture(t)
  const controller = new AbortController()
  const pending = shell.run("long command", { signal: controller.signal })
  const old = processes[0]
  controller.abort()
  const cancelled = await pending
  assert.equal(cancelled.code, 130)
  assert.match(cancelled.output, /session state was lost.*Command cancelled/)
  assert.equal(old.destroyed, true)
  if (process.platform === "win32") assert.deepEqual(kills, [["/PID", String(old.pid), "/T", "/F"]])
  const next = shell.run("new command")
  old.stdout.emit("data", "late abandoned output")
  old.emit("close", 1)
  const fresh = processes[1]
  complete(fresh, "stdout")
  complete(fresh, "stderr")
  assert.deepEqual(await next, { code: 0, output: "" })
  assert.equal(notices.length, 1)
})

test("timeouts and unexpected process exit report lost state rather than successful completion", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const { shell, processes, complete, notices } = fixture(t)
  const timed = shell.run("slow command")
  t.mock.timers.tick(120000)
  assert.match((await timed).output, /timed out after 120s/)
  const exited = shell.run("exit")
  processes[1].emit("close", 0)
  const result = await exited
  assert.equal(result.code, 1)
  assert.match(result.output, /session state was lost.*exited \(0\)/)
  const fresh = shell.run("recovered")
  complete(processes[2], "stdout")
  complete(processes[2], "stderr")
  assert.equal((await fresh).code, 0)
  assert.equal(notices.length, 2)
})

test("disposal kills the persistent process and settles a pending command without a reset notice", async t => {
  const { shell, processes, notices } = fixture(t)
  const pending = shell.run("fixture")
  shell.dispose()
  assert.equal((await pending).code, 130)
  assert.equal(processes[0].destroyed, true)
  assert.deepEqual(notices, [])
  assert.throws(() => shell.run("later"), /session is closed/)
})

for (const version of ["powershell-7", "powershell-5.1"]) {
  test(`${version} retains variables, modules, functions, environment and cwd while capturing command errors`, {
    skip: process.platform !== "win32", timeout: 15000,
  }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "persistent shell "))
    const shell = new AgentPowerShell({ shell: version, cwd: root, env: process.env })
    t.after(async () => {
      const closed = shell.proc ? once(shell.proc, "close") : null
      shell.dispose()
      await closed
      await fs.rm(root, { recursive: true, force: true })
    })
    assert.equal((await shell.run(`
$saved = 42
$env:MINICODE_PERSISTENCE_FIXTURE = 'kept'
New-Module -Name FixtureModule -ScriptBlock { function Get-FixtureValue { 'module-kept' }; Export-ModuleMember -Function Get-FixtureValue } | Import-Module
function Get-Saved { $saved }
New-Item -ItemType Directory -Name child | Out-Null
Set-Location child
`)).code, 0)
    const persisted = await shell.run("Write-Output (Get-Saved); Get-FixtureValue; Write-Output $env:MINICODE_PERSISTENCE_FIXTURE; (Get-Location).Path; [Console]::Out.Write('no-newline'); [Console]::Error.Write('stderr-text')")
    assert.equal(persisted.code, 0)
    for (const value of ["42", "module-kept", "kept", path.join(root, "child"), "no-newline", "stderr-text"]) {
      assert.ok(persisted.output.includes(value), persisted.output)
    }
    assert.equal((await shell.run("throw 'fixture-failure'")).code, 1)
    const parseError = await shell.run("if (")
    assert.equal(parseError.code, 1)
    assert.ok(parseError.output.length > 0)
    assert.equal((await shell.run("Write-Error 'nonterminating-error'")).code, 1)
    assert.equal((await shell.run("cmd.exe /c exit 9")).code, 1)
    assert.equal((await shell.run("return 'returned-value'")).code, 0)
    assert.match((await shell.run("Get-Saved")).output, /42/)
    const exited = await shell.run("exit 7")
    assert.equal(exited.code, 1)
    assert.match(exited.output, /session state was lost.*exited \(7\)/)
  })

  test(`${version} cancellation restarts the process and discards its old state`, {
    skip: process.platform !== "win32", timeout: 15000,
  }, async t => {
    const shell = new AgentPowerShell({ shell: version, cwd: process.cwd(), env: process.env })
    t.after(() => shell.dispose())
    const first = await shell.run("$saved='before-cancel'; Write-Output $PID")
    const controller = new AbortController()
    let started
    const ready = new Promise(resolve => { started = resolve })
    const running = shell.run("[Console]::Out.Write('ready'); Start-Sleep -Seconds 60", {
      signal: controller.signal, onData: text => { if (text.includes("ready")) started() },
    })
    await ready
    const oldProcess = shell.proc
    const closed = once(oldProcess, "close")
    controller.abort()
    assert.equal((await running).code, 130)
    await closed
    const next = await shell.run("if ($saved) { throw 'State leaked after cancellation' }; Write-Output $PID")
    assert.equal(next.code, 0)
    assert.notEqual(next.output.trim(), first.output.trim())
  })
}
