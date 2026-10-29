import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { readWorkerGuidance, assertWorkerSkillsUnchanged } from "../server/worker-guidance.js"
import { readSkillApprovals, skillDigest, validateApprovalLocation } from "../server/skill-approvals.js"

async function addSkill(root, folder, name, content = "instructions") {
  const directory = path.join(root, folder, "skills", name)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, "SKILL.md"), content)
  return directory
}

test("shared skills are trusted, other sources require exact source and full-content approval", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-trust-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, "workspace"), workerShared = path.join(root, "shared"), reference = path.join(root, "reference")
  await fs.mkdir(workspace); await fs.mkdir(workerShared); await fs.mkdir(reference)
  const trusted = await addSkill(workerShared, ".github", "enghub")
  await addSkill(workerShared, ".agents", "paperclip", "trusted")
  const untrusted = await addSkill(workspace, ".agents", "review")
  await fs.writeFile(path.join(untrusted, "helper.js"), "first")
  const ref = await addSkill(reference, ".github", "reference")
  const args = { workspace, workspaceSource: path.join(root, "source"), workerShared, references: [{ name: "Ref", path: reference }] }
  let guidance = await readWorkerGuidance(args)
  assert.deepEqual(guidance.skills.map(s => s.name), ["enghub", "paperclip"])
  assert.equal(guidance.paperclipInstructions, "trusted")
  await assertWorkerSkillsUnchanged(guidance.skills)
  await fs.writeFile(path.join(trusted, "helper.js"), "changed after resolution")
  await assert.rejects(assertWorkerSkillsUnchanged(guidance.skills), /contents changed after catalog resolution/)
  await fs.rm(path.join(trusted, "helper.js"))
  const approvals = [
    { source: `worktree:${args.workspaceSource}`, name: "review", sha256: await skillDigest(untrusted) },
    { source: `reference:Ref:${reference}`, name: "reference", sha256: await skillDigest(ref) },
  ]
  guidance = await readWorkerGuidance({ ...args, approvals })
  assert.deepEqual(guidance.skills.map(s => s.name), ["enghub", "paperclip", "reference", "review"])
  await fs.writeFile(path.join(untrusted, "helper.js"), "changed")
  guidance = await readWorkerGuidance({ ...args, approvals })
  assert.deepEqual(guidance.skills.map(s => s.name), ["enghub", "paperclip", "reference"])
  guidance = await readWorkerGuidance({ ...args, approvals: [{ ...approvals[1], source: `reference:Ref:${workspace}` }] })
  assert.deepEqual(guidance.skills.map(s => s.name), ["enghub", "paperclip"])
})

test("bundle approval binds archive and skill contents; duplicate shared names fail", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-bundle-trust-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const shared = path.join(root, "shared"), workspace = path.join(root, "workspace"), bundle = path.join(root, "bundle")
  await fs.mkdir(shared); await fs.mkdir(workspace); await fs.mkdir(bundle)
  const dir = path.join(bundle, "paperclip"); await fs.mkdir(dir); await fs.writeFile(path.join(dir, "SKILL.md"), "bundle")
  const sha256 = "a".repeat(64)
  const args = { workspace, workerShared: shared, bundle: { directory: bundle, entries: ["paperclip/SKILL.md"], sha256 } }
  assert.equal((await readWorkerGuidance(args)).paperclipInstructions, null)
  const approvals = [{ source: `bundle:${sha256}`, name: "paperclip", sha256: await skillDigest(dir) }]
  assert.equal((await readWorkerGuidance({ ...args, approvals })).paperclipInstructions, "bundle")
  assert.equal((await readWorkerGuidance({ ...args, bundle: { ...args.bundle, sha256: "b".repeat(64) }, approvals })).paperclipInstructions, null)
  await addSkill(shared, ".agents", "same")
  await addSkill(shared, ".github", "SAME")
  await assert.rejects(readWorkerGuidance(args), /Duplicate worker skill name/)
})

