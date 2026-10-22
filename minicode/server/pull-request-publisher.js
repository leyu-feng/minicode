import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { stripVTControlCharacters } from "node:util"
import { killTree } from "./kill-tree.js"

function refConflict(error) {
  return error.refConflict === true || /^!\t[^\r\n]*\t\[rejected\] \((?:stale info|already exists)\)\r?$/m.test(error.stdout ?? "")
}

export function publicationCommand(file, args, { cwd, env, signal } = {}) {
  signal?.throwIfAborted()
  const label = `${file} ${args[0]}`
  return new Promise((resolve, reject) => {
    let timedOut = false
    const child = execFile(file, args, {
      cwd, env, windowsHide: true, detached: process.platform !== "win32", maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      if (signal?.aborted) { reject(new Error("Publication cancelled; retry the same commit to reconcile remote state")); return }
      if (error) {
        const failure = new Error(`${label} failed${timedOut ? " (timed out)" : ""}: ${stripVTControlCharacters(stderr || error.message).trim().slice(0, 2000)}`)
        failure.refConflict = refConflict({ stdout })
        reject(failure)
        return
      }
      resolve(stdout.trim())
    })
    const abort = () => killTree(child.pid)
    const timer = setTimeout(() => { timedOut = true; abort() }, 120_000)
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
  })
}

export function publicationEnvironment() {
  const env = { ...process.env, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never", NO_COLOR: "1" }
  for (const key of Object.keys(env)) {
    if (/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|AZURE_DEVOPS_EXT_PAT|FORCE_COLOR|CLICOLOR_FORCE|GIT_CONFIG.*|GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES)$/i.test(key)) delete env[key]
  }
  return env
}

export function publicationBranch(alias, agentName, title) {
  const slug = value => String(value).normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64).replace(/-$/, "")
  const agent = slug(agentName), feature = slug(title)
  if (!agent || !feature) throw new Error("PR branch naming requires an agent name and title containing letters or numbers")
  return `users/${alias}/${agent}/${feature}`
}

export function validatePublicationInput(input, agentId) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some(key => !["commit", "title", "body"].includes(key))
    || typeof input.commit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.commit)
    || typeof input.title !== "string" || !input.title.trim() || input.title.length > 200
    || /[\r\n\0]/.test(input.title) || typeof input.body !== "string" || !input.body.trim()
    || input.body.length > 8000 || input.body.includes("\0")
    || !/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(agentId)) {
    throw new Error("publish_pull_request requires a full commit hash, title (1-200 characters), and body (1-8000 characters); no repository or branch overrides")
  }
}

