import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { prepareWorkerGitSync } from "./worker-git-sync.js"
import { prepareWorkerWorktrees, siblingWorktreePath } from "./worker-worktree.js"

function inside(root, target) {
  const relative = path.relative(root, target)
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

async function exists(file) {
  try {
    await fs.lstat(file)
    return true
  } catch (error) {
    if (error.code !== "ENOENT") throw error
    return false
  }
}

export async function prepareWorkerWorkspace({
  root, workerId, workerName, server, git, log, minFreeGiB, targetFreeGiB, readFreeBytes,
}) {
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(workerId ?? "")
    || (workerName !== undefined && !/^[a-z0-9][a-z0-9_-]{0,23}$/i.test(workerName))) {
    throw new Error("Workspace mode requires a safe worker ID and short worker name")
  }
  root = await fs.realpath(root)
  if (await exists(path.join(root, ".git"))) throw new Error("Workspace mode requires a non-Git parent directory")
  const file = path.join(root, "workspace.json")
  if ((await fs.lstat(file)).isSymbolicLink()) throw new Error("workspace.json must not be a link")
  const text = await fs.readFile(file, "utf8")
  const config = JSON.parse(text)
  if (config?.version !== 1 || !Array.isArray(config.repositories) || !config.repositories.length
    || Object.keys(config).some(key => !["version", "repositories"].includes(key))) {
    throw new Error("workspace.json requires version 1 and a non-empty repositories list")
  }
  const names = new Set()
  for (const repo of config.repositories) {
    if (!repo || !/^[a-z][a-z0-9_-]{0,31}$/i.test(repo.id) || names.has(repo.id.toLowerCase())
      || !["clone", "worktree"].includes(repo.checkout) || typeof repo.branch !== "string" || !repo.branch
      || (repo.supervisory !== undefined && typeof repo.supervisory !== "boolean")
      || (repo.readOnly !== undefined && typeof repo.readOnly !== "boolean")
      || Object.keys(repo).some(key => !["id", "source", "checkout", "branch", "supervisory", "readOnly"].includes(key))) {
      throw new Error("Invalid or duplicate workspace repository; require id, source, checkout: clone or worktree, and branch")
    }
    names.add(repo.id.toLowerCase())
    const url = new URL(repo.source)
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new Error("Workspace repository sources must be HTTPS URLs without credentials")
    }
    await git(root, ["check-ref-format", `refs/heads/${repo.branch}`])
  }
  if (config.repositories.filter(repo => repo.supervisory === true).length !== 1) {
    throw new Error("workspace.json requires exactly one supervisory repository")
  }
  const storage = path.join(root, ".workers", workerId)
  const canonicalStorage = await fs.realpath(root)
  if (canonicalStorage !== root) throw new Error("Workspace root changed")
  // Resolve each ancestor before creating worker-owned metadata; never adopt linked storage.
  for (const directory of [path.dirname(storage), storage]) {
    if (await exists(directory) && await fs.realpath(directory) !== directory) {
      throw new Error("Worker workspace storage must not contain directory links")
    }
  }
  await fs.mkdir(storage, { recursive: true })
  const ownership = JSON.stringify({ version: 1, root, workerId, workerName, server })
  const ownerFile = path.join(storage, "owner.json")
  if (await exists(ownerFile)) {
    if (await fs.realpath(ownerFile) !== ownerFile || await fs.readFile(ownerFile, "utf8") !== ownership) {
      throw new Error("Workspace storage belongs to a different worker, root, server or name")
    }
  } else await fs.writeFile(ownerFile, ownership, { flag: "wx", mode: 0o600 })
  const repositories = []
  for (const repo of config.repositories) {
    let source = path.join(root, repo.id)
    if (!await exists(source)) {
      const temporary = await fs.mkdtemp(path.join(root, `.${repo.id}-clone-`))
      try {
        await git(root, ["clone", "--branch", repo.branch, "--single-branch", "--", repo.source, temporary])
        await fs.rename(temporary, source)
      } catch (error) {
        await fs.rm(temporary, { recursive: true, force: true })
        throw new Error(`Could not clone workspace repository '${repo.id}'; check repository access`, { cause: error })
      }
    } else if (await git(source, ["rev-parse", "--is-bare-repository"]) === "true") {
      source = path.join(source, repo.branch)
    }
    if (await fs.realpath(source) !== source) throw new Error("Workspace source must not contain directory links")
    if (!inside(root, source) || source === root
      || await fs.realpath(await git(source, ["rev-parse", "--show-toplevel"])) !== source
      || await git(source, ["remote", "get-url", "origin"]) !== repo.source
      || repositories.some(entry => inside(entry.source, source) || inside(source, entry.source))) {
      throw new Error(`Workspace repository '${repo.id}' does not match its configured local source`)
    }
    const readOnly = repo.supervisory === true || repo.readOnly === true
    const entry = { ...repo, sourceUrl: repo.source, source, readOnly }
    if (!readOnly) {
      const prefix = `${(workerName ?? `w-${workerId.slice(0, 8)}`).slice(0, 17)}-${createHash("sha256").update(`${workerId}\n${repo.id}`).digest("hex").slice(0, 6)}`
      const workspace = siblingWorktreePath(source, prefix)
      if (!inside(root, workspace)) throw new Error("Repository worktrees must stay inside the workspace root")
      entry.sync = await prepareWorkerGitSync({
        source, sourceBranch: repo.branch, references: [], workerId, git,
        validate: async () => {
          if (await fs.realpath(source) !== source) throw new Error("Workspace source path changed")
        },
        log: message => log(`[minicode] ${repo.id}: ${message}`),
      })
      entry.worktrees = await prepareWorkerWorktrees({
        source, workspace, workerId, server, git, log, minFreeGiB, targetFreeGiB, readFreeBytes,
        validateWorkspace: directory => {
          if (!inside(root, directory) || inside(storage, directory)
            || config.repositories.some(other => inside(path.join(root, other.id), directory)
              && other.id !== repo.id)
            || inside(source, directory) || inside(directory, source)) {
            throw new Error("Repository worktree overlaps protected workspace storage or sources")
          }
        },
      })
    }
    repositories.push(entry)
  }
  const workerShared = repositories.find(repo => repo.supervisory).source
  if (!await exists(path.join(workerShared, "AGENTS.md"))) throw new Error("Supervisory repository requires AGENTS.md")
  const managers = repositories.flatMap(repo => repo.worktrees ? [repo.worktrees] : [])
  return {
    workerShared,
    release() { for (const manager of managers) manager.release() },
    async checkDisk() { for (const manager of managers) await manager.checkDisk() },
    async ensureDiskSpace() { for (const manager of managers) await manager.ensureDiskSpace() },
    async prepare(agentId, runId, { signal } = {}) {
      if (!/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(runId)) throw new Error("Invalid workspace run ID")
      if (await fs.realpath(root) !== root || (await fs.lstat(file)).isSymbolicLink()
        || await fs.readFile(file, "utf8") !== text) {
        throw new Error("workspace.json or its root changed; restart the worker")
      }
      const manifest = []
      for (const repo of repositories) {
        signal?.throwIfAborted()
        if (await fs.realpath(repo.source) !== repo.source
          || await git(repo.source, ["remote", "get-url", "origin"], { signal }) !== repo.sourceUrl) {
          throw new Error(`Workspace repository '${repo.id}' identity changed`)
        }
        const refreshed = repo.sync ? await repo.sync.prepare({ signal }) : null
        const directory = repo.worktrees
          ? await repo.worktrees.assign(agentId, { commit: refreshed.primaryCommit }) : repo.source
        manifest.push({ name: repo.id, source: repo.sourceUrl, path: directory, branch: repo.branch,
          commit: await git(directory, ["rev-parse", "--verify", "HEAD^{commit}"], { signal }),
          readOnly: repo.readOnly, supervisory: repo.supervisory === true })
      }
      const artifacts = path.join(storage, runId)
      for (const directory of [path.dirname(storage), storage, artifacts, path.join(artifacts, "reviews")]) {
        if (await exists(directory) && await fs.realpath(directory) !== directory) {
          throw new Error("Worker run storage must not contain directory links")
        }
      }
      await fs.mkdir(path.join(artifacts, "reviews"), { recursive: true })
      const manifestPath = path.join(artifacts, "workspace.json")
      if (await exists(manifestPath) && ((await fs.lstat(manifestPath)).isSymbolicLink()
        || !(await fs.lstat(manifestPath)).isFile())) {
        throw new Error("Worker run manifest must be a regular file")
      }
      await fs.writeFile(manifestPath, JSON.stringify({ version: 1, repositories: manifest }, null, 2))
      return { repositories: manifest, artifacts, manifestPath, reviews: path.join(artifacts, "reviews"),
        publicationStorage: path.join(storage, "publications") }
    },
  }
}
