import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { prepareWorkerWorkspace } from "../server/worker-workspace.js"

const execute = promisify(execFile)

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-multi-workspace-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const remotes = new Map()
  const rawGit = async (cwd, args) => (await execute("git", args, { cwd, windowsHide: true })).stdout.trim()
  const git = async (cwd, args, options = {}) => {
    const rewrites = args[0] === "fetch"
      ? [...remotes].flatMap(([url, remote]) => ["-c", `url.${remote}.insteadOf=${url}`]) : []
    return (await execute("git", [...rewrites, ...args], { cwd, windowsHide: true, ...options })).stdout.trim()
  }
  const repositories = []
  for (const id of ["supervisor", "application", "reference"]) {
    const directory = path.join(root, id)
    await fs.mkdir(directory)
    await rawGit(directory, ["init", "--initial-branch=main"])
    await fs.writeFile(path.join(directory, "AGENTS.md"), `${id} guidance`)
    await rawGit(directory, ["add", "."])
    await rawGit(directory, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
      "-c", "commit.gpgsign=false", "commit", "-m", "Initial"])
    const remote = path.join(root, `.${id}-remote.git`)
    await rawGit(root, ["clone", "--bare", directory, remote])
    const url = `https://example.test/${id}`
    await rawGit(directory, ["remote", "add", "origin", url])
    remotes.set(url, remote)
    repositories.push({ id, source: url, checkout: "clone", branch: "main",
      ...(id === "supervisor" ? { supervisory: true } : {}),
      ...(id === "reference" ? { readOnly: true } : {}) })
  }
  const config = { version: 1, repositories }
  const save = () => fs.writeFile(path.join(root, "workspace.json"), JSON.stringify(config))
  await save()
  const options = { root, workerId: randomUUID(), workerName: "worker-one",
    server: "https://clippy.example.test", git, log: () => {}, readFreeBytes: async () => 1024 ** 4 }
  return { root, config, save, options, git }
}

test("workspace root gives two workers independent clean worktrees without touching sources or read-only checkouts", async t => {
  const { root, options, git } = await fixture(t)
  await fs.writeFile(path.join(root, "application", "AGENTS.md"), "dirty source guidance")
  await fs.writeFile(path.join(root, "supervisor", "operator-note.txt"), "shared")
  const first = await prepareWorkerWorkspace(options)
  const second = await prepareWorkerWorkspace({ ...options, workerId: randomUUID(), server: "https://second-clippy.example.test" })
  const a = await first.prepare("agent-a", "run-a")
  const b = await second.prepare("agent-a", "run-b")
  const serviceA = a.repositories.find(repo => repo.name === "application")
  const serviceB = b.repositories.find(repo => repo.name === "application")
  assert.notEqual(serviceA.path, serviceB.path)
  assert.equal(await fs.readFile(path.join(serviceA.path, "AGENTS.md"), "utf8"), "application guidance")
  assert.equal(await fs.readFile(path.join(root, "application", "AGENTS.md"), "utf8"), "dirty source guidance")
  assert.equal(first.workerShared, path.join(root, "supervisor"))
  assert.equal(a.repositories.find(repo => repo.name === "supervisor").readOnly, true)
  assert.equal(a.repositories.find(repo => repo.name === "reference").path, path.join(root, "reference"))
  assert.equal(a.repositories.find(repo => repo.name === "reference").readOnly, true)
  assert.notEqual(a.artifacts, b.artifacts)
  await fs.writeFile(path.join(serviceA.path, "AGENTS.md"), "task edit")
  await fs.writeFile(path.join(serviceA.path, "discard.txt"), "temporary")
  await fs.writeFile(path.join(serviceB.path, "keep.txt"), "other worker")
  first.release()
  const next = await first.prepare("agent-a", "run-c")
  assert.equal(next.repositories.find(repo => repo.name === "application").path, serviceA.path)
  assert.equal(await fs.readFile(path.join(serviceA.path, "AGENTS.md"), "utf8"), "application guidance")
  await assert.rejects(fs.readFile(path.join(serviceA.path, "discard.txt")), { code: "ENOENT" })
  assert.equal(await fs.readFile(path.join(serviceB.path, "keep.txt"), "utf8"), "other worker")
  assert.equal(await fs.readFile(path.join(root, "supervisor", "operator-note.txt"), "utf8"), "shared")
  assert.equal(await git(root, ["rev-parse", "--is-inside-work-tree"]).catch(() => "not-git"), "not-git")
  first.release()
  second.release()
})

