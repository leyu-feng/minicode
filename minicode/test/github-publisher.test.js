import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import test from "node:test"
import { createGitHubPublisher } from "../server/github-publisher.js"

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
