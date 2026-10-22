import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import test from "node:test"
import { createGitHubPublisher } from "../server/github-publisher.js"
import { paperclipPublicationTool } from "../server/paperclip-publication.js"

const exec = promisify(execFile)

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-publisher-test-"))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const source = path.join(directory, "source")
  const workspace = path.join(directory, "agent")
  const remote = path.join(directory, "hosted.git")
  const git = async (cwd, ...args) => (await exec("git", cwd === remote ? ["--git-dir", remote, ...args] : args,
    { cwd, windowsHide: true })).stdout.trim()
  await fs.mkdir(source)
  await git(source, "init", "--initial-branch=main")
  await fs.writeFile(path.join(source, "tracked.txt"), "baseline")
  await git(source, "add", "tracked.txt")
  const commit = cwd => git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "-c", "commit.gpgsign=false", "commit", "-am", "Fixture")
  await commit(source)
  await git(directory, "clone", "--bare", source, remote)
  await git(directory, "clone", source, workspace)
  await git(source, "remote", "add", "origin", "https://github.com/fixture-owner/project.git")
  await fs.writeFile(path.join(workspace, "tracked.txt"), "validated change")
  await commit(workspace)
  const revision = await git(workspace, "rev-parse", "HEAD")
  await fs.writeFile(path.join(workspace, "untracked.txt"), "do not publish")
  const calls = [], worktrees = []
  let pr = null, createError = null, worktreeError = null, pushCount = 0
  const run = async (file, args, options) => {
    options.signal?.throwIfAborted()
    calls.push({ file, args: [...args], env: options.env })
    if (file === "gh") {
      if (args[0] === "auth") return "private-fixture-token"
      assert.equal(options.env.GH_TOKEN, "private-fixture-token")
      if (args[0] === "repo") return JSON.stringify({ defaultBranchRef: { name: "main" } })
      if (args[1] === "list") return JSON.stringify(pr ? [pr] : [])
      if (args[1] === "create") {
        if (createError) throw typeof createError === "function" ? createError() : createError
        pr = { number: 12, url: "https://github.com/fixture-owner/project/pull/12", state: "OPEN", headRefOid: revision }
        return pr.url
      }
      assert.fail(`Unexpected gh operation: ${args[0]} ${args[1]}`)
    }
    if (args.includes("push")) pushCount++
    if (args[0] === "worktree" && args[1] === "add") worktrees.push(args.at(-2))
    const rewritten = args.map(arg => arg === "https://github.com/fixture-owner/project.git" ? remote : arg)
    const output = (await exec(file, rewritten, { ...options, windowsHide: true })).stdout.trim()
    if (args[0] === "worktree" && args[1] === "add" && worktreeError) throw worktreeError
    return output
  }
  const publisher = await createGitHubPublisher({ repoRoot: source, repository: "fixture-owner/project", githubUser: "fixture-owner", run })
  const tool = publisher({ workspace, agentId: "engineer" })
  return { directory, source, workspace, remote, revision, git, tool, calls, worktrees,
    input: { commit: revision, title: "CI baseline", body: "Validated locally. Awaiting approval; no deployment." },
    get pushCount() { return pushCount },
    failCreation(error) { createError = error },
    failWorktreeAdd(error) { worktreeError = error },
  }
}

