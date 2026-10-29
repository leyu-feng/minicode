import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { readWorkerGuidance, assertWorkerSkillsUnchanged } from "../server/worker-guidance.js"

async function addSkill(root, folder, name, content = "instructions") {
  const directory = path.join(root, folder, "skills", name)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, "SKILL.md"), content)
  return directory
}

test("all skill sources load automatically and shared skills override same-named skills", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-trust-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, "workspace"), workerShared = path.join(root, "shared"), reference = path.join(root, "reference")
  await fs.mkdir(workspace); await fs.mkdir(workerShared); await fs.mkdir(reference)
  const shared = await addSkill(workerShared, ".github", "enghub")
  await addSkill(workerShared, ".agents", "paperclip", "trusted shared Paperclip")
  await addSkill(workspace, ".agents", "review")
  const repository = path.join(root, "repository")
  await fs.mkdir(repository)
  await addSkill(repository, ".github", "repository-review")
  await addSkill(reference, ".github", "reference")
  const bundleDirectory = path.join(root, "bundle")
  await fs.mkdir(path.join(bundleDirectory, "paperclip"), { recursive: true })
  await fs.writeFile(path.join(bundleDirectory, "paperclip", "SKILL.md"), "bundled Paperclip")
  await fs.mkdir(path.join(bundleDirectory, "onboarding"), { recursive: true })
  await fs.writeFile(path.join(bundleDirectory, "onboarding", "SKILL.md"), "bundled onboarding")

  const guidance = await readWorkerGuidance({
    workspace, workerShared, workspaceSource: path.join(root, "source"),
    bundle: { directory: bundleDirectory, entries: ["paperclip/SKILL.md", "onboarding/SKILL.md"], sha256: "a".repeat(64) },
    repositories: [{ name: "Main", path: repository }],
    references: [{ name: "Ref", path: reference }],
  })
  assert.deepEqual(guidance.skills.map(skill => skill.name), ["enghub", "onboarding", "paperclip", "reference", "repository-review", "review"])
  assert.equal(guidance.paperclipInstructions, "trusted shared Paperclip")
  assert.equal(guidance.skills.find(skill => skill.name === "paperclip").source, "worker_shared")
  assert.equal(guidance.skills.find(skill => skill.name === "review").source, "worktree")
  assert.equal(guidance.skills.find(skill => skill.name === "reference").source, "reference:Ref")
  assert.equal(guidance.skills.find(skill => skill.name === "repository-review").source, "repository:Main")
  await assertWorkerSkillsUnchanged(guidance.skills)
  await fs.writeFile(path.join(shared, "helper.js"), "operator-updated shared helper")
  await assert.doesNotReject(assertWorkerSkillsUnchanged(guidance.skills))
})

test("non-shared skill contents are pinned for an assignment and shared skills take precedence", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-precedence-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, "workspace"), shared = path.join(root, "shared"), repository = path.join(root, "repo")
  await fs.mkdir(workspace); await fs.mkdir(shared); await fs.mkdir(repository)
  const worktreeSkill = await addSkill(workspace, ".agents", "review")
  const repositorySkill = await addSkill(repository, ".github", "repo-only")
  await addSkill(shared, ".agents", "review", "shared wins")
  const args = { workspace, workerShared: shared, repositories: [{ name: "Main", path: repository }] }
  const guidance = await readWorkerGuidance(args)
  assert.equal(guidance.skills.find(skill => skill.name === "review").source, "worker_shared")
  assert.equal(guidance.skills.find(skill => skill.name === "repo-only").source, "repository:Main")
  await fs.writeFile(path.join(repositorySkill, "helper.js"), "changed after catalog resolution")
  await assert.rejects(assertWorkerSkillsUnchanged(guidance.skills), /changed after catalog resolution/)
  await assert.doesNotReject(fs.access(path.join(worktreeSkill, "SKILL.md")))
})

test("supervisory instructions remain mandatory and duplicate skills fail closed", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-supervisory-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, "workspace"), shared = path.join(root, "shared")
  await fs.mkdir(workspace); await fs.mkdir(shared)
  const repositories = [{ name: "Shared", path: shared, readOnly: true, supervisory: true }]
  await assert.rejects(readWorkerGuidance({ workspace, workerShared: shared, repositories }), /must provide AGENTS.md/)
  await fs.writeFile(path.join(shared, "AGENTS.md"), "shared")
  assert.equal((await readWorkerGuidance({ workspace, workerShared: shared, repositories })).sharedInstructions, "shared")
  await addSkill(shared, ".agents", "same")
  await addSkill(shared, ".github", "SAME")
  await assert.rejects(readWorkerGuidance({ workspace, workerShared: shared, repositories }), /Duplicate worker skill name/)
})

test("linked skill helper directories are rejected, including shared skills", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-links-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, "workspace"), shared = path.join(root, "shared"), target = path.join(root, "target")
  await fs.mkdir(workspace); await fs.mkdir(shared); await fs.mkdir(target)
  const directory = await addSkill(shared, ".github", "review")
  try { await fs.symlink(target, path.join(directory, "helpers"), process.platform === "win32" ? "junction" : "dir") }
  catch (error) { if (error.code === "EPERM") { t.skip("Link creation requires permission"); return } throw error }
  await assert.rejects(readWorkerGuidance({ workspace, workerShared: shared }), /link/)
})
