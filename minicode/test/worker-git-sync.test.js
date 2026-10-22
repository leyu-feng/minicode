import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { prepareWorkerGitSync } from "../server/worker-git-sync.js"

const exec = promisify(execFile)
const git = async (cwd, args, { signal } = {}) => (await exec("git", args, {
  cwd, windowsHide: true, signal, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
})).stdout.trim()

async function fixture(t, mode = "worktree") {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "minicode-git-sync-")))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const seed = path.join(root, "seed")
  const remote = path.join(root, "remote.git")
  const source = path.join(root, "source")
  const reference = path.join(root, "reference")
  const workspace = path.join(root, "w1a1")
  const other = path.join(root, "w2a1")
  await fs.mkdir(seed)
  await git(seed, ["init", "--initial-branch=main"])
  const commitAt = async (directory, message) => {
    await git(directory, ["add", "."])
    await git(directory, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
      "-c", "commit.gpgsign=false", "commit", "-m", message])
    return git(directory, ["rev-parse", "HEAD"])
  }
  await fs.writeFile(path.join(seed, "code.txt"), "initial")
  const initial = await commitAt(seed, "Initial")
  await git(root, ["clone", "--bare", "--no-hardlinks", seed, remote])
  await git(seed, ["remote", "add", "origin", remote])
  await git(root, ["clone", "--no-hardlinks", remote, source])
  await git(root, ["clone", "--no-hardlinks", remote, reference])
  if (mode === "clone") {
    await git(root, ["clone", "--no-hardlinks", source, workspace])
    await git(root, ["clone", "--no-hardlinks", source, other])
  } else {
    await git(source, ["worktree", "add", "-b", "w1a1", workspace, "HEAD"])
    await git(source, ["worktree", "add", "-b", "w2a1", other, "HEAD"])
  }
  const publish = async (branch, contents) => {
    const exists = await git(seed, ["branch", "--list", branch])
    await git(seed, ["checkout", ...(exists ? [] : ["-b"]), branch])
    await fs.writeFile(path.join(seed, "code.txt"), contents)
    const commit = await commitAt(seed, contents)
    await git(seed, ["push", "origin", `HEAD:refs/heads/${branch}`])
    return commit
  }
  const logs = []
  const create = (options = {}) => prepareWorkerGitSync({
    source, references: [{ name: "code", path: reference, branch: "release" }],
    workerId: randomUUID(), git, validate: async () => {}, log: message => logs.push(message), ...options,
  })
  return { root, seed, remote, source, reference, workspace, other, initial, publish, commitAt, create, logs }
}