test("publisher creates and reuses a PR without changing either checkout or retaining its worktree", async t => {
  const f = await fixture(t)
  const before = await f.git(f.source, "rev-parse", "HEAD")
  const sourceStatus = await f.git(f.source, "status", "--porcelain")
  const agentStatus = await f.git(f.workspace, "status", "--porcelain")
  const receipt = await f.tool.execute(f.input)
  assert.equal(receipt.url, "https://github.com/fixture-owner/project/pull/12")
  assert.equal(receipt.state, "OPEN")
  assert.equal(receipt.worktreeRemoved, true)
  assert.equal(await f.git(f.remote, "rev-parse", `refs/heads/${receipt.branch}`), f.revision)
  assert.equal(await f.git(f.source, "rev-parse", "HEAD"), before)
  assert.equal(await f.git(f.source, "status", "--porcelain"), sourceStatus)
  assert.equal(await f.git(f.workspace, "status", "--porcelain"), agentStatus)
  for (const worktree of f.worktrees) {
    await assert.rejects(fs.stat(path.dirname(worktree)), { code: "ENOENT" })
    assert.ok(!(await f.git(f.source, "worktree", "list", "--porcelain")).includes("minicode-pr-"))
  }
  assert.equal((await f.tool.execute(f.input)).reused, true)
  assert.equal(f.pushCount, 1)
  assert.equal(f.calls.filter(call => call.file === "gh" && call.args[1] === "create").length, 1)
  assert.ok(f.calls.filter(call => call.args[0] === "worktree").every(call => !call.env.GH_TOKEN))
})

test("publisher rejects foreign repositories, uncommitted revisions, and repository overrides before accessing credentials", async t => {
  const f = await fixture(t)
  await assert.rejects(createGitHubPublisher({ repoRoot: f.source, repository: "other/project", githubUser: "fixture-owner" }), /must match/)
  await assert.rejects(createGitHubPublisher({ repoRoot: f.source, repository: "fixture-owner/project" }), /github-user/)
  for (const input of [{ ...f.input, repository: "other/project" }, { ...f.input, commit: "HEAD" }, { ...f.input, commit: [f.revision] },
    { ...f.input, commit: "a".repeat(40) }]) {
    await assert.rejects(f.tool.execute(input))
  }
  assert.ok(!f.calls.some(call => call.file === "gh"))
})

test("publisher refuses to overwrite a conflicting publication branch", async t => {
  const f = await fixture(t)
  const branch = `refs/heads/minicode/engineer/${f.revision}`
  await f.git(f.remote, "update-ref", branch, await f.git(f.source, "rev-parse", "HEAD"))
  await assert.rejects(f.tool.execute(f.input), /will not be overwritten/)
  assert.equal(f.pushCount, 0)
  assert.equal(f.worktrees.length, 0)
})

test("a PR failure cleans up and retries the pushed revision without another push", async t => {
  const f = await fixture(t)
  f.failCreation(new Error("GitHub permission denied"))
  await assert.rejects(f.tool.execute(f.input), /retry the same commit.*GitHub permission denied/)
  for (const worktree of f.worktrees) await assert.rejects(fs.stat(path.dirname(worktree)), { code: "ENOENT" })
  f.failCreation(null)
  assert.equal((await f.tool.execute(f.input)).state, "OPEN")
  assert.equal(f.pushCount, 1)
})

test("cancellation after push still removes the publication worktree and retains local work", async t => {
  const f = await fixture(t)
  const controller = new AbortController()
  f.failCreation(() => { controller.abort(); return new Error("cancelled") })
  await assert.rejects(f.tool.execute(f.input, { signal: controller.signal }), /cancelled/)
  assert.equal(controller.signal.aborted, true)
  for (const worktree of f.worktrees) await assert.rejects(fs.stat(path.dirname(worktree)), { code: "ENOENT" })
  assert.equal(await f.git(f.workspace, "rev-parse", "HEAD"), f.revision)
  assert.equal(await fs.readFile(path.join(f.workspace, "untracked.txt"), "utf8"), "do not publish")
})

test("an interrupted worktree registration is reconciled before its temporary directory is removed", async t => {
  const f = await fixture(t)
  f.failWorktreeAdd(new Error("worktree creation interrupted"))
  await assert.rejects(f.tool.execute(f.input), /worktree creation interrupted/)
  assert.equal(f.pushCount, 0)
  assert.equal(f.worktrees.length, 1)
  assert.ok(!(await f.git(f.source, "worktree", "list", "--porcelain")).includes("minicode-pr-"))
  await assert.rejects(fs.stat(path.dirname(f.worktrees[0])), { code: "ENOENT" })
})