test("Devbox worktree sources give workers independent checkouts while reference clones stay read-only", async t => {
  const { root, config, save, options, git } = await fixture(t)
  const application = config.repositories.find(repo => repo.id === "application")
  application.checkout = "worktree"
  await save()
  const source = path.join(root, "application")
  const original = path.join(root, ".application-original")
  await fs.rename(source, original)
  await fs.mkdir(source)
  const common = path.join(source, ".git")
  await git(root, ["clone", "--bare", original, common])
  await git(root, [`--git-dir=${common}`, "remote", "set-url", "origin", application.source])
  await git(root, [`--git-dir=${common}`, "worktree", "add", path.join(source, "main"), "main"])
  await fs.writeFile(path.join(source, "main", "AGENTS.md"), "operator changes")
  const first = await prepareWorkerWorkspace(options)
  const second = await prepareWorkerWorkspace({ ...options, workerId: randomUUID(), workerName: "worker-two" })
  const a = await first.prepare("agent-a", "run-a")
  const b = await second.prepare("agent-a", "run-b")
  const serviceA = a.repositories.find(repo => repo.name === "application")
  const serviceB = b.repositories.find(repo => repo.name === "application")
  assert.notEqual(serviceA.path, serviceB.path)
  assert.notEqual(serviceA.path, path.join(source, "main"))
  assert.equal(serviceA.readOnly, false)
  assert.equal(await git(serviceA.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    common.replaceAll("\\", "/"))
  assert.equal(await fs.readFile(path.join(serviceA.path, "AGENTS.md"), "utf8"), "application guidance")
  assert.equal(await fs.readFile(path.join(source, "main", "AGENTS.md"), "utf8"), "operator changes")
  for (const assignment of [a, b]) {
    for (const name of ["supervisor", "reference"]) {
      const repo = assignment.repositories.find(repo => repo.name === name)
      assert.equal(repo.path, path.join(root, name))
      assert.equal(repo.readOnly, true)
    }
  }
  first.release()
  second.release()
})

test("workspace supports full-length worker names and multi-digit agent slots across restarts", async t => {
  const { root, options } = await fixture(t)
  const settings = { ...options, workerName: "inspection-worker-123456" }
  const workspace = await prepareWorkerWorkspace(settings)
  const directories = []
  for (let index = 0; index < 10; index++) {
    const assignment = await workspace.prepare(`agent-${index}`, `run-${index}`)
    const directory = assignment.repositories.find(repo => repo.name === "application").path
    assert.notEqual(directory, path.join(root, "application"))
    directories.push(directory)
    workspace.release()
  }
  assert.equal(new Set(directories).size, directories.length)
  const resumed = await prepareWorkerWorkspace(settings)
  const assignment = await resumed.prepare("agent-9", "run-resumed")
  assert.equal(assignment.repositories.find(repo => repo.name === "application").path, directories[9])
  resumed.release()
})

test("workspace rejects changed config and source remote instead of reusing or redirecting checkouts", async t => {
  const { root, config, save, options, git } = await fixture(t)
  const workspace = await prepareWorkerWorkspace(options)
  await git(path.join(root, "application"), ["remote", "set-url", "origin", "https://example.test/foreign"])
  await assert.rejects(workspace.prepare("agent-a", "run-a"), /identity changed/)
  await git(path.join(root, "application"), ["remote", "set-url", "origin", config.repositories[1].source])
  config.repositories[1].branch = "other"
  await save()
  await assert.rejects(workspace.prepare("agent-a", "run-b"), /changed; restart/)
})

test("workspace rejects missing supervisory metadata and duplicate or unsafe repository entries", async t => {
  const { config, save, options } = await fixture(t)
  await assert.rejects(prepareWorkerWorkspace({ ...options, workerId: "../other-worker" }), /safe worker ID/)
  await assert.rejects(prepareWorkerWorkspace({ ...options, workerName: "../other-worker" }), /safe worker ID/)
  config.repositories[0].supervisory = false
  await save()
  await assert.rejects(prepareWorkerWorkspace(options), /exactly one supervisory/)
  config.repositories[0].supervisory = true
  config.repositories.push({ ...config.repositories[1] })
  await save()
  await assert.rejects(prepareWorkerWorkspace(options), /duplicate/)
  config.repositories.pop()
  config.repositories[1].source = "https://user:password@example.test/services"
  await save()
  await assert.rejects(prepareWorkerWorkspace(options), /without credentials/)
})

test("workspace rejects linked run directories without writing through to unmanaged files", async t => {
  const { root, options } = await fixture(t)
  const workspace = await prepareWorkerWorkspace(options)
  const unmanaged = path.join(root, "unmanaged")
  await fs.mkdir(unmanaged)
  await fs.writeFile(path.join(unmanaged, "keep.txt"), "operator-owned")
  await fs.symlink(unmanaged, path.join(root, ".workers", options.workerId, "linked-run"), "junction")
  await assert.rejects(workspace.prepare("agent-a", "linked-run"), /must not contain directory links/)
  assert.equal(await fs.readFile(path.join(unmanaged, "keep.txt"), "utf8"), "operator-owned")
  await assert.rejects(fs.stat(path.join(unmanaged, "workspace.json")), { code: "ENOENT" })
  workspace.release()
})
