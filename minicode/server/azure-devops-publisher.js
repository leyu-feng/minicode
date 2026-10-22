import { fileURLToPath } from "node:url"
import { publicationCommand, publicationEnvironment, pullRequestTool } from "./pull-request-publisher.js"

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i
const DEFAULT_CLIPPY_AUTH = fileURLToPath(new URL("../../clippy-auth/cli.js", import.meta.url))

function azureUrl(value, allowUsername = false) {
  const url = new URL(value)
  if (url.protocol !== "https:" || (!allowUsername && url.username) || url.password || url.port || url.search || url.hash) {
    throw new Error("Azure DevOps publication requires trusted HTTPS Azure Repos URLs without embedded passwords")
  }
  const parts = url.pathname.replace(/\/+$/, "").split("/").slice(1).map(decodeURIComponent)
  const legacy = url.hostname.match(/^([a-z0-9][a-z0-9-]*)\.visualstudio\.com$/i)
  let organization
  if (url.hostname === "dev.azure.com") organization = parts.shift()
  else if (legacy) {
    organization = legacy[1]
    if (parts[0]?.toLowerCase() === "defaultcollection") parts.shift()
  } else throw new Error("Azure DevOps publication supports dev.azure.com and visualstudio.com only")
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(organization ?? "")
    || parts.some(part => !part || /[/\\\x00-\x1f\x7f]/.test(part) || [".", ".."].includes(part))) {
    throw new Error("Invalid Azure DevOps repository URL")
  }
  return { organization: organization.toLowerCase(), parts }
}

function repositoryUrl(value) {
  const { organization, parts } = azureUrl(value, true)
  if (parts.length !== 3 || parts[1] !== "_git") throw new Error("Expected an Azure Repos HTTPS repository URL")
  return { organization, project: parts[0], repository: parts[2] }
}

export function createAzureDevOpsTokenProvider({ organization, user, repoRoot, env,
  clippyAuth = DEFAULT_CLIPPY_AUTH, run = publicationCommand }) {
  let cached, pending
  return async signal => {
    signal?.throwIfAborted()
    if (cached && Date.parse(cached.expiresAt) > Date.now() + 60_000) return cached.accessToken
    pending ??= (async () => {
      let output
      try {
        output = await run(process.execPath, [clippyAuth, "ado-token", "--organization", organization,
          "--user", user, "--silent"], { cwd: repoRoot, env, signal })
      } catch {
        throw new Error(`Azure DevOps authentication failed. Sign in explicitly with: node "${clippyAuth}" ado-login --organization ${organization} --user ${user}`)
      }
      let token
      try { token = JSON.parse(output) } catch { throw new Error("clippy-auth returned invalid Azure DevOps token JSON") }
      if (!token || typeof token.user !== "string" || token.user.toLowerCase() !== user.toLowerCase()
        || !UUID.test(token.tenantId ?? "")
        || typeof token.accessToken !== "string" || !token.accessToken || /[\r\n]/.test(token.accessToken)
        || !Number.isFinite(Date.parse(token.expiresAt)) || Date.parse(token.expiresAt) <= Date.now() + 60_000) {
        throw new Error("clippy-auth returned an invalid Azure DevOps identity or token expiry")
      }
      cached = token
      return token.accessToken
    })().finally(() => { pending = null })
    return pending
  }
}