function paperclipFixture(t, { scoped = true, azure = false } = {}) {
  const issueId = "11111111-1111-4111-8111-111111111111"
  const agentId = "engineer"
  const receipt = { repository: "fixture-owner/project", number: 12, state: "OPEN",
    url: "https://github.com/fixture-owner/project/pull/12", commit: "a".repeat(40),
    branch: `minicode/${agentId}/${"a".repeat(40)}`, reused: true, worktreeRemoved: true }
  const azureOptions = azure ? {
    provider: "azure_devops",
    repository: "fixture/Project/Repository",
    pullRequestUrl: number => `https://dev.azure.com/fixture/Project/_git/Repository/pullrequest/${number}`,
    branchForCommit: (agent, commit) => `users/alice/minicode-${agent}-${commit}`,
  } : {}
  if (azure) Object.assign(receipt, { provider: azureOptions.provider, repository: azureOptions.repository,
    url: azureOptions.pullRequestUrl(receipt.number), branch: azureOptions.branchForCommit(agentId, receipt.commit) })
  const products = [], comments = [], calls = []
  let publications = 0, failure = null, loseResponse = null
  const tool = paperclipPublicationTool({
    name: "publish_pull_request", description: "Fixture publisher", parameters: { type: "object", properties: {} },
    async execute(input) {
      assert.equal(input.issueId, undefined)
      publications++
      return { ...receipt }
    },
  }, { apiUrl: "http://paperclip.test", authToken: "fixture-run-key", runId: "fixture-run-id",
    issueId: scoped ? issueId : "", agentId, companyId: "company-a", repository: receipt.repository, ...azureOptions })
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const route = new URL(url).pathname
    const body = options.body ? JSON.parse(options.body) : null
    assert.equal(options.headers.Authorization, "Bearer fixture-run-key")
    assert.equal(options.headers["X-Paperclip-Run-Id"], "fixture-run-id")
    assert.equal(options.redirect, "error")
    assert.ok(options.signal)
    calls.push({ route, method: options.method, body })
    if (failure?.(route, options)) return new Response("private error body must not be exposed", { status: 403 })
    let result
    if (route === `/api/issues/${issueId}`) result = { id: issueId, assigneeAgentId: agentId, companyId: "company-a" }
    else if (route.endsWith("/work-products")) {
      if (body) products.push({ ...body, id: "product-1", issueId })
      result = body ? products.at(-1) : products
    } else if (route === "/api/work-products/product-1") {
      Object.assign(products[0], body)
      result = products[0]
    } else if (route.endsWith("/comments")) {
      if (body) comments.push({ ...body, id: `comment-${comments.length}`, issueId, authorAgentId: agentId })
      result = body ? comments.at(-1) : comments
    } else assert.fail(`Unexpected route ${route}`)
    if (loseResponse?.(route, options)) throw new Error("Response lost after server commit")
    return Response.json(result)
  })
  return { tool, receipt, products, comments, calls, issueId,
    input: { commit: receipt.commit, title: "CI baseline", body: "Validated" },
    get publications() { return publications }, fail(predicate) { failure = predicate },
    loseResponse(predicate) { loseResponse = predicate } }
}

test("PR receipts register work products and chat links once, then refresh merge state without marking the task done", async t => {
  const f = paperclipFixture(t)
  const first = await f.tool.execute(f.input)
  assert.equal(first.paperclip.workProductId, "product-1")
  assert.equal(f.products[0].reviewState, "needs_board_review")
  assert.equal(f.products[0].metadata.agentId, "engineer")
  assert.equal(f.products[0].metadata.branch, f.receipt.branch)
  await f.tool.execute({ ...f.input, issueId: f.issueId })
  assert.equal(f.products.length, 1)
  assert.equal(f.comments.length, 1)
  f.receipt.state = "MERGED"
  await f.tool.execute(f.input)
  await f.tool.execute(f.input)
  assert.equal(f.products.length, 1)
  assert.equal(f.products[0].status, "merged")
  assert.equal(f.products[0].reviewState, "none")
  assert.equal(f.comments.length, 2)
  assert.ok(f.comments[1].body.includes("PR merge verified"))
  assert.ok(f.calls.filter(call => call.method !== "GET").every(call => call.route !== `/api/issues/${f.issueId}`))
  assert.equal(f.tool.registrationError, null)
})

