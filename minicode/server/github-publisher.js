import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { stripVTControlCharacters } from "node:util"
import { killTree } from "./kill-tree.js"

function command(file, args, { cwd, env, signal } = {}) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    let timedOut = false
    const child = execFile(file, args, {
      cwd, env, windowsHide: true, detached: process.platform !== "win32", maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      if (signal?.aborted) { reject(new Error("Publication cancelled; retry the same commit to reconcile remote state")); return }
      if (error) {
        reject(new Error(`${file} ${args[0]} failed${timedOut ? " (timed out)" : ""}: ${stripVTControlCharacters(stderr || error.message).trim().slice(0, 2000)}`))
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

export async function createGitHubPublisher({ repoRoot, repository, githubUser, run = command }) {
  if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9_.-]*$/i.test(repository ?? "")
    || !/^[a-z0-9][a-z0-9-]*$/i.test(githubUser ?? "")) {
    throw new Error("PR publication requires --github-repo <owner/repo> and --github-user <account>")
  }
  const env = { ...process.env, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" }
  for (const key of Object.keys(env)) {
    if (/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|FORCE_COLOR|CLICOLOR_FORCE|GIT_CONFIG.*|GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES)$/i.test(key)) delete env[key]
  }
  const local = (args, options = {}) => run("git", args, { cwd: repoRoot, env, ...options })
  const origin = await local(["remote", "get-url", "origin"])
  const hostedRepo = origin.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?$/i)?.[1]
  if (hostedRepo?.toLowerCase() !== repository.toLowerCase()) {
    throw new Error("--github-repo must match the source checkout's GitHub origin")
  }
  return ({ workspace, agentId }) => ({
    name: "publish_pull_request",
    description: `Publish an existing local commit to ${repository} for review using harness-owned GitHub credentials and a temporary worktree. Retries of the same agent/commit reuse the branch and PR. Never merges or deploys.`,
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
      const branch = `minicode/${agentId}/${commit}`
      const url = `https://github.com/${repository}.git`
      await local(["cat-file", "-e", `${commit}^{commit}`], { cwd: workspace, signal })
      await local(["merge-base", "--is-ancestor", commit, "HEAD"], { cwd: workspace, signal })
      const token = await run("gh", ["auth", "token", "--hostname", "github.com", "--user", githubUser], { cwd: repoRoot, env, signal })
      if (!token) throw new Error("Selected GitHub account returned no credential")
      const authEnv = { ...env, GH_TOKEN: token }
      const gh = args => run("gh", args, { cwd: repoRoot, env: authEnv, signal })
      const credentials = ["-c", "credential.helper=", "-c", "credential.https://github.com.helper=",
        "-c", "credential.https://github.com.helper=!gh auth git-credential"]
      const remote = async () => {
        const output = await local([...credentials, "ls-remote", "--heads", url, `refs/heads/${branch}`], { env: authEnv, signal })
        const hash = output.split(/\s/)[0]
        if (hash && hash !== commit) throw new Error(`Publication branch ${branch} already points to another commit; it will not be overwritten`)
        return hash
      }
      const base = JSON.parse(await gh(["repo", "view", repository, "--json", "defaultBranchRef"])).defaultBranchRef?.name
      if (typeof base !== "string" || !base) throw new Error("GitHub repository has no default branch")
      const findPr = async () => {
        const prs = JSON.parse(await gh(["pr", "list", "--repo", repository, "--head", branch, "--base", base,
          "--state", "all", "--json", "number,url,state,headRefOid", "--limit", "2"]))
        if (!Array.isArray(prs) || prs.length > 1) throw new Error("Ambiguous GitHub PR state; review the publication branch")
        if (!prs.length) return null
        const pr = prs[0]
        if (pr.headRefOid !== commit || !Number.isInteger(pr.number)
          || pr.url !== `https://github.com/${repository}/pull/${pr.number}`
          || !["OPEN", "CLOSED", "MERGED"].includes(pr.state)) throw new Error("GitHub returned an unexpected PR identity")
        return { repository, branch, commit, number: pr.number, url: pr.url, state: pr.state }
      }
      const remoteCommit = await remote()
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
          // An empty expected ref permits creation only, never replacing somebody else's branch.
          await local([...credentials, "-c", `core.hooksPath=${path.join(directory, "no-hooks")}`,
            "push", "--porcelain", `--force-with-lease=refs/heads/${branch}:`, url, `${commit}:refs/heads/${branch}`],
          { cwd: worktree, env: authEnv, signal })
        }
        await gh(["pr", "create", "--repo", repository, "--base", base, "--head", branch, "--title", title, "--body", body])
        result = await findPr()
        if (!result) throw new Error("PR creation returned without a verifiable PR; retry the same commit to reconcile")
      } catch (error) {
        failure = new Error(`Publication of ${branch} failed; retry the same commit to reconcile without duplicate publication. ${error.message}`)
      } finally {
        try {
          // Cleanup must finish even when publication was cancelled.
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
  })
}