export async function createAzureDevOpsPublisher({ repoRoot, organization, project, repository, user,
  alias, clippyAuth, run = publicationCommand, fetchImpl = fetch }) {
  alias ??= typeof user === "string" ? user.split("@")[0] : undefined
  if (!organization || typeof project !== "string" || !project.trim()
    || typeof repository !== "string" || !repository.trim()
    || [project, repository].some(value => /[\x00-\x1f\x7f]/.test(value))
    || typeof user !== "string" || !/^[^@\s]+@[^@\s]+$/.test(user)
    || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(alias ?? "")) {
    throw new Error("Azure DevOps publication requires --azure-devops-org <url>, --azure-devops-project <name-or-id>, --azure-devops-repo <name-or-id> and --azure-devops-user <upn>; --azure-devops-alias must be a simple branch-safe alias")
  }
  const configured = azureUrl(organization)
  if (configured.parts.length) throw new Error("--azure-devops-org must be an organization URL")
  const org = `https://dev.azure.com/${configured.organization}`
  const env = publicationEnvironment()
  const origin = await run("git", ["remote", "get-url", "origin"], { cwd: repoRoot, env })
  const source = repositoryUrl(origin)
  if (source.organization !== configured.organization) throw new Error("Azure DevOps organization must match the source checkout's origin")
  const token = createAzureDevOpsTokenProvider({ organization: org, user, repoRoot, env, clippyAuth, run })
  let bound
  const api = async (route, { method = "GET", body, signal } = {}) => {
    const url = new URL(`${org}/${encodeURIComponent(bound?.project.id ?? project)}/_apis/git/repositories/${encodeURIComponent(bound?.id ?? repository)}${route}`)
    url.searchParams.set("api-version", "7.1")
    const accessToken = await token(signal)
    let response
    try {
      response = await fetchImpl(url, { method, redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
        headers: { Authorization: `Bearer ${accessToken}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) })
    } catch { throw new Error(`Azure DevOps ${method} request failed`) }
    if (!response.ok) throw new Error(`Azure DevOps ${method} returned HTTP ${response.status}`)
    try { return await response.json() } catch { throw new Error("Azure DevOps returned invalid JSON") }
  }
  const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase()
  const readRepository = async signal => {
    const info = await api("", { signal })
    const hosted = repositoryUrl(info.remoteUrl)
    if (!UUID.test(info.id ?? "") || !UUID.test(info.project?.id ?? "")
      || !same(hosted.organization, source.organization) || !same(hosted.project, source.project)
      || !same(hosted.repository, source.repository)
      || ![info.id, info.name].some(value => same(value, repository))
      || ![info.project?.id, info.project?.name].some(value => same(value, project))
      || !same(info.name, hosted.repository) || !same(info.project?.name, hosted.project)
      || typeof info.defaultBranch !== "string" || !info.defaultBranch.startsWith("refs/heads/")) {
      throw new Error("Azure DevOps repository identity must match the configured source checkout")
    }
    await run("git", ["check-ref-format", info.defaultBranch], { cwd: repoRoot, env, signal })
    return info
  }
  bound = await readRepository()
  const pushUrl = new URL(bound.remoteUrl)
  pushUrl.username = ""
  const identity = `${source.organization}/${bound.project.name}/${bound.name}`
  const webUrl = `https://dev.azure.com/${source.organization}/${encodeURIComponent(bound.project.name)}/_git/${encodeURIComponent(bound.name)}`
  const branchForCommit = (agentId, commit) => `users/${alias}/minicode-${agentId}-${commit}`
  const publisher = ({ workspace, agentId }) => pullRequestTool({
    repoRoot, workspace, agentId, env, run, url: pushUrl.href,
    branchForCommit: commit => branchForCommit(agentId, commit),
    description: `Publish an existing local commit to Azure Repos ${identity} using existing Git credentials for push and harness-only MSAL credentials for REST PRs. Branches use users/${alias}/. Retries reuse the branch and PR. Never merges or deploys.`,
    async prepare({ commit, branch, title, body, signal }) {
      const currentOrigin = repositoryUrl(await run("git", ["remote", "get-url", "origin"], { cwd: repoRoot, env, signal }))
      if (JSON.stringify(currentOrigin) !== JSON.stringify(source)) throw new Error("Source origin changed; restart the worker before publication")
      const info = await readRepository(signal)
      if (!same(info.id, bound.id) || !same(info.project.id, bound.project.id)) throw new Error("Azure DevOps repository changed; restart the worker")
      const target = info.defaultBranch
      return {
        async findPr() {
          const query = new URLSearchParams({ "searchCriteria.sourceRefName": `refs/heads/${branch}`,
            "searchCriteria.targetRefName": target, "searchCriteria.status": "all", "$top": "2" })
          const result = await api(`/pullrequests?${query}`, { signal })
          const prs = result.value
          if (!Array.isArray(prs) || prs.length > 1) throw new Error("Ambiguous Azure DevOps PR state; review the publication branch")
          if (!prs.length) return null
          const pr = prs[0]
          const state = { active: "OPEN", completed: "MERGED", abandoned: "CLOSED" }[pr.status]
          if (!Number.isSafeInteger(pr.pullRequestId) || pr.pullRequestId < 1 || !state
            || !same(pr.repository?.id, bound.id) || !same(pr.repository?.project?.id, bound.project.id)
            || pr.sourceRefName !== `refs/heads/${branch}` || pr.targetRefName !== target
            || pr.lastMergeSourceCommit?.commitId !== commit) {
            throw new Error("Azure DevOps returned an unexpected PR identity")
          }
          return { provider: "azure_devops", repository: identity, branch, commit,
            number: pr.pullRequestId, url: `${webUrl}/pullrequest/${pr.pullRequestId}`, state }
        },
        createPr: () => api("/pullrequests", { method: "POST", signal,
          body: { sourceRefName: `refs/heads/${branch}`, targetRefName: target, title, description: body } }),
      }
    },
  })
  publisher.repository = identity
  publisher.pullRequestUrl = number => `${webUrl}/pullrequest/${number}`
  publisher.branchForCommit = branchForCommit
  return publisher
}