for (const mode of ["clone", "worktree"]) {
  test(`${mode}: assignment preparation pins branches and agent refresh isolates primary and reference checkouts`, async t => {
    const f = await fixture(t, mode)
    const release = await f.publish("release", "release-v1")
    const main = await f.publish("main", "main-v2")
    const controller = await f.create()
    await fs.writeFile(path.join(f.reference, "code.txt"), "discard reference edit")
    await fs.writeFile(path.join(f.reference, "keep.txt"), "untracked reference")
    const prepared = await controller.prepare()
    assert.equal(prepared.primaryCommit, main)
    assert.deepEqual(prepared.references, [{ name: "code", path: await fs.realpath(f.reference), branch: "release", commit: release }])
    assert.equal(await fs.readFile(path.join(f.reference, "code.txt"), "utf8"), "release-v1")
    assert.equal(await git(f.reference, ["rev-parse", "--symbolic-full-name", "HEAD"]), "HEAD")
    assert.equal(await git(f.reference, ["rev-parse", "main"]), f.initial)
    assert.equal(await fs.readFile(path.join(f.reference, "keep.txt"), "utf8"), "untracked reference")
    await controller.resetPrimary(f.workspace, prepared.primaryCommit)
    const localBranch = await git(f.workspace, ["rev-parse", "--symbolic-full-name", "HEAD"])
    const tool = await controller.tool({ workspace: f.workspace })
    const main2 = await f.publish("main", "main-v3")
    const release2 = await f.publish("release", "release-v2")
    const result = await tool.execute({ repositories: ["primary", "all_references"], operation: "pull" })
    assert.equal(result.repositories.find(entry => entry.name === "primary").commit, main2)
    assert.equal(result.repositories.find(entry => entry.name === "code").commit, release2)
    assert.equal(await git(f.workspace, ["rev-parse", "--symbolic-full-name", "HEAD"]), localBranch)
    assert.equal(await git(f.source, ["rev-parse", "HEAD"]), f.initial)
    assert.equal(await git(f.other, ["rev-parse", "HEAD"]), f.initial)

    await fs.writeFile(path.join(f.workspace, "local.txt"), "local committed work")
    const localCommit = await f.commitAt(f.workspace, "Local commit")
    await fs.writeFile(path.join(f.workspace, "code.txt"), "local dirty edit")
    await fs.writeFile(path.join(f.workspace, "keep.txt"), "untracked primary")
    await fs.mkdir(path.join(f.workspace, "ignored-cache"))
    await fs.writeFile(path.join(f.workspace, "ignored-cache", "cache.txt"), "ignored primary cache")
    const exclude = await git(f.workspace, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"])
    await fs.appendFile(exclude, "\nignored-cache/\n")
    await fs.writeFile(path.join(f.other, "keep.txt"), "another worker's file")
    await fs.writeFile(path.join(f.source, "keep.txt"), "source untracked file")
    const main3 = await f.publish("main", "main-v4")
    await assert.rejects(tool.execute({ repositories: ["primary"], operation: "pull" }), /fast-forward|overwritten|Aborting/i)
    assert.equal(await git(f.workspace, ["rev-parse", "HEAD"]), localCommit)
    await tool.execute({ repositories: ["primary", "code"], operation: "fetch_reset" })
    assert.equal(await git(f.workspace, ["rev-parse", "HEAD"]), main3)
    assert.equal(await git(f.workspace, ["rev-parse", "--symbolic-full-name", "HEAD"]), localBranch)
    assert.equal(await fs.readFile(path.join(f.workspace, "code.txt"), "utf8"), "main-v4")
    await assert.rejects(fs.stat(path.join(f.workspace, "keep.txt")), { code: "ENOENT" })
    await assert.rejects(fs.stat(path.join(f.workspace, "ignored-cache")), { code: "ENOENT" })
    assert.equal(await fs.readFile(path.join(f.reference, "keep.txt"), "utf8"), "untracked reference")
    assert.equal(await fs.readFile(path.join(f.other, "keep.txt"), "utf8"), "another worker's file")
    assert.equal(await fs.readFile(path.join(f.source, "keep.txt"), "utf8"), "source untracked file")
    await assert.rejects(fs.stat(path.join(f.workspace, "local.txt")), { code: "ENOENT" })
    assert.equal(await git(f.source, ["rev-parse", "HEAD"]), f.initial)
    assert.equal(await git(f.other, ["rev-parse", "HEAD"]), f.initial)
  })
}

test("Git sync refuses branch/path/remote overrides, branch changes and cancellation without destructive updates", async t => {
  const f = await fixture(t)
  await f.publish("release", "release-v1")
  const controller = await f.create()
  const tool = await controller.tool({ workspace: f.workspace })
  for (const input of [
    { repositories: ["missing"], operation: "fetch_reset" },
    { repositories: [], operation: "fetch_reset" },
    { repositories: ["primary", "primary"], operation: "pull" },
    { repositories: ["primary"], operation: "reset" },
    { repositories: ["primary"], operation: "fetch_reset", branch: "other" },
    { repositories: ["primary"], operation: "fetch_reset", path: f.other },
  ]) await assert.rejects(tool.execute(input), /sync_repositories requires/)
  const abort = new AbortController()
  abort.abort(new Error("Cancelled refresh"))
  await assert.rejects(tool.execute({ repositories: ["primary"], operation: "fetch_reset" }, { signal: abort.signal }), /Cancelled refresh/)
  await git(f.workspace, ["checkout", "-b", "another-branch"])
  await assert.rejects(tool.execute({ repositories: ["primary"], operation: "fetch_reset" }), /local branch changed/)
  assert.equal(await git(f.workspace, ["rev-parse", "HEAD"]), f.initial)
  await git(f.workspace, ["checkout", "w1a1"])
  await git(f.source, ["remote", "set-url", "origin", path.join(f.root, "changed.git")])
  await assert.rejects(tool.execute({ repositories: ["primary"], operation: "fetch_reset" }), /configured remote changed/)
  assert.equal(await git(f.workspace, ["rev-parse", "HEAD"]), f.initial)
})

test("an unavailable assigned branch fails explicitly, preserves checkouts and allows retry", async t => {
  const f = await fixture(t)
  const controller = await f.create()
  await assert.rejects(controller.prepare(), /Git fetch failed for 'code' assigned branch 'release'/)
  assert.equal(await git(f.reference, ["rev-parse", "HEAD"]), f.initial)
  assert.equal(await git(f.source, ["rev-parse", "HEAD"]), f.initial)
  const release = await f.publish("release", "now available")
  assert.equal((await controller.prepare()).references[0].commit, release)
  await fs.rename(f.remote, `${f.remote}-unavailable`)
  await assert.rejects(controller.prepare(), /Git fetch failed/)
  assert.equal(await git(f.reference, ["rev-parse", "HEAD"]), release)
})

test("cancelling a pending fetch stops assignment preparation before changing either checkout", async t => {
  const f = await fixture(t)
  let reachedFetch
  const fetching = new Promise(resolve => { reachedFetch = resolve })
  const abort = new AbortController()
  t.after(() => abort.abort())
  const controller = await f.create({
    git: async (cwd, args, options = {}) => {
      if (args[0] !== "fetch") return git(cwd, args, options)
      reachedFetch()
      return new Promise((resolve, reject) => options.signal.addEventListener("abort",
        () => reject(options.signal.reason), { once: true }))
    },
  })
  const preparing = controller.prepare({ signal: abort.signal })
  await fetching
  abort.abort(new Error("Cancelled pending fetch"))
  await assert.rejects(preparing, /Cancelled pending fetch/)
  assert.equal(await git(f.reference, ["rev-parse", "HEAD"]), f.initial)
  assert.equal(await git(f.workspace, ["rev-parse", "HEAD"]), f.initial)
})

test("unqualified repositories capture upstream once and detached references require a branch selector", async t => {
  const f = await fixture(t)
  const controller = await f.create({ references: [{ name: "code", path: f.reference }] })
  const tool = await controller.tool({ workspace: f.workspace })
  await f.publish("release", "release-v1")
  const main = await f.publish("main", "main-v2")
  await git(f.source, ["checkout", "-b", "release", "--track", "origin/main"])
  await git(f.source, ["branch", "--set-upstream-to=origin/main", "main"])
  const result = await tool.execute({ repositories: ["primary", "code"], operation: "fetch_reset" })
  assert.ok(result.repositories.every(entry => entry.branch === "main" && entry.commit === main))
  await git(f.reference, ["checkout", "--detach", "HEAD"])
  await assert.rejects(f.create({ references: [{ name: "code", path: f.reference }] }), /explicit branch@ selector/)
  await assert.rejects(f.create({ references: [{ name: "code", path: f.reference, branch: "../invalid" }] }), /check-ref-format/)
  const assigned = await f.create({ sourceBranch: "release", references: [] })
  const release = await git(f.seed, ["rev-parse", "release"])
  assert.equal((await assigned.prepare()).primaryCommit, release)
})
