import fs from "node:fs/promises"
import path from "node:path"
import { skillDigest } from "./skill-approvals.js"

async function optionalEntry(file, directory = false) {
  try {
    const info = await fs.lstat(file)
    if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile())) {
      throw new Error(`${file} must be a regular ${directory ? "directory" : "file"}, not a link or unexpected file type`)
    }
    return info
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }
}

async function readInstructions(root) {
  const file = path.join(root, "AGENTS.md")
  return await optionalEntry(file) ? fs.readFile(file, "utf8") : null
}

async function discoverSkills(root, source) {
  const skills = []
  const names = new Set()
  for (const folder of [".agents", ".github"]) {
    const parent = path.join(root, folder)
    if (!await optionalEntry(parent, true)) continue
    const directory = path.join(parent, "skills")
    if (!await optionalEntry(directory, true)) continue
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isFile()) continue
      const location = path.join(directory, entry.name)
      await optionalEntry(location, true)
      const file = path.join(location, "SKILL.md")
      if (!await optionalEntry(file)) continue
      const name = entry.name.toLowerCase()
      if (names.has(name)) throw new Error(`Duplicate worker skill name in ${source}: ${entry.name}`)
      names.add(name)
      skills.push({ name: entry.name, file, source })
    }
  }
  return skills
}

export async function readWorkerGuidance({ workspace, workerShared, workspaceSource, bundle, repositories = [], references = [], approvals = [] }) {
  const supervisory = repositories.filter(repo => repo.supervisory === true)
  if (supervisory.length > 1 || supervisory.some(repo => !repo.readOnly || path.resolve(repo.path) !== path.resolve(workerShared))) {
    throw new Error("The supervisory repository must be the single read-only worker_shared checkout")
  }
  const sharedInstructions = await readInstructions(workerShared)
  if (supervisory.length && sharedInstructions === null) {
    throw new Error(`The supervisory repository must provide AGENTS.md: ${path.join(workerShared, "AGENTS.md")}`)
  }
  const sharedSkills = await discoverSkills(workerShared, "worker_shared")
  // Reject linked helpers in trusted skills as well as approved skills.
  for (const skill of sharedSkills) skill.sha256 = await skillDigest(path.dirname(skill.file))
  const [workspaceInstructions, workspaceSkills] = await Promise.all([
    readInstructions(workspace), discoverSkills(workspace, "worktree"),
  ])
  const repositorySkills = await Promise.all([
    ...repositories.filter(repo => !repo.supervisory).map(async repo => ({ repository: repo.name, approvalSource: `repository:${repo.name}:${path.resolve(repo.path)}`, skills: await discoverSkills(repo.path, `repository:${repo.name}`) })),
    ...references.map(async repo => ({ repository: repo.name, approvalSource: `reference:${repo.name}:${path.resolve(repo.path)}`, skills: await discoverSkills(repo.path, `reference:${repo.name}`) })),
  ])
  const candidates = [
    ...(bundle?.entries ?? []).map(entry => ({ name: entry.split("/")[0], file: path.join(bundle.directory, ...entry.split("/")), source: "bundle" })),
    ...workspaceSkills,
    ...repositorySkills.flatMap(group => group.skills.map(skill => ({ ...skill, repository: group.repository, approvalSource: group.approvalSource }))),
  ]
  const approved = []
  for (const skill of candidates) {
    let approvalSource
    if (skill.source === "bundle" && /^[a-f0-9]{64}$/.test(bundle?.sha256 ?? "")) approvalSource = `bundle:${bundle.sha256}`
    else if (skill.source === "worktree" && workspaceSource) approvalSource = `worktree:${path.resolve(workspaceSource)}`
    else if (skill.repository) approvalSource = skill.approvalSource
    const possible = approvals.filter(a => a.source === approvalSource && a.name === skill.name)
    if (!possible.length) continue
    const digest = await skillDigest(path.dirname(skill.file))
    if (possible.some(a => a.sha256 === digest)) approved.push({ ...skill, approvalSource, sha256: digest })
  }
  const grouped = new Map()
  for (const skill of approved.filter(skill => skill.repository)) {
    const name = skill.name.toLowerCase()
    const entries = grouped.get(name) ?? []
    entries.push(skill)
    grouped.set(name, entries)
  }
  const catalogSkills = [...grouped.values()].flatMap(entries => entries.length === 1 ? entries : entries.map(skill => ({ ...skill, name: `${skill.repository}/${skill.name}` })))
  const selected = new Map()
  for (const [source, skills] of [
    ["bundle", approved.filter(skill => skill.source === "bundle")],
    ["worktree", approved.filter(skill => skill.source === "worktree")],
    ["repositories", catalogSkills],
    ["worker_shared", sharedSkills],
  ]) {
    const names = new Set()
    for (const skill of skills) {
      const name = skill.name.toLowerCase()
      if (names.has(name)) throw new Error(`Duplicate worker skill name in ${source}: ${skill.name}`)
      names.add(name)
      selected.set(name, skill)
    }
  }
  const skills = [...selected.values()].sort((a, b) => a.name.localeCompare(b.name))
  const paperclip = selected.get("paperclip")
  // Check both sides of the inline read; this is best-effort, not an atomic snapshot.
  if (paperclip) await assertWorkerSkillsUnchanged([paperclip])
  const paperclipInstructions = paperclip ? await fs.readFile(paperclip.file, "utf8") : null
  await assertWorkerSkillsUnchanged(skills)
  return { workspaceInstructions, sharedInstructions, skills, paperclipInstructions }
}

export async function assertWorkerSkillsUnchanged(skills) {
  for (const skill of skills) {
    if (await skillDigest(path.dirname(skill.file)) !== skill.sha256) {
      throw new Error(`Worker skill contents changed after catalog resolution: ${skill.name}; renewed operator review required`)
    }
  }
}
