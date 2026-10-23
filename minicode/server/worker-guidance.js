import fs from "node:fs/promises"
import path from "node:path"

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
  const agents = path.join(root, ".agents")
  if (!await optionalEntry(agents, true)) return []
  const directory = path.join(agents, "skills")
  if (!await optionalEntry(directory, true)) return []
  const skills = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isFile()) continue
    const location = path.join(directory, entry.name)
    await optionalEntry(location, true)
    const file = path.join(location, "SKILL.md")
    if (await optionalEntry(file)) skills.push({ name: entry.name, file, source })
  }
  return skills
}

export async function readWorkerGuidance({ workspace, workerShared, bundle, repositories = [] }) {
  const [workspaceInstructions, sharedInstructions, workspaceSkills, sharedSkills] = await Promise.all([
    readInstructions(workspace), readInstructions(workerShared),
    discoverSkills(workspace, "worktree"), discoverSkills(workerShared, "worker_shared"),
  ])
  const selected = new Map()
  const repositorySkills = await Promise.all(repositories.filter(repo => !repo.readOnly).map(async repo => ({
    repository: repo.name, skills: await discoverSkills(repo.path, `repository:${repo.name}`),
  })))
  const grouped = new Map()
  for (const { repository, skills } of repositorySkills) for (const skill of skills) {
    const name = skill.name.toLowerCase()
    const entries = grouped.get(name) ?? []
    entries.push({ ...skill, repository })
    grouped.set(name, entries)
  }
  const sharedNames = new Set(sharedSkills.map(skill => skill.name.toLowerCase()))
  const catalogSkills = [...grouped.entries()].flatMap(([name, entries]) => sharedNames.has(name) ? []
    : entries.length === 1 ? entries : entries.map(skill => ({ ...skill, name: `${skill.repository}/${skill.name}` })))
  for (const [source, skills] of [
    ["bundle", (bundle?.entries ?? []).map(entry => ({
      name: entry.split("/")[0], file: path.join(bundle.directory, ...entry.split("/")), source: "bundle",
    }))],
    ["worktree", workspaceSkills],
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
  return {
    workspaceInstructions, sharedInstructions, skills,
    paperclipInstructions: paperclip ? await fs.readFile(paperclip.file, "utf8") : null,
  }
}
