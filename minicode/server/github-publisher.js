import { publicationCommand, publicationEnvironment, pullRequestTool } from "./pull-request-publisher.js"

export async function createGitHubPublisher({ repoRoot, repository, githubUser, run = publicationCommand }) {
  if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9_.-]*$/i.test(repository ?? "")
    || !/^[a-z0-9][a-z0-9-]*$/i.test(githubUser ?? "")) {
    throw new Error("PR publication requires --github-repo <owner/repo> and --github-user <account>")
  }
  const env = publicationEnvironment()
  const local = (args, options = {}) => run("git", args, { cwd: repoRoot, env, ...options })
  const origin = await local(["remote", "get-url", "origin"])
  const hostedRepo = origin.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?$/i)?.[1]
  if (hostedRepo?.toLowerCase() !== repository.toLowerCase()) {
    throw new Error("--github-repo must match the source checkout's GitHub origin")
  }
  return ({ workspace, agentId }) => pullRequestTool({
    repoRoot, workspace, agentId, env, run,
    url: `https://github.com/${repository}.git`,
    description: `Publish an existing local commit to ${repository} for review using harness-owned GitHub credentials and a temporary worktree. Retries of the same agent/commit reuse the branch and PR. Never merges or deploys.`,
    async prepare({ commit, branch, title, body, signal }) {
      const token = await run("gh", ["auth", "token", "--hostname", "github.com", "--user", githubUser], { cwd: repoRoot, env, signal })
      if (!token) throw new Error("Selected GitHub account returned no credential")
      const authEnv = { ...env, GH_TOKEN: token }
      const gh = args => run("gh", args, { cwd: repoRoot, env: authEnv, signal })
      const base = JSON.parse(await gh(["repo", "view", repository, "--json", "defaultBranchRef"])).defaultBranchRef?.name
      if (typeof base !== "string" || !base) throw new Error("GitHub repository has no default branch")
      return {
        authEnv,
        credentials: ["-c", "credential.helper=", "-c", "credential.https://github.com.helper=",
          "-c", "credential.https://github.com.helper=!gh auth git-credential"],
        async findPr() {
          const prs = JSON.parse(await gh(["pr", "list", "--repo", repository, "--head", branch, "--base", base,
            "--state", "all", "--json", "number,url,state,headRefOid", "--limit", "2"]))
          if (!Array.isArray(prs) || prs.length > 1) throw new Error("Ambiguous GitHub PR state; review the publication branch")
          if (!prs.length) return null
          const pr = prs[0]
          if (pr.headRefOid !== commit || !Number.isInteger(pr.number)
            || pr.url !== `https://github.com/${repository}/pull/${pr.number}`
            || !["OPEN", "CLOSED", "MERGED"].includes(pr.state)) throw new Error("GitHub returned an unexpected PR identity")
          return { repository, branch, commit, number: pr.number, url: pr.url, state: pr.state }
        },
        createPr: () => gh(["pr", "create", "--repo", repository, "--base", base, "--head", branch, "--title", title, "--body", body]),
      }
    },
  })
}
