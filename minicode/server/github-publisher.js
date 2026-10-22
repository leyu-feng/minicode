import { publicationBranch, publicationCommand, publicationEnvironment, pullRequestTool } from "./pull-request-publisher.js"

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
  let repositoryId
  return ({ workspace, agentId, agentName = agentId }) => pullRequestTool({
    repoRoot, workspace, agentId, env, run,
    url: `https://github.com/${repository}.git`,
    branchForTitle: title => publicationBranch(githubUser, agentName, title),
    description: `Publish an existing local commit to ${repository} for review using harness-owned GitHub credentials. Branches use users/${githubUser}/<agent-name>/<feature-title> with up to 10 collision suffixes. Saved PRs reconcile without local history. Never merges or deploys.`,
    async prepare({ title, body, signal, saved }) {
      if (await local(["remote", "get-url", "origin"], { signal }) !== origin) throw new Error("Source origin changed; restart the worker before publication")
      const token = await run("gh", ["auth", "token", "--hostname", "github.com", "--user", githubUser], { cwd: repoRoot, env, signal })
      if (!token) throw new Error("Selected GitHub account returned no credential")
      const authEnv = { ...env, GH_TOKEN: token }
      const gh = args => run("gh", args, { cwd: repoRoot, env: authEnv, signal })
      const info = JSON.parse(await gh(["repo", "view", repository, "--json", "id,nameWithOwner,defaultBranchRef"]))
      if (typeof info.id !== "string" || !info.id || info.nameWithOwner?.toLowerCase() !== repository.toLowerCase()
        || (repositoryId && repositoryId !== info.id) || (saved?.repositoryId && saved.repositoryId !== info.id)) {
        throw new Error("GitHub repository identity changed or does not match the saved publication")
      }
      repositoryId = info.id
      const base = saved?.target ?? info.defaultBranchRef?.name
      if (typeof base !== "string" || !base) throw new Error("GitHub repository has no default branch")
      await local(["check-ref-format", `refs/heads/${base}`], { signal })
      return {
        authEnv, target: base, repositoryId,
        credentials: ["-c", "credential.helper=", "-c", "credential.https://github.com.helper=",
          "-c", "credential.https://github.com.helper=!gh auth git-credential"],
        async findPr(branch, number) {
          const fields = "number,url,state,headRefOid,headRefName,baseRefName"
          const prs = number
            ? [JSON.parse(await gh(["pr", "view", String(number), "--repo", repository, "--json", fields]))]
            : JSON.parse(await gh(["pr", "list", "--repo", repository, "--head", branch, "--base", base,
              "--state", "all", "--json", fields, "--limit", "2"]))
          if (!Array.isArray(prs) || prs.length > 1) throw new Error("Ambiguous GitHub PR state; review the publication branch")
          if (!prs.length) return null
          const pr = prs[0]
          if (!pr || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(pr.headRefOid ?? "") || !Number.isSafeInteger(pr.number) || pr.number < 1
            || (number && pr.number !== number) || pr.headRefName !== branch || pr.baseRefName !== base
            || pr.url !== `https://github.com/${repository}/pull/${pr.number}`
            || !["OPEN", "CLOSED", "MERGED"].includes(pr.state)) throw new Error("GitHub returned an unexpected PR identity")
          return { repository, repositoryId, branch, target: base, commit: pr.headRefOid, number: pr.number, url: pr.url, state: pr.state }
        },
        createPr: branch => gh(["pr", "create", "--repo", repository, "--base", base, "--head", branch, "--title", title, "--body", body]),
      }
    },
  })
}
