import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import test from "node:test"
import { createAzureDevOpsPublisher, createAzureDevOpsTokenProvider } from "../server/azure-devops-publisher.js"

const exec = promisify(execFile)
const remoteUrl = "https://fixture.visualstudio.com/DefaultCollection/Project/_git/Repository"
const repositoryId = "11111111-1111-4111-8111-111111111111"
const projectId = "22222222-2222-4222-8222-222222222222"
const tenant = "33333333-3333-4333-8333-333333333333"

async function fixture(t, { alias, hostedUsername = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-ado-publisher-"))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const source = path.join(directory, "source"), workspace = path.join(directory, "agent"), remote = path.join(directory, "hosted.git")
  await fs.mkdir(source)
  const git = async (cwd, ...args) => (await exec("git", cwd === remote ? ["--git-dir", remote, ...args] : args,
    { cwd, windowsHide: true })).stdout.trim()
  await git(source, "init", "--initial-branch=main")
  await fs.writeFile(path.join(source, "code.txt"), "initial")
  await git(source, "add", ".")
  const commit = cwd => git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "-c", "commit.gpgsign=false", "commit", "-am", "Fixture")
  await commit(source)
  await git(directory, "clone", "--bare", source, remote)
  await git(directory, "clone", source, workspace)
  await git(source, "remote", "add", "origin", remoteUrl)
  await fs.writeFile(path.join(source, "code.txt"), "operator edit")
  await fs.writeFile(path.join(workspace, "code.txt"), "validated change")
  await commit(workspace)
  const revision = await git(workspace, "rev-parse", "HEAD")
  await fs.writeFile(path.join(workspace, "local.txt"), "never publish")
  const calls = [], requests = [], worktrees = []
  let pr = null, failure = null, pushCount = 0, tokenCalls = 0, lostResponse = false
  const run = async (file, args, options) => {
    options.signal?.throwIfAborted()
    calls.push({ file, args: [...args], env: options.env })
    if (file === process.execPath) {
      tokenCalls++
      assert.equal(args[1], "ado-token")
      assert.ok(args.includes("--silent"))
      return JSON.stringify({ accessToken: "private-msal-token", expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        user: "alice@contoso.test", tenantId: tenant })
    }
    assert.equal(file, "git")
    assert.ok(!JSON.stringify(options.env).includes("private-msal-token"))
    assert.ok(!JSON.stringify(args).includes("private-msal-token"))
    if (args.includes("push")) pushCount++
    if (args[0] === "worktree" && args[1] === "add") worktrees.push(args.at(-2))
    return (await exec(file, args.map(arg => arg === remoteUrl || arg === "https://dev.azure.com/fixture/Project/_git/Repository"
      ? remote : arg), { ...options, windowsHide: true })).stdout.trim()
  }
  const info = { id: repositoryId, name: "Repository", project: { id: projectId, name: "Project" },
    defaultBranch: "refs/heads/main", remoteUrl: hostedUsername
      ? "https://fixture@dev.azure.com/fixture/Project/_git/Repository" : remoteUrl }
  const fetchImpl = async (url, init) => {
    requests.push({ url: new URL(url), method: init.method, body: init.body })
    assert.equal(init.headers.Authorization, "Bearer private-msal-token")
    assert.equal(init.redirect, "error")
    assert.equal(url.origin, "https://dev.azure.com")
    assert.equal(url.searchParams.get("api-version"), "7.1")
    if (!url.pathname.endsWith("/pullrequests")) return Response.json(info)
    assert.equal(url.pathname, `/fixture/${projectId}/_apis/git/repositories/${repositoryId}/pullrequests`)
    if (init.method === "GET") {
      assert.equal(url.searchParams.get("searchCriteria.status"), "all")
      return Response.json({ value: pr ? [pr] : [] })
    }
    assert.equal(init.method, "POST")
    if (failure) return new Response("private response body", { status: 403 })
    const body = JSON.parse(init.body)
    assert.equal(body.autoCompleteSetBy, undefined)
    assert.equal(body.completionOptions, undefined)
    pr = { pullRequestId: 12, repository: info, status: "active", sourceRefName: body.sourceRefName,
      targetRefName: body.targetRefName, lastMergeSourceCommit: { commitId: revision } }
    if (lostResponse) throw new Error("Response lost after create")
    return Response.json(pr)
  }
  const config = { repoRoot: source, organization: "https://dev.azure.com/fixture", project: "Project",
    repository: "Repository", user: "alice@contoso.test", alias, run, fetchImpl }
  const publisher = await createAzureDevOpsPublisher(config)
  return { source, workspace, remote, revision, git, config, calls, requests, worktrees, publisher,
    tool: publisher({ workspace, agentId: "engineer" }),
    input: { commit: revision, title: 'Feature "quoted" & safe', body: "Validated.\nAwaiting review." },
    get pushCount() { return pushCount }, get tokenCalls() { return tokenCalls },
    get pr() { return pr }, fail(value) { failure = value }, loseResponse(value) { lostResponse = value } }
}

