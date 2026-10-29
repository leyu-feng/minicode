import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"

// Instruction-policy integrity check, not a sandbox or an atomic snapshot.
// Include helpers, references, directory names and executable mode bits.
export async function skillDigest(directory) {
  const hash = createHash("sha256")
  let count = 0, total = 0
  async function walk(current, relative) {
    const info = await fs.lstat(current)
    if (info.isSymbolicLink()) throw new Error("Skill contains a link")
    if (info.isDirectory()) {
      hash.update(`D${Buffer.byteLength(relative)}:${relative}:`)
      for (const entry of (await fs.readdir(current)).sort()) await walk(path.join(current, entry), relative ? `${relative}/${entry}` : entry)
    } else if (info.isFile()) {
      if (++count > 1024 || (total += info.size) > 16 * 1024 * 1024) throw new Error("Skill exceeds approval size limits")
      const bytes = await fs.readFile(current)
      const after = await fs.lstat(current)
      if (!after.isFile() || after.isSymbolicLink() || bytes.length !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ino !== info.ino || after.mode !== info.mode) throw new Error("Skill changed during hashing")
      hash.update(`F${Buffer.byteLength(relative)}:${relative}:${info.mode & 0o111}:${bytes.length}:`)
      hash.update(bytes)
    } else throw new Error("Skill contains a non-regular file")
  }
  if (!(await fs.lstat(directory)).isDirectory()) throw new Error("Skill must be a regular directory")
  await walk(directory, "")
  return hash.digest("hex")
}

export function validApprovalSource(source) {
  if (typeof source !== "string" || source.length > 4096 || /[\x00-\x1f\x7f]/.test(source)) return false
  if (source.startsWith("bundle:")) return /^bundle:[a-f0-9]{64}$/.test(source)
  let location
  if (source.startsWith("worktree:")) location = source.slice(9)
  else {
    const match = /^(repository|reference):([^:]+):(.+)$/.exec(source)
    if (!match) return false
    location = match[3]
  }
  return path.isAbsolute(location) && path.resolve(location) === location
}

// Operator-supplied only. ACL ownership cannot be portably inferred here.
export async function readSkillApprovals(file) {
  if (!file) return []
  if (!path.isAbsolute(file)) throw new Error("Skill approval file must be an absolute path")
  const info = await fs.lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) throw new Error("Invalid skill approval file")
  const data = JSON.parse(await fs.readFile(file, "utf8"))
  if (!data || Object.keys(data).sort().join(",") !== "approvals,version" || data.version !== 1 || !Array.isArray(data.approvals) || data.approvals.length > 1000) throw new Error("Invalid skill approval manifest")
  const seen = new Set()
  for (const a of data.approvals) {
    if (!a || typeof a !== "object" || Array.isArray(a) || Object.keys(a).sort().join(",") !== "name,sha256,source" || !validApprovalSource(a.source) || typeof a.name !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(a.name) || !/^[a-f0-9]{64}$/.test(a.sha256 ?? "")) throw new Error("Invalid skill approval entry")
    const key = JSON.stringify([a.source, a.name.toLowerCase()])
    if (seen.has(key)) throw new Error("Duplicate skill approval entry")
    seen.add(key)
  }
  return data.approvals
}

export async function validateApprovalLocation(file, roots) {
  if (!file) return
  const manifest = await fs.realpath(file)
  for (const root of roots.filter(Boolean)) {
    // Worktree storage can be created lazily. Resolve its existing ancestors
    // without creating directories or skipping containment checks.
    async function resolveRoot(location) {
      try { return await fs.realpath(location) }
      catch (error) {
        if (error.code !== "ENOENT" || path.dirname(location) === location) throw error
        return path.join(await resolveRoot(path.dirname(location)), path.basename(location))
      }
    }
    const realRoot = await resolveRoot(path.resolve(root))
    const relative = path.relative(realRoot, manifest)
    if (relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) throw new Error("Skill approval manifest must be outside all worker repositories and workspaces")
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== "digest") throw new Error("Usage: node skill-approvals.js digest <skill-directory>")
    console.log(await skillDigest(path.resolve(process.argv[3])))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