test("partial registration failures retain the receipt and recover committed writes without duplicates", async t => {
  const f = paperclipFixture(t)
  f.fail((route, options) => route.endsWith("/comments") && options.method === "POST")
  await assert.rejects(f.tool.execute(f.input), error => {
    assert.match(error.message, /Receipt:.*pull\/12.*HTTP 403/)
    assert.ok(!error.message.includes("private error body"))
    return true
  })
  assert.equal(f.products.length, 1)
  assert.ok(f.tool.registrationError)
  f.fail(null)
  await f.tool.execute(f.input)
  assert.equal(f.products.length, 1)
  assert.equal(f.comments.length, 1)
  assert.equal(f.tool.registrationError, null)
})

test("publication rejects missing or foreign issue context and unauthorized Paperclip access before GitHub writes", async t => {
  const f = paperclipFixture(t)
  await assert.rejects(f.tool.execute({ ...f.input, issueId: "22222222-2222-4222-8222-222222222222" }), /cannot override/)
  f.fail(() => true)
  await assert.rejects(f.tool.execute(f.input), /HTTP 403/)
  assert.equal(f.publications, 0)
  assert.equal(f.products.length, 0)
  assert.equal(f.comments.length, 0)
})

test("a lost comment response is reconciled without reposting and general Run Now requires an explicit issue", async t => {
  const f = paperclipFixture(t, { scoped: false })
  await assert.rejects(f.tool.execute(f.input), /assigned Paperclip issue UUID/)
  const input = { ...f.input, issueId: f.issueId }
  f.loseResponse((route, options) => route.endsWith("/comments") && options.method === "POST")
  await assert.rejects(f.tool.execute(input), /GitHub PR exists.*request failed/)
  assert.equal(f.comments.length, 1)
  f.loseResponse(null)
  await f.tool.execute(input)
  assert.equal(f.products.length, 1)
  assert.equal(f.comments.length, 1)
})

test("Azure PR receipts register/reconcile work products and chat links using their bound URL and users branch", async t => {
  const f = paperclipFixture(t, { azure: true })
  f.loseResponse((route, options) => route.endsWith("/comments") && options.method === "POST")
  await assert.rejects(f.tool.execute(f.input), /Azure DevOps PR exists.*request failed/)
  f.loseResponse(null)
  await f.tool.execute(f.input)
  assert.equal(f.products.length, 1)
  assert.equal(f.comments.length, 1)
  assert.equal(f.products[0].provider, "azure_devops")
  assert.equal(f.products[0].metadata.branch, f.receipt.branch)
  f.receipt.state = "MERGED"
  await f.tool.execute(f.input)
  assert.equal(f.products[0].status, "merged")
  assert.equal(f.comments.length, 2)
  assert.equal(f.tool.registrationError, null)
})

test("Azure registration rejects unbound PR URLs and branch namespaces", async t => {
  const f = paperclipFixture(t, { azure: true })
  f.receipt.url = "https://other.test/pullrequest/12"
  await assert.rejects(f.tool.execute(f.input), /invalid PR receipt/)
  f.receipt.url = "https://dev.azure.com/fixture/Project/_git/Repository/pullrequest/12"
  f.receipt.branch = `users/other/minicode-engineer-${f.receipt.commit}`
  await assert.rejects(f.tool.execute(f.input), /invalid PR receipt/)
  assert.equal(f.products.length, 0)
})
