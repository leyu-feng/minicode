import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { unzipSync } from "fflate"

export const SKILL_BUNDLE = "skill_bundle_v1"
const MAX_ZIP = 4 * 1024 * 1024
const MAX_FILES = 256
const MAX_CONTENT = 8 * 1024 * 1024
const digest = bytes => createHash("sha256").update(bytes).digest("hex")

async function existing(file, directory = false) {
  try {
    const info = await fs.lstat(file)
    if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile())) {
      throw new Error(`Worker skill cache must not contain links or unexpected file types: ${file}`)
    }
    return info
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }
}

export async function prepareWorkerSkills({ workspace, skills, apiUrl, authToken, runId, signal, git }) {
  if (skills == null) return null
  if (skills.version !== 1 || !/^[a-f0-9]{64}$/.test(skills.sha256 ?? "")
    || skills.url !== `/api/agent-pool/skills/${skills.sha256}.zip`
    || !Array.isArray(skills.files) || !skills.files.length || skills.files.length > MAX_FILES) {
    throw new Error("Invalid Paperclip skill bundle manifest")
  }
  const names = new Set()
  for (const file of skills.files) {
    if (typeof file.path !== "string" || file.path.length > 240 || /[\\:\x00-\x1f]/.test(file.path)
      || !file.path.split("/").every(part => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git"
        && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part))
      || names.has(file.path.toLowerCase()) || !/^[a-f0-9]{64}$/.test(file.sha256 ?? "")) {
      throw new Error("Invalid or duplicate Paperclip skill file")
    }
    names.add(file.path.toLowerCase())
  }
  if (!names.has("paperclip/skill.md")) throw new Error("Skill bundle is missing paperclip/SKILL.md")
  signal?.throwIfAborted()
  if (await git(["ls-files", "--", ":(icase).worker"])) throw new Error("Reserved .worker cache must not contain tracked files")
  const cache = path.join(workspace, ".worker")
  if (!await existing(cache, true)) await fs.mkdir(cache)
  const info = path.join(workspace, ".git", "info")
  if (!await existing(info, true)) await fs.mkdir(info)
  const exclude = path.join(info, "exclude")
  if (await existing(exclude)) {
    const text = await fs.readFile(exclude, "utf8")
    if (!text.split(/\r?\n/).includes("/.worker/")) await fs.appendFile(exclude, "\n/.worker/\n")
  } else await fs.writeFile(exclude, "/.worker/\n", { flag: "wx" })
  const zipFile = path.join(cache, "skills.zip")
  const zipInfo = await existing(zipFile)
  let archive = zipInfo && zipInfo.size <= MAX_ZIP ? await fs.readFile(zipFile) : null
  let downloaded = false
  if (!archive || digest(archive) !== skills.sha256) {
    if (typeof authToken !== "string" || !authToken) throw new Error("Skill download requires a run-scoped Paperclip credential")
    const response = await fetch(new URL(skills.url, apiUrl), {
      headers: { Authorization: `Bearer ${authToken}`, "X-Paperclip-Run-Id": runId },
      redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]),
    })
    if (!response.ok || !response.body) throw new Error(`Paperclip skill download failed: HTTP ${response.status}`)
    const chunks = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > MAX_ZIP) throw new Error("Paperclip skill ZIP exceeds 4 MiB")
      chunks.push(chunk)
    }
    archive = Buffer.concat(chunks)
    if (digest(archive) !== skills.sha256) throw new Error("Paperclip skill ZIP SHA-256 mismatch; model execution was not started")
    downloaded = true
  }
  let total = 0, count = 0
  const files = unzipSync(archive, { filter(file) {
    total += file.originalSize
    if (++count > MAX_FILES || total > MAX_CONTENT) throw new Error("Paperclip skill ZIP exceeds its extraction limits")
    return true
  } })
  if (count !== skills.files.length || Object.keys(files).length !== skills.files.length
    || skills.files.some(file => !Object.hasOwn(files, file.path) || digest(files[file.path]) !== file.sha256)) {
    throw new Error("Paperclip skill contents do not match the assignment manifest")
  }
  signal?.throwIfAborted()
  const directory = path.join(cache, "skills")
  await existing(directory, true)
  const temporary = await fs.mkdtemp(path.join(cache, "skills-preparing-"))
  try {
    for (const file of skills.files) {
      const destination = path.join(temporary, ...file.path.split("/"))
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.writeFile(destination, files[file.path], { flag: "wx" })
    }
    signal?.throwIfAborted()
    await fs.rm(directory, { recursive: true, force: true })
    await fs.rename(temporary, directory)
    if (downloaded) await fs.writeFile(zipFile, archive)
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
  return {
    directory, sha256: skills.sha256, downloaded,
    entries: skills.files.filter(file => /^[^/]+\/SKILL\.md$/.test(file.path)).map(file => file.path),
    instructions: await fs.readFile(path.join(directory, "paperclip", "SKILL.md"), "utf8"),
  }
}
