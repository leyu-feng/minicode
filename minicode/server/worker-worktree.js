import fs from "node:fs/promises"
import path from "node:path"

const GIB = 1024 ** 3

async function availableDiskBytes(source) {
  const stats = await fs.statfs(source)
  return stats.bavail * stats.bsize
}

export function siblingWorktreePath(source, name) {
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9_-]{0,23}$/i.test(name)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) {
    throw new Error("--worker-name must be a safe folder name of 1-24 letters, digits, hyphens or underscores")
  }
  const workspace = path.join(path.dirname(source), name)
  if (path.relative(source, workspace) === "") throw new Error("Worker worktree must not be the source checkout")
  return workspace
}

export async function prepareWorkerWorktrees({
  source, workspace: prefix, workerId, server, git, validateWorkspace,
  minFreeGiB = 24, targetFreeGiB = 36, readFreeBytes = availableDiskBytes, log,
}) {
  if (!Number.isFinite(minFreeGiB) || minFreeGiB <= 0
    || !Number.isFinite(targetFreeGiB) || targetFreeGiB <= minFreeGiB) {
    throw new Error("Worker disk thresholds require 0 < --min-free-gib < --target-free-gib")
  }
  const minimum = minFreeGiB * GIB
  const target = targetFreeGiB * GIB
  siblingWorktreePath(source, `${path.basename(prefix)}a1`)
  const common = await fs.realpath(await git(source, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))
  if (!/^[a-f0-9-]{36}$/.test(workerId)) throw new Error("Invalid worker id for worktree registry")
  const file = path.join(common, `minicode-worker-${workerId}.json`)
  let registry
  try {
    const info = await fs.lstat(file)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid worker worktree registry")
    registry = JSON.parse(await fs.readFile(file, "utf8"))
  } catch (error) {
    if (error.code !== "ENOENT") throw error
    registry = { version: 1, source, prefix, workerId, server, agents: [], lastUsed: [] }
    await fs.writeFile(file, JSON.stringify(registry), { flag: "wx", mode: 0o600 })
  }
  if (registry?.version !== 1 || registry.source !== source || registry.prefix !== prefix
    || registry.workerId !== workerId || registry.server !== server || !Array.isArray(registry.agents)
    || registry.agents.some(id => typeof id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(id))
    || new Set(registry.agents).size !== registry.agents.length) {
    throw new Error("Worker worktree registry belongs to a different worker, source, server or name")
  }
  registry.lastUsed ??= registry.agents.map(() => 0)
  if (!Array.isArray(registry.lastUsed) || registry.lastUsed.length !== registry.agents.length
    || registry.lastUsed.some(time => !Number.isSafeInteger(time) || time < 0)) {
    throw new Error("Invalid worker worktree LRU timestamps")
  }
  let activeWorkspace = null
  let assigning = false
  let sweep = null
  let reclaiming = false
  let reportedState = null
  const workspaceFor = index => siblingWorktreePath(source, `${path.basename(prefix)}a${index + 1}`)
  const report = (state, message) => {
    if (reportedState !== state) log(`[minicode] ${message}`)
    reportedState = state
  }
  const freeBytes = async () => {
    const bytes = await readFreeBytes(source)
    if (!Number.isFinite(bytes) || bytes < 0) throw new Error("Could not measure available worktree disk space")
    return bytes
  }
  async function reclaimDisk() {
    let free = await freeBytes()
    if (free < minimum && !reclaiming) {
      reclaiming = true
      log(`[minicode] Low disk space: ${(free / GIB).toFixed(2)} GiB free; reclaiming idle worktrees toward ${targetFreeGiB} GiB`)
    }
    if (reclaiming) {
      const candidates = registry.agents.map((agentId, index) => ({
        agentId, workspace: workspaceFor(index), lastUsed: registry.lastUsed[index],
      })).sort((a, b) => a.lastUsed - b.lastUsed)
      for (const candidate of candidates) {
        if (free >= target) break
        if (candidate.workspace === activeWorkspace) continue
        validateWorkspace(candidate.workspace)
        const worktree = await prepareWorkerWorktree({
          source, workspace: candidate.workspace, workerId, server, git, create: false,
        })
        if (!worktree || candidate.workspace === activeWorkspace) continue
        free = await freeBytes()
        if (free >= target) break
        await worktree.remove(candidate.agentId)
        free = await freeBytes()
        log(`[minicode] LRU evicted idle worktree ${candidate.workspace}; ${(free / GIB).toFixed(2)} GiB free`)
      }
      if (free >= target) reclaiming = false
    }
    report(free < minimum ? "blocked" : reclaiming ? "recovering" : "healthy",
      `Disk space: ${(free / GIB).toFixed(2)} GiB free (minimum ${minFreeGiB}, target ${targetFreeGiB} GiB)`
      + (free < minimum ? "; no eligible idle worktrees remain; new assignments are blocked" : ""))
    return free
  }
  function checkDisk() {
    if (!sweep) sweep = reclaimDisk().finally(() => { sweep = null })
    return sweep
  }
  async function ensureDiskSpace() {
    const free = await checkDisk()
    if (free < minimum) {
      throw new Error(`Insufficient worktree disk space: ${(free / GIB).toFixed(2)} GiB free; require at least ${minFreeGiB} GiB. No eligible idle worktrees can restore the minimum; new model work is blocked.`)
    }
  }
  return {
    checkDisk,
    ensureDiskSpace,
    release() { activeWorkspace = null },
    async assign(agentId) {
      if (typeof agentId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(agentId)) {
        throw new Error("AgentPool task requires a valid agent id for its workspace")
      }
      if (assigning || activeWorkspace) throw new Error("Worker worktree is already in use by an assignment")
      assigning = true
      try {
        let index = registry.agents.indexOf(agentId)
        if (index < 0) index = registry.agents.length
        const workspace = workspaceFor(index)
        validateWorkspace(workspace)
        // Preflight may evict this agent's previous idle checkout before it is reserved.
        await ensureDiskSpace()
        activeWorkspace = workspace
        const agents = index === registry.agents.length ? [...registry.agents, agentId] : registry.agents
        const lastUsed = [...registry.lastUsed]
        lastUsed[index] = Date.now()
        const next = { ...registry, agents, lastUsed }
        const temporary = `${file}.pending`
        await fs.writeFile(temporary, JSON.stringify(next), { flag: "wx", mode: 0o600 })
        await fs.rename(temporary, file)
        registry = next
        const worktree = await prepareWorkerWorktree({ source, workspace, workerId, server, git })
        await worktree.assign(agentId)
        await ensureDiskSpace()
        return workspace
      } finally {
        assigning = false
      }
    },
  }
}

