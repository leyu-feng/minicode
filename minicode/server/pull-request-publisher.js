import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { stripVTControlCharacters } from "node:util"
import { killTree } from "./kill-tree.js"

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
        reject(new Error(`${label} failed${timedOut ? " (timed out)" : ""}: ${stripVTControlCharacters(stderr || error.message).trim().slice(0, 2000)}`))
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

export function pullRequestTool({ repoRoot, workspace, agentId, description, url, env, run, prepare,
  branchForCommit = commit => `minicode/${agentId}/${commit}` }) {
  const local = (args, options = {}) => run("git", args, { cwd: repoRoot, env, ...options })
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
    async execute(input, { signal } = {}) {
      if (!input || typeof input !== "object" || Array.isArray(input)
        || Object.keys(input).some(key => !["commit", "title", "body"].includes(key))
        || typeof input.commit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.commit)
        || typeof input.title !== "string" || !input.title.trim() || input.title.length > 200
        || /[\r\n\0]/.test(input.title) || typeof input.body !== "string" || !input.body.trim()
        || input.body.length > 8000 || input.body.includes("\0")
        || !/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(agentId)) {
        throw new Error("publish_pull_request requires a full commit hash, title (1-200 characters), and body (1-8000 characters); no repository or branch overrides")
      }
      const { commit, title, body } = input
      const branch = branchForCommit(commit)
      await local(["check-ref-format", `refs/heads/${branch}`], { signal })
      await local(["cat-file", "-e", `${commit}^{commit}`], { cwd: workspace, signal })
      await local(["merge-base", "--is-ancestor", commit, "HEAD"], { cwd: workspace, signal })
      const { authEnv = env, credentials = [], findPr, createPr } = await prepare({ commit, branch, title, body, signal })
      const remote = await local([...credentials, "ls-remote", "--heads", url, `refs/heads/${branch}`], { env: authEnv, signal })
      const remoteCommit = remote.split(/\s/)[0]
      if (remoteCommit && remoteCommit !== commit) throw new Error(`Publication branch ${branch} already points to another commit; it will not be overwritten`)
      const existing = await findPr()
      if (existing) return { ...existing, reused: true, worktreeRemoved: true }
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
          await local([...credentials, "-c", `core.hooksPath=${path.join(directory, "no-hooks")}`,
            "push", "--porcelain", `--force-with-lease=refs/heads/${branch}:`, url, `${commit}:refs/heads/${branch}`],
          { cwd: worktree, env: authEnv, signal })
        }
        await createPr()
        result = await findPr()
        if (!result) throw new Error("PR creation returned without a verifiable PR; retry the same commit to reconcile")
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
