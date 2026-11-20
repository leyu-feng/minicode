import fs from "node:fs/promises"
import path from "node:path"
import { azureDevOpsUrlsEqual, createAzureDevOpsPublisher, parseAzureDevOpsRepositoryUrl } from "./azure-devops-publisher.js"
import { assertInspectionReceipt, createPrInspectorPostback, inspectionBindings, paperclipApi } from "./hosted-publication.js"
import { publicationCommand, publicationEnvironment } from "./pull-request-publisher.js"

export function createDevboxPrInspectorPublication({ repositories, storage, task, apiUrl, workerName, user,
  clippyAuth, validationGuidance, run = publicationCommand, fetchImpl = fetch }) {
  const issueId = task.context.taskId ?? task.context.issueId
  const env = publicationEnvironment(), clients = new Map()
  let publicationPending = false
  const api = (suffix, signal) => paperclipApi(task, apiUrl,
    `/issues/${encodeURIComponent(issueId)}${suffix}`, "GET", undefined, signal)
  const local = (repo, args, signal) => run("git", args, { cwd: repo.path, env, signal })
  const load = async (signal, expected) => {
    const issue = await api("", signal)
    if (issue.id !== issueId || issue.companyId !== task.agent.companyId || issue.assigneeAgentId !== task.agent.id
      || !["in_progress", "blocked"].includes(issue.status)
      || ![issue.executionRunId, issue.checkoutRunId].includes(task.runId))
      throw new Error("PR revision requires the inspector's current assigned run")
    const approval = assertInspectionReceipt(await api("/inspection-result?requireApproved=true", signal), {
      ...inspectionBindings(issue, task.agent.companyId, task.agent.id), outcome: "approved",
    })
    const result = approval.result, revision = result.revision
    if (!revision || revision.provider !== "azure_devops" || !/^[a-f0-9]{40}$/.test(revision.expectedCommit ?? "")
      || revision.expectedCommit === result.reviewedCommit || revision.branch === result.branch
      || !/^u\/[a-z0-9][a-z0-9_-]{0,23}\/[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(revision.branch ?? "")
      || (expected && (expected.id !== approval.id || JSON.stringify(expected.result) !== JSON.stringify(result))))
      throw new Error("A fresh server-bound immutable revision approval is required; ordinary approvals cannot update an existing PR")
    const matches = repositories.filter(repo => !repo.readOnly && azureDevOpsUrlsEqual(repo.source, result.repositoryUrl))
    if (matches.length !== 1) throw new Error("Revision publication requires one matching listed writable repository")
    const repo = matches[0], target = `refs/heads/${repo.branch}`
    if (await fs.realpath(repo.path) !== repo.path || !(await fs.lstat(path.join(repo.path, ".git"))).isFile()
      || await fs.realpath(await local(repo, ["rev-parse", "--show-toplevel"], signal)) !== repo.path
      || !azureDevOpsUrlsEqual(await local(repo, ["remote", "get-url", "origin"], signal), repo.source))
      throw new Error("Revision publication requires the unchanged listed worker-owned worktree and origin")
    await local(repo, ["check-ref-format", target], signal)
    await local(repo, ["check-ref-format", `refs/heads/${revision.branch}`], signal)
    if (`refs/heads/${revision.branch}` === target) throw new Error("A PR revision cannot overwrite its target")
    if (!clients.has(repo.name)) {
      const { organization, project, repository } = parseAzureDevOpsRepositoryUrl(repo.source)
      clients.set(repo.name, await createAzureDevOpsPublisher({ repoRoot: repo.path,
        organization: `https://dev.azure.com/${organization}`, project, repository, user, clippyAuth, run, fetchImpl }))
    }
    const client = clients.get(repo.name)
    const number = Number(new URL(revision.url).pathname.split("/").at(-1))
    if (!Number.isSafeInteger(number) || number <= 0 || number > 2147483647
      || !azureDevOpsUrlsEqual(revision.url, client.pullRequestUrl(number)))
      throw new Error("The revision PR URL does not belong to the verified repository")
    const pr = await client.readPullRequest(number, signal)
    const ref = `refs/heads/${revision.branch}`
    const output = await local(repo, ["ls-remote", "--heads", repo.source, ref], signal)
    const [head, actual, extra] = output.split(/\s+/)
    if (pr.state !== "active" || pr.isDraft !== false || pr.autoCompleteSet !== false
      || pr.branch !== revision.branch || pr.target !== target || !azureDevOpsUrlsEqual(pr.url, revision.url)
      || ref === pr.defaultBranch
      || extra || actual !== ref || !/^[a-f0-9]{40}$/.test(head ?? "") || head !== pr.remoteCommit
      || ![revision.expectedCommit, result.reviewedCommit].includes(head))
      throw new Error("The original active non-draft PR, target or exact source lease changed; no replacement PR is permitted")
    return { issue, approval, result, revision, repo, pr, head, ref }
  }
  const postback = createPrInspectorPostback({ task, apiUrl, separateBranch: true, workerName,
    validationGuidance, devboxBranchCleanup: true,
    async verifyRevisionPublication(approval, { signal }) {
      const current = await load(signal, approval)
      if (current.head !== approval.result.reviewedCommit)
        throw new Error("Provider verification must confirm the new approved SHA on the original PR before postback")
    },
  })
  const update = {
    name: "update_inspected_pull_request",
    description: "After recording a fresh approved exact-SHA revision inspection, update only its server-bound existing non-draft PR branch with the original exact-old-SHA lease. All identities come from the immutable approval and trusted workspace; no PR/ref/SHA overrides. Independently verifies source before and after the push, reconciles the same update after uncertainty, records the fresh review and notifies the producer. Never creates a PR, changes its target, merges, enables auto-complete or bypasses policies. New-head CI/review gates remain required; old-head results do not carry forward. Retry this same operation after uncertainty.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(input = {}, { signal } = {}) {
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length)
        throw new Error("Revision publication accepts no repository, PR, branch, commit or lease overrides")
      const current = await load(signal)
      const { issue, approval, result, revision, repo, pr, head, ref } = current
      const title = issue.title?.replace(/^Review PR: /, "")
      if (typeof title !== "string" || !title.trim() || title.length > 200)
        throw new Error("The assigned revision review requires its original publication title")
      if (head !== result.reviewedCommit) {
        const parent = await paperclipApi(task, apiUrl, `/issues/${encodeURIComponent(result.sourceIssueId)}`, "GET", undefined, signal)
        if (parent.id !== result.sourceIssueId || parent.companyId !== result.companyId
          || parent.assigneeAgentId !== result.sourceAgentId || !["in_progress", "blocked"].includes(parent.status))
          throw new Error("The original producer task must remain active before revising its PR")
        if (await local(repo, ["rev-parse", "--verify", "HEAD"], signal) !== result.reviewedCommit)
          throw new Error("The worker must retain the independently approved exact source HEAD before publication")
        await local(repo, ["diff", "--quiet", "--no-ext-diff", "HEAD", "--"], signal)
        if (!path.isAbsolute(storage ?? "")) throw new Error("Revision publication requires worker-owned publication storage")
        for (const directory of [path.dirname(path.dirname(storage)), path.dirname(storage)]) {
          if (await fs.realpath(directory) !== directory) throw new Error("Publication storage must not contain directory links")
        }
        await fs.mkdir(storage, { recursive: false }).catch(error => { if (error.code !== "EEXIST") throw error })
        if (await fs.realpath(storage) !== storage) throw new Error("Publication storage must not contain directory links")
        const hooks = path.join(storage, "no-hooks")
        await fs.mkdir(hooks, { recursive: true })
        if (await fs.realpath(hooks) !== hooks || (await fs.readdir(hooks)).length)
          throw new Error("Revision publication requires an empty harness-owned hooks directory")
        // The immutable approval is the durable old/new/PR/ref intent; a retry must reconcile that same lease.
        publicationPending = true
        signal?.throwIfAborted()
        await local(repo, ["-c", `core.hooksPath=${hooks}`, "push", "--porcelain",
          `--force-with-lease=${ref}:${revision.expectedCommit}`, repo.source, `${result.reviewedCommit}:${ref}`], signal)
      }
      publicationPending = true
      const registered = await postback.tools.find(tool => tool.name === "record_pull_request").execute({
        url: revision.url, title, provider: revision.provider, submissionId: result.submissionId,
        branch: revision.branch, reviewedCommit: result.reviewedCommit,
      }, { signal })
      publicationPending = false
      return { ...registered, previousCommit: revision.expectedCommit, reviewedCommit: result.reviewedCommit,
        inspectionReceiptId: approval.id, requiresFreshHeadChecks: true, reused: head === result.reviewedCommit,
        number: pr.number, branch: revision.branch }
    },
  }
  return {
    tools: [...postback.tools.map(tool => tool.name !== "record_inspection_blocked" ? tool : { ...tool,
      async execute(...args) {
        if (publicationPending) throw new Error("Reconcile the uncertain existing-PR revision before recording a different checkpoint")
        return tool.execute(...args)
      },
    }), update],
    get registrationError() {
      return postback.registrationError ?? (publicationPending ? "Existing-PR revision is unconfirmed; retry update_inspected_pull_request." : null)
    },
    assertCanComplete() {
      if (this.registrationError) throw new Error(this.registrationError)
    },
  }
}