async function prepareWorkerWorktree({ source, workspace, workerId, server, git, create = true }) {
  let existing
  try {
    existing = await fs.lstat(workspace)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()
      || !(await fs.lstat(path.join(workspace, ".git"))).isFile()
      || await fs.realpath(await git(workspace, ["rev-parse", "--show-toplevel"])) !== workspace) {
      throw new Error(`Worker worktree is not a linked Git checkout: ${workspace}`)
    }
  } else {
    if (!create) return null
    await git(source, ["worktree", "add", "--detach", "--", workspace, "HEAD"])
  }
  const common = async cwd => fs.realpath(await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))
  if (await common(source) !== await common(workspace)) {
    throw new Error("Worker worktree belongs to a different source repository")
  }
  await git(workspace, ["rev-parse", "--verify", "HEAD"])
  const gitDirectory = await fs.realpath(await git(workspace, ["rev-parse", "--absolute-git-dir"]))
  const file = path.join(gitDirectory, "minicode-worker.json")
  let binding
  if (!existing) {
    binding = { version: 1, source, workspace, workerId, server, agentId: null }
    await fs.writeFile(file, JSON.stringify(binding), { flag: "wx", mode: 0o600 })
  } else {
    const info = await fs.lstat(file)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid worker worktree binding file")
    binding = JSON.parse(await fs.readFile(file, "utf8"))
  }
  if (binding.version !== 1 || binding.source !== source || binding.workspace !== workspace
    || binding.workerId !== workerId || binding.server !== server
    || !(binding.agentId === null || typeof binding.agentId === "string" && binding.agentId.length > 0)) {
    throw new Error("Worker worktree belongs to a different worker, source or server; choose another --worker-name")
  }
  return {
    async remove(agentId) {
      if (binding.agentId !== agentId) throw new Error("Worktree belongs to a different agent; refusing LRU eviction")
      await git(source, ["worktree", "remove", "--force", "--", workspace])
    },
    async assign(agentId) {
      if (typeof agentId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(agentId)) {
        throw new Error("AgentPool task requires a valid agent id for its workspace")
      }
      if (binding.agentId !== null && binding.agentId !== agentId) {
        throw new Error("Worker-agent worktree is bound to a different agent; refusing to reset it")
      }
      if (binding.agentId === null) {
        const next = { ...binding, agentId }
        const temporary = `${file}.pending`
        await fs.writeFile(temporary, JSON.stringify(next), { flag: "wx", mode: 0o600 })
        await fs.rename(temporary, file)
        binding = next
      }
      const commit = await git(source, ["rev-parse", "--verify", "HEAD^{commit}"])
      await git(workspace, ["checkout", "--detach", "--force", commit])
      await git(workspace, ["reset", "--hard", commit])
      await git(workspace, ["clean", "-ffdx"])
      return workspace
    },
  }
}
