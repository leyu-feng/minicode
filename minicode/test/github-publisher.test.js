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
  let pr = null, createError = null, worktreeError = null, pushCount = 0, beforePush = null
  const run = async (file, args, options) => {
    options.signal?.throwIfAborted()
    calls.push({ file, args: [...args], env: options.env })
    if (file === "gh") {
      if (args[0] === "auth") return "private-fixture-token"
      assert.equal(options.env.GH_TOKEN, "private-fixture-token")
      if (args[0] === "repo") return JSON.stringify({ id: "fixture-repository-id", nameWithOwner: "fixture-owner/project", defaultBranchRef: { name: "main" } })
      if (args[1] === "view") return JSON.stringify(pr)
      if (args[1] === "list") return JSON.stringify(pr && pr.headRefName === args[args.indexOf("--head") + 1] ? [pr] : [])
      if (args[1] === "create") {
        if (createError) throw typeof createError === "function" ? createError() : createError
        pr = { number: 12, url: "https://github.com/fixture-owner/project/pull/12", state: "OPEN", headRefOid: revision,
          headRefName: args[args.indexOf("--head") + 1], baseRefName: args[args.indexOf("--base") + 1] }
        return pr.url
      }
      assert.fail(`Unexpected gh operation: ${args[0]} ${args[1]}`)
    }
    if (args.includes("push")) {
      pushCount++
      if (beforePush) await beforePush(args)
    }
    if (args[0] === "worktree" && args[1] === "add") worktrees.push(args.at(-2))
    const rewritten = args.map(arg => arg === "https://github.com/fixture-owner/project.git" ? remote : arg)
    const output = (await exec(file, rewritten, { ...options, windowsHide: true })).stdout.trim()
    if (args[0] === "worktree" && args[1] === "add" && worktreeError) throw worktreeError
    return output
  }
  const publisher = await createGitHubPublisher({ repoRoot: source, repository: "fixture-owner/project", githubUser: "fixture-owner", run })
  const tool = publisher({ workspace, agentId: "engineer" })
  return { directory, source, workspace, remote, revision, git, tool, publisher, calls, worktrees,
    input: { commit: revision, title: "CI baseline", body: "Validated locally. Awaiting approval; no deployment." },
    get pushCount() { return pushCount },
    failCreation(error) { createError = error },
    failWorktreeAdd(error) { worktreeError = error },
    beforePush(callback) { beforePush = callback },
    get pr() { return pr },
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

test("publisher rejects foreign repositories and invalid inputs, and never publishes missing local revisions", async t => {
  const f = await fixture(t)
  await assert.rejects(createGitHubPublisher({ repoRoot: f.source, repository: "other/project", githubUser: "fixture-owner" }), /must match/)
  await assert.rejects(createGitHubPublisher({ repoRoot: f.source, repository: "fixture-owner/project" }), /github-user/)
  for (const input of [{ ...f.input, repository: "other/project" }, { ...f.input, commit: "HEAD" }, { ...f.input, commit: [f.revision] },
    { ...f.input, commit: "a".repeat(40) }]) {
    await assert.rejects(f.tool.execute(input))
  }
  assert.equal(f.pushCount, 0)
  assert.ok(!f.calls.some(call => call.file === "gh" && call.args[1] === "create"))
})

test("publisher allocates a suffix without overwriting a conflicting publication branch", async t => {
  const f = await fixture(t)
  const branch = "refs/heads/users/fixture-owner/engineer/ci-baseline"
  const baseline = await f.git(f.source, "rev-parse", "HEAD")
  await f.git(f.remote, "update-ref", branch, baseline)
  const receipt = await f.tool.execute(f.input)
  assert.equal(receipt.branch, "users/fixture-owner/engineer/ci-baseline-1")
  assert.equal(await f.git(f.remote, "rev-parse", branch), baseline)
  assert.equal(f.pushCount, 1)
})

test("branch allocation uses the tenth suffix, then fails explicitly when all eleven names are occupied", async t => {
  for (const occupied of [10, 11]) {
    await t.test(`${occupied} occupied names`, async t => {
      const f = await fixture(t)
      const baseline = await f.git(f.source, "rev-parse", "HEAD")
      const base = "users/fixture-owner/engineer/ci-baseline"
      for (let attempt = 0; attempt < occupied; attempt++) {
        await f.git(f.remote, "update-ref", `refs/heads/${base}${attempt ? `-${attempt}` : ""}`, baseline)
      }
      if (occupied === 10) assert.equal((await f.tool.execute(f.input)).branch, `${base}-10`)
      else {
        await assert.rejects(f.tool.execute(f.input), /10 suffix retries/)
        assert.equal(f.pushCount, 0)
        assert.equal(f.worktrees.length, 0)
      }
    })
  }
})

test("a create-only push race advances the suffix without overwriting the winning branch", async t => {
  const f = await fixture(t)
  const baseline = await f.git(f.source, "rev-parse", "HEAD")
  const branch = "users/fixture-owner/engineer/ci-baseline"
  f.beforePush(async () => {
    f.beforePush(null)
    await f.git(f.remote, "update-ref", `refs/heads/${branch}`, baseline)
  })
  const receipt = await f.tool.execute(f.input)
  assert.equal(receipt.branch, `${branch}-1`)
  assert.equal(f.pushCount, 2)
  assert.equal(await f.git(f.remote, "rev-parse", `refs/heads/${branch}`), baseline)
  for (const worktree of f.worktrees) await assert.rejects(fs.stat(path.dirname(worktree)), { code: "ENOENT" })
})

test("new publication still requires local ancestry even when the original commit object exists", async t => {
  const f = await fixture(t)
  await f.git(f.source, "fetch", "--no-tags", "--no-write-fetch-head", f.workspace, f.revision)
  const tool = f.publisher({ workspace: f.source, agentId: "engineer" })
  await assert.rejects(tool.execute(f.input))
  assert.equal(f.pushCount, 0)
  assert.equal(f.worktrees.length, 0)
  assert.ok(!f.calls.some(call => call.file === "gh" && call.args[1] === "create"))
})

test("an uncertain push outcome does not allocate another name and retries reconcile the original branch", async t => {
  const f = await fixture(t)
  const branch = "users/fixture-owner/engineer/ci-baseline"
  f.beforePush(async () => {
    f.beforePush(null)
    await f.git(f.workspace, "push", f.remote, `${f.revision}:refs/heads/${branch}`)
    throw new Error("Connection lost after push")
  })
  await assert.rejects(f.tool.execute(f.input), /Connection lost after push/)
  assert.equal(f.pushCount, 1)
  assert.equal((await f.tool.execute(f.input)).branch, branch)
  assert.equal(f.pushCount, 1)
})

test("GitHub reconciles a squash-merged PR by saved number on another checkout after branch deletion", async t => {
  const f = await fixture(t)
  const receipt = await f.tool.execute(f.input)
  assert.equal(receipt.branch, "users/fixture-owner/engineer/ci-baseline")
  f.pr.state = "MERGED"
  await f.git(f.remote, "update-ref", "-d", `refs/heads/${receipt.branch}`)
  const fresh = path.join(f.directory, "fresh")
  await f.git(f.directory, "clone", "--no-local", "--single-branch", "--branch", "main", f.remote, fresh)
  await fs.writeFile(path.join(fresh, "tracked.txt"), "validated change")
  await f.git(fresh, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "-c", "commit.gpgsign=false", "commit", "-am", "Squashed feature")
  await f.git(fresh, "remote", "set-url", "origin", "https://github.com/fixture-owner/project.git")
  await assert.rejects(f.git(fresh, "cat-file", "-e", `${f.revision}^{commit}`))
  const publisher = await createGitHubPublisher({ repoRoot: fresh, repository: "fixture-owner/project",
    githubUser: "another-user", run: async (file, args, options) => {
      if (file === "gh") {
        if (args[0] === "auth") return "private-fixture-token"
        if (args[0] === "repo") return JSON.stringify({ id: receipt.repositoryId, nameWithOwner: receipt.repository, defaultBranchRef: { name: "new-default" } })
        assert.equal(args[1], "view")
        assert.equal(args[2], String(receipt.number))
        return JSON.stringify(f.pr)
      }
      f.calls.push({ file, args: [...args], env: options.env })
      assert.ok(!args.includes("push") && !args.includes("ls-remote") && !["cat-file", "merge-base", "worktree"].includes(args[0]))
      return (await exec(file, args, { ...options, windowsHide: true })).stdout.trim()
    } })
  const tool = publisher({ workspace: fresh, agentId: "engineer", agentName: "Renamed Engineer" })
  const merged = await tool.execute({ ...f.input, title: "Edited title" }, { publication: { existing: receipt } })
  assert.equal(merged.state, "MERGED")
  assert.equal(merged.branch, receipt.branch)
  assert.equal(f.pushCount, 1)
  f.pr.headRefOid = "b".repeat(40)
  await assert.rejects(tool.execute(f.input, { publication: { existing: receipt } }), /source commit does not match/)
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

function paperclipFixture(t, { scoped = true, azure = false, allocate = false, providerTool, apiUrl = "http://paperclip.test" } = {}) {
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
  const products = [], comments = [], calls = [], contexts = []
  let publications = 0, failure = null, loseResponse = null
  const tool = paperclipPublicationTool(providerTool ?? {
    name: "publish_pull_request", description: "Fixture publisher", parameters: { type: "object", properties: {} },
    async execute(input, options) {
      assert.equal(input.issueId, undefined)
      contexts.push(options.publication)
      if (allocate) {
        const saved = options.publication.existing ?? options.publication.allocation
        receipt.branch = saved?.branch ?? "users/alice/engineer/ci-baseline"
        receipt.target = "main"
        receipt.repositoryId = "fixture-repository"
        if (!options.publication.existing) await options.publication.saveAllocation({
          branch: receipt.branch, baseBranch: receipt.branch, attempt: 0, commit: receipt.commit,
          target: receipt.target, repositoryId: receipt.repositoryId, pushed: false,
        })
      }
      publications++
      return { ...receipt }
    },
  }, { apiUrl, authToken: "fixture-run-key", runId: "fixture-run-id",
    issueId: scoped ? issueId : "", agentId, companyId: "company-a", repository: receipt.repository, ...azureOptions })
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const prefix = new URL(apiUrl).pathname.replace(/\/+$/, "")
    const requestUrl = new URL(url)
    assert.equal(requestUrl.origin, new URL(apiUrl).origin)
    assert.ok(requestUrl.pathname.startsWith(`${prefix}/api/`), "Paperclip requests must preserve the API URL's proxy prefix")
    const route = requestUrl.pathname.slice(prefix.length)
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
      if (body) products.push({ ...body, id: `product-${products.length + 1}`, issueId })
      result = body ? products.at(-1) : products
    } else if (route.startsWith("/api/work-products/")) {
      const product = products.find(product => route === `/api/work-products/${product.id}`)
      assert.ok(product)
      Object.assign(product, body)
      result = product
    } else if (route.endsWith("/comments")) {
      if (body) comments.push({ ...body, id: `comment-${comments.length}`, issueId, authorAgentId: agentId })
      result = body ? comments.at(-1) : comments
    } else assert.fail(`Unexpected route ${route}`)
    if (loseResponse?.(route, options)) throw new Error("Response lost after server commit")
    return Response.json(result)
  })
  return { tool, receipt, products, comments, calls, contexts, issueId,
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

test("branch allocation is persisted before publication and saved PR identity survives title changes", async t => {
  const f = paperclipFixture(t, { allocate: true })
  await f.tool.execute(f.input)
  assert.equal(f.products.length, 2)
  assert.equal(f.products[0].type, "branch")
  assert.equal(f.products[0].metadata.branch, "users/alice/engineer/ci-baseline")
  assert.equal(f.products[1].type, "pull_request")
  assert.equal(f.products[1].metadata.repositoryId, "fixture-repository")
  assert.equal(f.products[1].metadata.target, "main")
  f.receipt.state = "MERGED"
  await f.tool.execute({ ...f.input, title: "Different feature title" })
  assert.equal(f.contexts[1].existing.number, 12)
  assert.equal(f.contexts[1].existing.branch, "users/alice/engineer/ci-baseline")
  assert.equal(f.products.length, 2)
  assert.equal(f.products[1].status, "merged")
})

test("real publication journals its branch and a new tool reconciles the saved PR without ancestor history", async t => {
  const git = await fixture(t)
  const f = paperclipFixture(t, { providerTool: git.tool })
  const first = await f.tool.execute(git.input)
  assert.equal(f.products.length, 2)
  assert.equal(f.products[0].metadata.pushed, true)
  assert.equal(f.products[0].metadata.branch, first.branch)
  assert.equal(f.products[1].metadata.number, first.number)
  await assert.rejects(git.git(git.source, "merge-base", "--is-ancestor", git.revision, "HEAD"))
  await git.git(git.remote, "update-ref", "-d", `refs/heads/${first.branch}`)
  git.pr.state = "MERGED"
  const next = paperclipPublicationTool(git.publisher({ workspace: git.source, agentId: "engineer", agentName: "Renamed engineer" }), {
    apiUrl: "http://paperclip.test", authToken: "fixture-run-key", runId: "fixture-run-id", issueId: f.issueId,
    agentId: "engineer", companyId: "company-a", repository: first.repository,
  })
  const merged = await next.execute({ ...git.input, title: "Edited title" })
  assert.equal(merged.state, "MERGED")
  assert.equal(merged.branch, first.branch)
  assert.equal(f.products.length, 2)
  assert.equal(f.products[1].status, "merged")
  assert.equal(git.pushCount, 1)
})

test("a lost allocation response causes no provider write and retries reuse the durable branch record", async t => {
  const f = paperclipFixture(t, { allocate: true })
  f.loseResponse((route, options) => route.endsWith("/work-products") && options.method === "POST")
  await assert.rejects(f.tool.execute(f.input), /request failed/)
  assert.equal(f.publications, 0)
  assert.equal(f.products.length, 1)
  f.loseResponse(null)
  await f.tool.execute({ ...f.input, title: "Changed title after restart" })
  assert.equal(f.contexts[1].allocation.branch, "users/alice/engineer/ci-baseline")
  assert.equal(f.products.length, 2)
  assert.equal(f.publications, 1)
})

test("foreign, invalid and ambiguous saved PR identities fail before provider access", async t => {
  const f = paperclipFixture(t)
  await f.tool.execute(f.input)
  const product = f.products[0]
  product.metadata.agentId = "other-agent"
  await assert.rejects(f.tool.execute(f.input), /another agent/)
  product.metadata.agentId = "engineer"
  product.url = "https://other.test/pull/12"
  await assert.rejects(f.tool.execute(f.input), /Saved PR identity is invalid/)
  product.url = f.receipt.url
  f.products.push({ ...product, id: "duplicate" })
  await assert.rejects(f.tool.execute(f.input), /Ambiguous saved publication/)
  assert.equal(f.publications, 1)
})

test("publication preserves proxy prefixes for issue lookup, registration, comments and reconciliation", async t => {
  for (const azure of [false, true]) {
    for (const trailingSlash of ["", "/"]) {
      await t.test(`${azure ? "Azure DevOps" : "GitHub"} with ${trailingSlash ? "a" : "no"} trailing slash`, async t => {
        const f = paperclipFixture(t, { azure, apiUrl: `http://127.0.0.1:12345/entra-proxy-prefix${trailingSlash}` })
        const first = await f.tool.execute(f.input)
        assert.equal(first.paperclip.issueId, f.issueId)
        f.receipt.state = "MERGED"
        await f.tool.execute(f.input)
        assert.equal(f.products.length, 1)
        assert.equal(f.products[0].status, "merged")
        assert.equal(f.comments.length, 2)
        assert.ok(f.calls.some(call => call.route === "/api/work-products/product-1" && call.method === "PATCH"))
        assert.equal(f.tool.registrationError, null)
      })
    }
  }
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