export function pullRequestTool({ repoRoot, workspace, agentId, description, url, env, run, prepare,
  branchForTitle, branchForCommit = commit => `minicode/${agentId}/${commit}` }) {
  const local = (args, options = {}) => run("git", args, { cwd: repoRoot, env, ...options })
  const publications = new Map()
  return {
    name: "publish_pull_request",
    description,
    parameters: {
      type: "object", additionalProperties: false, required: ["commit", "title", "body"],
      properties: {
        commit: { type: "string", description: "Full committed revision from your assigned checkout; uncommitted files are never published." },
        title: { type: "string", maxLength: 200 },
        body: { type: "string", maxLength: 8000, description: "PR description including validation evidence and approval requirements." },
      },
    },
    async execute(input, { signal, publication } = {}) {
      validatePublicationInput(input, agentId)
      const { commit, title, body } = input
      signal?.throwIfAborted()
      let saved = publication ? publication.existing ?? publication.allocation : publications.get(commit)
      const { authEnv = env, credentials = [], findPr, createPr, target, ...identity } = await prepare({ commit, title, body, signal, saved })
      const find = async (branch, number) => {
        await local(["check-ref-format", `refs/heads/${branch}`], { signal })
        return findPr(branch, number)
      }
      const reuse = receipt => {
        if (receipt.commit !== commit) throw new Error("Existing PR source commit does not match the original publication")
        publications.set(commit, receipt)
        return { ...receipt, reused: true, worktreeRemoved: true }
      }
      if (saved) {
        const existing = await find(saved.branch, saved.number)
        if (existing) return reuse(existing)
        if (saved.number) throw new Error("Saved PR could not be verified; no replacement PR will be created")
      } else {
        const legacy = await find(branchForCommit(commit))
        if (legacy) return reuse(legacy)
      }
      await local(["cat-file", "-e", `${commit}^{commit}`], { cwd: workspace, signal })
      await local(["merge-base", "--is-ancestor", commit, "HEAD"], { cwd: workspace, signal })
      const remoteHead = async branch => {
        const remote = await local([...credentials, "ls-remote", "--heads", url, `refs/heads/${branch}`], { env: authEnv, signal })
        return remote.split(/\s/)[0]
      }
      const save = async allocation => {
        if (publication?.saveAllocation) await publication.saveAllocation(allocation)
        publications.set(commit, allocation)
        saved = allocation
      }
      const baseBranch = saved?.baseBranch ?? branchForTitle(title)
      let branch, remoteCommit
      for (let attempt = saved?.attempt ?? 0; attempt <= 10; attempt++) {
        branch = attempt ? `${baseBranch}-${attempt}` : baseBranch
        if (saved && attempt === saved.attempt && branch !== saved.branch) throw new Error("Saved publication branch allocation is inconsistent")
        const existing = await find(branch)
        if (existing) {
          if (existing.commit === commit) {
            await save({ ...identity, branch, baseBranch, attempt, target, commit, pushed: true })
            return reuse(existing)
          }
          if (saved?.branch === branch) throw new Error("Existing PR source commit does not match the original publication")
          continue
        }
        remoteCommit = await remoteHead(branch)
        if (remoteCommit && (remoteCommit !== commit || saved?.branch !== branch)) {
          if (saved?.branch === branch && saved.pushed) throw new Error("Published branch changed; it will not be overwritten or replaced")
          if (attempt === 10) throw new Error("PR branch names are occupied after the base name and 10 suffix retries")
          continue
        }
        await save({ ...identity, branch, baseBranch, attempt, target, commit, pushed: saved?.branch === branch && saved.pushed === true })
        break
      }
      if (saved?.branch !== branch) throw new Error("PR branch names are occupied after the base name and 10 suffix retries")
      let directory, worktree, result, failure
      try {
        if (!remoteCommit) {
          await local(["fetch", "--no-tags", "--no-write-fetch-head", "--", workspace, commit], { signal })
          await local(["merge-base", "HEAD", commit], { signal })
          directory = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-pr-"))
          worktree = path.join(directory, "checkout")
          await fs.mkdir(path.join(directory, "no-hooks"))
          await local(["worktree", "add", "--detach", "--no-checkout", worktree, commit], { signal })
          // An empty expected ref permits creation only, never replacing another branch.
          for (;;) {
            try {
              await local([...credentials, "-c", `core.hooksPath=${path.join(directory, "no-hooks")}`,
                "push", "--porcelain", `--force-with-lease=refs/heads/${branch}:`, url, `${commit}:refs/heads/${branch}`],
              { cwd: worktree, env: authEnv, signal })
              break
            } catch (error) {
              if (!refConflict(error)) throw error
              const occupied = await remoteHead(branch)
              if (!occupied || occupied === commit || saved.attempt === 10) throw error
              let allocated = false
              for (let attempt = saved.attempt + 1; attempt <= 10; attempt++) {
                const candidate = `${baseBranch}-${attempt}`
                const existing = await find(candidate)
                if (existing?.commit === commit) throw new Error("Concurrent PR found; retry the same commit to reconcile it")
                if (existing || await remoteHead(candidate)) continue
                await save({ ...identity, branch: candidate, baseBranch, attempt, target, commit, pushed: false })
                branch = candidate
                allocated = true
                break
              }
              if (!allocated) throw new Error("PR branch names are occupied after the base name and 10 suffix retries")
            }
          }
        }
        await save({ ...saved, pushed: true })
        await createPr(branch)
        result = await find(branch)
        if (!result) throw new Error("PR creation returned without a verifiable PR; retry the same commit to reconcile")
        if (result.commit !== commit) throw new Error("Created PR source commit does not match the original publication")
        publications.set(commit, result)
      } catch (error) {
        failure = new Error(`Publication of ${branch} failed; retry the same commit to reconcile without duplicate publication. ${error.message}`)
      } finally {
        try {
          if (worktree) {
            const entries = (await local(["worktree", "list", "--porcelain", "-z"])).split("\0")
            if (entries.some(entry => entry.startsWith("worktree ") && path.resolve(entry.slice(9)) === path.resolve(worktree))) {
              await local(["worktree", "remove", "--force", worktree])
            }
          }
          if (directory) await fs.rm(directory, { recursive: true })
        } catch (error) {
          failure = new Error(`${failure?.message ?? `PR ${result?.url ?? branch} was published`}; temporary worktree cleanup failed: ${error.message}`)
        }
      }
      if (failure) throw failure
      return { ...result, reused: false, worktreeRemoved: true }
    },
  }
}
