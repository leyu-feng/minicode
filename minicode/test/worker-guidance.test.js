import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { readWorkerGuidance } from "../server/worker-guidance.js"

test("worker_shared overrides catalog skills; duplicate writable skills stay scoped; reference skills are ignored", async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "catalog-guidance-"))
  t.after(() => fs.rm(workspace, { recursive: true, force: true }))
  const workerShared = path.join(workspace, "worker_shared")
  const repositories = ["First", "Second", "Reference"].map(name => ({ name, path: path.join(workspace, name), readOnly: name === "Reference" }))
  async function skill(root, name, content) {
    const directory = path.join(root, ".agents", "skills", name)
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(directory, "SKILL.md"), content)
  }
  await skill(workerShared, "paperclip", "Shared instructions")
  for (const repository of repositories) {
    await skill(repository.path, "paperclip", "Overridden")
    await skill(repository.path, "review", "Repository review")
  }
  await skill(repositories[0].path, "unique", "Unique skill")
  await skill(repositories[2].path, "reference-only", "Must not load")
  const guidance = await readWorkerGuidance({ workspace, workerShared, repositories })
  assert.equal(guidance.paperclipInstructions, "Shared instructions")
  assert.deepEqual(guidance.skills.map(skill => skill.name), ["First/review", "paperclip", "Second/review", "unique"])
  assert.equal(guidance.skills.find(skill => skill.name === "paperclip").source, "worker_shared")
})