test("approval manifests are explicit, validated, and supervisory instructions remain mandatory", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-approvals-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file = path.join(root, "approvals.json")
  await fs.writeFile(file, JSON.stringify({ version: 1, approvals: [{ source: "bundle:" + "a".repeat(64), name: "paperclip", sha256: "b".repeat(64) }] }))
  assert.equal((await readSkillApprovals(file)).length, 1)
  await fs.writeFile(file, JSON.stringify({ version: 1, approvals: [{ source: "bundle", name: "paperclip", sha256: "b".repeat(64) }] }))
  await assert.rejects(readSkillApprovals(file), /Invalid skill approval/)
  const shared = path.join(root, "shared"), workspace = path.join(root, "workspace")
  await fs.mkdir(shared); await fs.mkdir(workspace)
  const repositories = [{ name: "Shared", path: shared, readOnly: true, supervisory: true }]
  await assert.rejects(readWorkerGuidance({ workspace, workerShared: shared, repositories }), /must provide AGENTS.md/)
  await fs.writeFile(path.join(shared, "AGENTS.md"), "shared")
  assert.equal((await readWorkerGuidance({ workspace, workerShared: shared, repositories })).sharedInstructions, "shared")
})

test("manifest validation rejects malformed sources, duplicates, missing files and writable locations", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "approval-boundaries-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, "workspace")
  await fs.mkdir(workspace)
  const file = path.join(root, "approval.json")
  const entry = { source: `worktree:${workspace}`, name: "review", sha256: "a".repeat(64) }
  for (const source of ["bundle:bad", "worktree:relative", "repository:Name:relative", `worktree:${workspace}${path.sep}..`, "reference::missing"]) {
    await fs.writeFile(file, JSON.stringify({ version: 1, approvals: [{ ...entry, source }] }))
    await assert.rejects(readSkillApprovals(file), /Invalid skill approval/)
  }
  await fs.writeFile(file, JSON.stringify({ version: 1, approvals: [entry, entry] }))
  await assert.rejects(readSkillApprovals(file), /Duplicate/)
  await assert.rejects(readSkillApprovals(path.join(root, "missing.json")), { code: "ENOENT" })
  await validateApprovalLocation(file, [workspace])
  const inside = path.join(workspace, "approval.json")
  await fs.writeFile(inside, "{}")
  await assert.rejects(validateApprovalLocation(inside, [workspace]), /outside all worker/)
})

test("repository approvals bind paths, shared precedence wins, and content additions revoke approval", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "repository-approval-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, "workspace"), shared = path.join(root, "shared"), repo = path.join(root, "repo")
  await fs.mkdir(workspace); await fs.mkdir(shared); await fs.mkdir(repo)
  const directory = await addSkill(repo, ".github", "review", "approved review")
  const args = { workspace, workerShared: shared, repositories: [{ name: "Main", path: repo }] }
  const approval = { source: `repository:Main:${repo}`, name: "review", sha256: await skillDigest(directory) }
  assert.equal((await readWorkerGuidance(args)).skills.length, 0)
  assert.equal((await readWorkerGuidance({ ...args, approvals: [approval] })).skills[0].source, "repository:Main")
  assert.equal((await readWorkerGuidance({ ...args, approvals: [{ ...approval, source: `repository:Other:${repo}` }] })).skills.length, 0)
  await addSkill(shared, ".agents", "review", "shared review")
  assert.equal((await readWorkerGuidance({ ...args, approvals: [approval] })).skills[0].source, "worker_shared")
  await fs.rm(path.join(shared, ".agents"), { recursive: true })
  await fs.mkdir(path.join(directory, "new-directory"))
  assert.equal((await readWorkerGuidance({ ...args, approvals: [approval] })).skills.length, 0)
})

test("linked skill helper directories are rejected, including trusted shared skills", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-links-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, "workspace"), shared = path.join(root, "shared"), target = path.join(root, "target")
  await fs.mkdir(workspace); await fs.mkdir(shared); await fs.mkdir(target)
  const directory = await addSkill(shared, ".github", "review")
  try { await fs.symlink(target, path.join(directory, "helpers"), process.platform === "win32" ? "junction" : "dir") }
  catch (error) { if (error.code === "EPERM") { t.skip("Link creation requires permission"); return } throw error }
  await assert.rejects(skillDigest(directory), /link/)
  await assert.rejects(readWorkerGuidance({ workspace, workerShared: shared }), /link/)
})
