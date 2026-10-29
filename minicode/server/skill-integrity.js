import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"

// Detect changes across a complete skill directory, including helpers and references.
// This is integrity checking, not a sandbox or an atomic filesystem snapshot.
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
      if (++count > 1024 || (total += info.size) > 16 * 1024 * 1024) throw new Error("Skill exceeds integrity-check size limits")
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
