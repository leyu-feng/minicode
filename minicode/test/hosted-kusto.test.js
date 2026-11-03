import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import test from "node:test"
import { startHostedKustoSkill } from "../server/hosted-kusto.js"

const execFileAsync = promisify(execFile)
const token = () => ({ accessToken: "private-kusto-token", tokenType: "Bearer",
  expiresOn: new Date(Date.now() + 3600_000).toISOString() })

async function fixture(t, getToken = async () => token(), signal = new AbortController().signal) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "hosted-kusto-test-"))
  const errors = []
  const skill = await startHostedKustoSkill({ workspace, getToken, signal, onError: message => errors.push(message) })
  t.after(async () => { await skill.close(); await fs.rm(workspace, { recursive: true, force: true }) })
  const request = (body = {}, capability = skill.env.WORKER_KUSTO_TOKEN_CAPABILITY) =>
    fetch(skill.env.WORKER_KUSTO_TOKEN_URL, { method: "POST",
      headers: { Authorization: `Bearer ${capability}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), redirect: "error" })
  return { workspace, skill, request, errors }
}

test("Kusto token API requires its run capability and accepts no arbitrary targets or scopes", async t => {
  let calls = 0
  const f = await fixture(t, async () => { calls++; return token() })
  assert.equal((await f.request(undefined, "wrong")).status, 401)
  assert.equal((await f.request({ resource: "https://other.example" })).status, 400)
  assert.equal((await f.request({ scope: "https://management.azure.com" })).status, 400)
  assert.equal(calls, 0)
  const response = await f.request()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("cache-control"), "no-store")
  assert.equal((await response.json()).accessToken, "private-kusto-token")
  assert.equal(calls, 1)
  assert.deepEqual(f.errors, [])
  assert.doesNotMatch(await fs.readFile(f.skill.skill.file, "utf8"), /private-kusto-token/)
  const directory = path.dirname(f.skill.skill.file)
  await f.skill.close()
  await assert.rejects(fs.stat(directory), { code: "ENOENT" })
  await assert.rejects(f.request())
})

test("Kusto token errors are sanitized and cancellation prevents issuance", async t => {
  const f = await fixture(t, async () => { throw new Error("private-upstream-secret") })
  const response = await f.request()
  assert.equal(response.status, 502)
  assert.doesNotMatch(await response.text(), /private-upstream-secret/)
  assert.doesNotMatch(f.errors.join("\n"), /private-upstream-secret/)
  const controller = new AbortController()
  const cancelled = await fixture(t, async () => { throw new Error("Must not request a token") }, controller.signal)
  controller.abort()
  assert.equal((await cancelled.request()).status, 502)
})

test("Kusto API refuses expired or malformed tokens", async t => {
  for (const change of [{ expiresOn: "2000-01-01" }, { tokenType: "unexpected" }]) {
    const f = await fixture(t, async () => ({ ...token(), ...change }))
    const response = await f.request()
    assert.equal(response.status, 502)
    assert.doesNotMatch(await response.text(), /private-kusto-token/)
  }
})

test("Kusto skill queries directly without placing either credential in output or files", async t => {
  const f = await fixture(t)
  const query = path.join(f.workspace, "query.kql")
  await fs.writeFile(query, "ExampleTable | getschema")
  const helper = path.join(path.dirname(f.skill.skill.file), "query.ps1")
  const script = `
    function Invoke-RestMethod {
      param($Uri, $Method, $Headers, $ContentType, $Body, $MaximumRedirection, $TimeoutSec, $Verbose, $Debug)
      if ($Uri -eq $env:WORKER_KUSTO_TOKEN_URL) {
        if ($Headers.Authorization -cne "Bearer $env:WORKER_KUSTO_TOKEN_CAPABILITY") { throw 'Wrong capability' }
        return (@'
${JSON.stringify(token())}
'@ | ConvertFrom-Json)
      }
      if ($Uri -cne 'https://cluster.example/v1/rest/query') { throw 'Wrong target' }
      if ($Headers.Authorization -cne 'Bearer private-kusto-token') { throw 'Wrong ADX token' }
      if ($MaximumRedirection -ne 0) { throw 'Redirects must be refused' }
      $request = $Body | ConvertFrom-Json
      $properties = $request.properties | ConvertFrom-Json
      if ($request.db -cne 'ExampleDatabase' -or $request.csl -cne 'ExampleTable | getschema' -or
          -not $properties.Options.request_readonly_hardline) { throw 'Invalid Kusto request' }
      return ('{"Tables":[{"Rows":[["ExampleColumn","datetime"]]}]}' | ConvertFrom-Json)
    }
    & '${helper.replaceAll("'", "''")}' -ClusterUri 'https://cluster.example' -Database 'ExampleDatabase' -QueryFile '${query.replaceAll("'", "''")}'
  `
  const result = await execFileAsync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, ...f.skill.env }, windowsHide: true,
  })
  assert.equal(JSON.parse(result.stdout).Tables[0].Rows[0][0], "ExampleColumn")
  assert.doesNotMatch(result.stdout + result.stderr, /private-kusto-token/)
  assert.ok(!result.stdout.includes(f.skill.env.WORKER_KUSTO_TOKEN_CAPABILITY))
  assert.deepEqual((await fs.readdir(f.workspace)).sort(), [".worker", "query.kql"])
})