test("Azure publication preserves commits/checkouts, uses users/<alias> branches and keeps MSAL out of Git", async t => {
  const f = await fixture(t, { alias: "custom-alias", hostedUsername: true })
  const sourceHead = await f.git(f.source, "rev-parse", "HEAD")
  const sourceStatus = await f.git(f.source, "status", "--porcelain")
  const agentStatus = await f.git(f.workspace, "status", "--porcelain")
  const receipt = await f.tool.execute(f.input)
  assert.equal(receipt.branch, `users/custom-alias/minicode-engineer-${f.revision}`)
  assert.equal(receipt.url, "https://dev.azure.com/fixture/Project/_git/Repository/pullrequest/12")
  assert.equal(receipt.provider, "azure_devops")
  assert.equal(await f.git(f.remote, "rev-parse", `refs/heads/${receipt.branch}`), f.revision)
  assert.equal(await f.git(f.source, "rev-parse", "HEAD"), sourceHead)
  assert.equal(await f.git(f.source, "status", "--porcelain"), sourceStatus)
  assert.equal(await f.git(f.workspace, "status", "--porcelain"), agentStatus)
  assert.equal((await f.tool.execute(f.input)).reused, true)
  assert.equal(f.pushCount, 1)
  assert.equal(f.tokenCalls, 1)
  assert.equal(f.requests.filter(r => r.method === "POST").length, 1)
  for (const worktree of f.worktrees) await assert.rejects(fs.stat(path.dirname(worktree)), { code: "ENOENT" })
  const push = f.calls.find(call => call.args.includes("push"))
  assert.ok(push.args.includes(`--force-with-lease=refs/heads/${receipt.branch}:`))
  assert.ok(!push.args.some(arg => arg.startsWith("credential.") || arg.includes("extraheader")))
})

test("Azure publication reconciles failed/lost PR creation and merged/closed PRs without another push", async t => {
  const f = await fixture(t)
  f.fail(true)
  await assert.rejects(f.tool.execute(f.input), /retry the same commit.*HTTP 403/)
  assert.equal(f.pushCount, 1)
  for (const worktree of f.worktrees) await assert.rejects(fs.stat(path.dirname(worktree)), { code: "ENOENT" })
  f.fail(false)
  f.loseResponse(true)
  await assert.rejects(f.tool.execute(f.input), /retry the same commit.*request failed/)
  assert.equal((await f.tool.execute(f.input)).reused, true)
  assert.equal(f.pushCount, 1)
  assert.equal(f.pr.sourceRefName, `refs/heads/users/alice/minicode-engineer-${f.revision}`)
  for (const [status, state] of [["completed", "MERGED"], ["abandoned", "CLOSED"]]) {
    f.pr.status = status
    assert.equal((await f.tool.execute(f.input)).state, state)
  }
})

test("Azure publication refuses repository/branch overrides, conflicting branches, foreign origins and invalid receipts", async t => {
  const f = await fixture(t)
  for (const extra of [{ repository: "other" }, { branch: "main" }, { commit: "HEAD" }]) {
    await assert.rejects(f.tool.execute({ ...f.input, ...extra }), /requires a full commit/)
  }
  await assert.rejects(createAzureDevOpsPublisher({ ...f.config, organization: "https://dev.azure.com/other" }), /must match/)
  await assert.rejects(createAzureDevOpsPublisher({ ...f.config, repository: "other" }), /identity must match/)
  await assert.rejects(createAzureDevOpsPublisher({ ...f.config, alias: "../main" }), /branch-safe alias/)
  await assert.rejects(createAzureDevOpsPublisher({ ...f.config, user: 42 }), /requires --azure-devops-org/)
  const branch = f.publisher.branchForCommit("engineer", f.revision)
  await f.git(f.remote, "update-ref", `refs/heads/${branch}`, await f.git(f.source, "rev-parse", "HEAD"))
  await assert.rejects(f.tool.execute(f.input), /will not be overwritten/)
  assert.equal(f.pushCount, 0)
  await f.git(f.workspace, "push", f.remote, `${f.revision}:refs/heads/${branch}`)
  await f.tool.execute(f.input)
  f.pr.repository = { ...f.pr.repository, id: "44444444-4444-4444-8444-444444444444" }
  await assert.rejects(f.tool.execute(f.input), /unexpected PR identity/)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(f.tool.execute(f.input, { signal: controller.signal }), /abort/i)
})

test("Azure token helper caches/renews privately and never includes helper stdout in failure messages", async t => {
  let calls = 0
  const now = Date.now()
  let elapsed = 0
  t.mock.method(Date, "now", () => now + elapsed)
  const provider = createAzureDevOpsTokenProvider({ organization: "https://dev.azure.com/fixture",
    user: "alice@contoso.test", env: {}, run: async () => {
      calls++
      return JSON.stringify({ accessToken: "private-token", user: "alice@contoso.test",
        tenantId: tenant, expiresAt: new Date(Date.now() + 3600_000).toISOString() })
    } })
  assert.deepEqual(await Promise.all([provider(), provider()]), ["private-token", "private-token"])
  assert.equal(calls, 1)
  elapsed = 3600_000
  assert.equal(await provider(), "private-token")
  assert.equal(calls, 2)
  const failed = createAzureDevOpsTokenProvider({ organization: "https://dev.azure.com/fixture",
    user: "alice@contoso.test", env: {}, run: async () => { throw new Error("private stdout token") } })
  await assert.rejects(failed(), error => {
    assert.match(error.message, /ado-login/)
    assert.ok(!error.message.includes("private stdout token"))
    return true
  })
})
