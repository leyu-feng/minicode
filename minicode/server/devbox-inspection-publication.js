import fs from "node:fs/promises"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { azureDevOpsUrlsEqual, createAzureDevOpsPublisher, parseAzureDevOpsRepositoryUrl } from "./azure-devops-publisher.js"
import { assertInspectionReceipt, createHostedPublicationTool, inspectionBindings, paperclipApi } from "./hosted-publication.js"
import { createPaperclipTaskTools } from "./paperclip-task-tools.js"
import { publicationBranch, publicationCommand, publicationEnvironment, validatePublicationInput } from "./pull-request-publisher.js"
import { DEVBOX_VALIDATION_GUIDANCE } from "./repository-policy.js"
import { redactSecrets } from "./http-error.js"

const SUBMISSION = /^submission-publication-[a-f0-9]{64}$/
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex")

export function createDevboxInspectionPublication({ repositories, storage, workerName, task, apiUrl, server, user,
  clippyAuth, run = publicationCommand, fetchImpl = fetch,
  inspectorValidationGuidance = () => DEVBOX_VALIDATION_GUIDANCE }) {
  const issueId = task.context.taskId ?? task.context.issueId
  const deployment = new URL(server).origin
  if (!task.prPolicy?.inspectorAgentId || task.prPolicy.isInspector !== false
    || task.prPolicy.inspectorAgentId === task.agent.id || !path.isAbsolute(storage ?? ""))
    throw new Error("Local branch inspection requires a producer assignment and worker-owned publication storage")
  const writable = repositories.filter(repo => !repo.readOnly).map(repo => {
    const source = new URL(repo.source)
    if (source.username || source.password || source.search || source.hash)
      throw new Error("Local inspection repositories must not contain credentials or query parameters")
    return { ...repo, id: repo.name, source: source.href,
      get parsed() { return parseAzureDevOpsRepositoryUrl(source.href) },
      get publication() {
        const parsed = this.parsed
        const web = `https://dev.azure.com/${parsed.organization}/${encodeURIComponent(parsed.project)}/_git/${encodeURIComponent(parsed.repository)}`
        return { provider: "azure_devops",
          repository: `${parsed.organization}/${parsed.project}/${parsed.repository}`,
          pullRequestUrlTemplate: `${web}/pullrequest/{number}`, branchTemplate: "u/{workerName}/{feature}" }
      } }
  })
  const env = publicationEnvironment()
  const providers = new Map()
  const scope = { apiUrl, authToken: task.authToken, runId: task.runId, issueId,
    agentId: task.agent.id, companyId: task.agent.companyId }
  const taskTools = createPaperclipTaskTools(scope)
  const api = (route, signal) => paperclipApi(task, apiUrl, route, "GET", undefined, signal)
  const local = (repo, args, signal) => run("git", args, { cwd: repo.path, env, signal })
  const authorize = async signal => {
    const issue = await api(`/issues/${encodeURIComponent(issueId)}`, signal)
    const policy = await api(`/companies/${encodeURIComponent(task.agent.companyId)}/pr-inspector`, signal)
    if (issue.id !== issueId || issue.companyId !== task.agent.companyId || issue.assigneeAgentId !== task.agent.id
      || !["in_progress", "blocked"].includes(issue.status)
      || ![issue.executionRunId, issue.checkoutRunId].includes(task.runId)
      || policy?.agentId !== task.prPolicy.inspectorAgentId)
      throw new Error("Local publication requires the current assigned run and unchanged company PR Inspector")
  }
  const directory = async () => {
    for (const entry of [path.dirname(path.dirname(storage)), path.dirname(storage)]) {
      if (await fs.realpath(entry) !== entry) throw new Error("Publication storage must not contain directory links")
    }
    await fs.mkdir(storage, { recursive: false }).catch(error => {
      if (error.code !== "EEXIST") throw error
    })
    if (await fs.realpath(storage) !== storage) throw new Error("Publication storage must not contain directory links")
  }
  const read = async id => {
    if (!SUBMISSION.test(id ?? "")) throw new Error("Invalid local submission receipt ID")
    const file = path.join(storage, `${id}.json`)
    try {
      if ((await fs.lstat(file)).isSymbolicLink()) throw new Error("Publication receipts must not be links")
      return JSON.parse(await fs.readFile(file, "utf8"))
    } catch (error) {
      if (error.code === "ENOENT") return null
      throw error
    }
  }
  const save = async record => {
    const file = path.join(storage, `${record.submissionId}.json`), temporary = `${file}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 })
      await fs.rename(temporary, file)
    } catch (error) {
      await fs.rm(temporary, { force: true })
      throw error
    }
  }
  const binding = (repo, commit, ownerWorkerName = workerName) => ({
    version: 1, deployment, companyId: task.agent.companyId, agentId: task.agent.id, issueId, workerName: ownerWorkerName,
    repository: repo.source, repositoryAlias: repo.name, target: `refs/heads/${repo.branch}`, commit,
  })
  const check = (repo, record) => {
    const ownerWorkerName = record.retirementOnly === true ? record.workerName : workerName
    const expected = binding(repo, record.commit, ownerWorkerName)
    if (Object.entries(expected).some(([key, value]) => record[key] !== value)
      || (record.retirementOnly === true && record.retirementWorkerName !== workerName)
      || record.submissionId !== `submission-publication-${hash(expected)}`
      || !/^[a-f0-9]{40}$/.test(record.commit ?? "")
      || !Number.isInteger(record.attempt) || record.attempt < 0 || record.attempt > 10
      || record.baseBranch !== publicationBranch("", task.agent.name ?? task.agent.id, record.title, ownerWorkerName)
      || record.branch !== `${record.baseBranch}${record.attempt ? `-${record.attempt}` : ""}`
      || !["ALLOCATED", "CONFLICT", "SUBMITTED", "DELETING", "CLEANUP_PENDING", "DELETED"].includes(record.state))
      throw new Error("Saved publication does not belong to this worker, agent, task and repository")
    return record
  }
  const remote = async (repo, branch, signal) => {
    const ref = `refs/heads/${branch}`
    await local(repo, ["check-ref-format", ref], signal)
    const output = await local(repo, ["ls-remote", "--heads", repo.source, ref], signal)
    if (!output) return null
    const [commit, actual, extra] = output.split(/\s+/)
    if (extra || actual !== ref || !/^[a-f0-9]{40}$/.test(commit))
      throw new Error("Git did not confirm the exact publication ref")
    return commit
  }
  const push = async (repo, record, deletion, signal) => {
    const hooks = path.join(storage, "no-hooks")
    await fs.mkdir(hooks, { recursive: true })
    if (await fs.realpath(hooks) !== hooks || (await fs.readdir(hooks)).length)
      throw new Error("Publication requires an empty harness-owned hooks directory")
    const ref = `refs/heads/${record.branch}`
    return local(repo, ["-c", `core.hooksPath=${hooks}`, "push", "--porcelain",
      `--force-with-lease=${ref}:${deletion ? record.commit : ""}`, repo.source,
      `${deletion ? "" : record.commit}:${ref}`], signal)
  }
  const receipt = record => ({ submissionId: record.submissionId, commit: record.commit,
    remoteCommit: record.commit, branch: record.branch, state: record.state })
  const provider = async (repo, signal) => {
    if (await fs.realpath(repo.path) !== repo.path || !(await fs.lstat(path.join(repo.path, ".git"))).isFile()
      || await fs.realpath(await local(repo, ["rev-parse", "--show-toplevel"], signal)) !== repo.path
      || new URL(await local(repo, ["remote", "get-url", "origin"], signal)).href !== repo.source)
      throw new Error("Publication requires the listed worker-owned worktree and unchanged origin")
    if (!providers.has(repo.id)) {
      const { organization, project, repository } = repo.parsed
      providers.set(repo.id, await createAzureDevOpsPublisher({ repoRoot: repo.path,
        organization: `https://dev.azure.com/${organization}`, project, repository, user, clippyAuth, run, fetchImpl }))
    }
    const client = providers.get(repo.id)
    await client.verifyRepository(signal)
    return client
  }
  const inspectionReview = async (repo, submissionId, outcome, signal) => {
    const snapshot = await taskTools.find(tool => tool.name === "paperclip_get_issue").execute({}, { signal })
    const reviews = snapshot.children.filter(child => child.assigneeAgentId === task.prPolicy.inspectorAgentId
      && String(child.description ?? "").split(/\r?\n/).includes(`Submission ID: ${submissionId}`))
    if (reviews.length !== 1) throw new Error("Retirement requires the unique inspector review of this submission")
    const review = await api(`/issues/${encodeURIComponent(reviews[0].id)}`, signal)
    const actual = inspectionBindings(review, task.agent.companyId, task.prPolicy.inspectorAgentId)
    const expected = { companyId: task.agent.companyId, inspectorAgentId: task.prPolicy.inspectorAgentId,
      inspectionIssueId: review.id, sourceIssueId: issueId, sourceAgentId: task.agent.id,
      submissionId, repositoryUrl: repo.source }
    if (review.id !== reviews[0].id || review.companyId !== task.agent.companyId
      || review.assigneeAgentId !== task.prPolicy.inspectorAgentId || review.createdByAgentId !== task.agent.id
      || Object.entries(expected).some(([key, value]) => actual[key] !== value))
      throw new Error("Inspection review does not match the saved producer submission")
    assertInspectionReceipt(await api(`/issues/${encodeURIComponent(review.id)}/inspection-result`, signal),
      { ...actual, outcome })
    if (outcome === "changes_requested") {
      const products = await api(`/issues/${encodeURIComponent(review.id)}/work-products`, signal)
      if (review.status !== "blocked" || review.executionRunId || review.checkoutRunId
        || review.unblockDescriptor?.owner?.agentId !== task.prPolicy.inspectorAgentId
        || !Array.isArray(products) || products.some(product => product.type === "pull_request"))
        throw new Error("Retain the earlier branch until its stopped inspection confirms rejection without a PR")
    }
    return { review, bindings: actual }
  }
  const retirementRecord = async (repo, submissionId, outcome, signal) => {
    const saved = await read(submissionId)
    if (saved) return { record: check(repo, saved) }
    const inspection = await inspectionReview(repo, submissionId, outcome, signal)
    const { branch, reviewedCommit } = inspection.bindings
    const owner = /^u\/([a-z0-9][a-z0-9_-]{0,23})\/[a-z0-9]+(?:-[a-z0-9]+)*$/i.exec(branch)
    if (!owner || !inspection.review.title?.startsWith("Review PR: "))
      throw new Error("Retirement recovery requires the original managed branch allocation")
    const title = inspection.review.title.slice("Review PR: ".length)
    const baseBranch = publicationBranch("", task.agent.name ?? task.agent.id, title, owner[1])
    const suffix = branch.slice(baseBranch.length)
    const attempt = suffix === "" ? 0 : /^-(?:[1-9]|10)$/.test(suffix) ? Number(suffix.slice(1)) : -1
    const record = { ...binding(repo, reviewedCommit, owner[1]), submissionId, branch, title, baseBranch, attempt,
      state: "SUBMITTED", retirementOnly: true, retirementWorkerName: workerName }
    check(repo, record)
    return { record, inspection }
  }
  const approvedReview = async (repo, accepted, url, signal, inspection) => {
    const { review, bindings } = inspection ?? await inspectionReview(repo, accepted.submissionId, "approved", signal)
    if (bindings.reviewedCommit !== accepted.commit || bindings.branch !== accepted.branch)
      throw new Error("Inspection review does not match the saved producer submission")
    const products = await api(`/issues/${encodeURIComponent(review.id)}/work-products`, signal)
    if (!Array.isArray(products) || products.filter(product => product.type === "pull_request" && azureDevOpsUrlsEqual(product.url, url)
      && product.metadata?.submissionId === accepted.submissionId && product.metadata?.sourceAgentId === task.agent.id
      && product.metadata?.inspectionIssueId === review.id && product.metadata?.reviewedCommit === accepted.commit).length !== 1)
      throw new Error("Retirement requires the inspector's confirmed PR work product")
  }
  const execute = async (operation, input, { signal } = {}) => {
    if (operation !== "publish") throw new Error("Unsupported local publication operation")
    const repo = writable.find(repo => repo.id === input.repositoryId)
    if (!repo) throw new Error("Publication requires a listed writable repository")
    await authorize(signal)
    await directory()
    const client = await provider(repo, signal)
    if (input.mode === "reconcile_branch" || input.mode === "submit_branch") {
      const publication = { commit: input.commit, title: input.title, body: input.body }
      validatePublicationInput(publication, task.agent.id)
      const identity = binding(repo, input.commit), submissionId = `submission-publication-${hash(identity)}`
      let record = await read(submissionId)
      if (record) {
        check(repo, record)
        if (record.retirementOnly) throw new Error("A recovered retirement receipt cannot publish or resubmit a branch")
        if (record.signature !== hash(publication))
          throw new Error("Retry this submission with the same commit, title and body")
        if (["DELETING", "CLEANUP_PENDING", "DELETED"].includes(record.state))
          throw new Error("This submission is already retiring or retired; do not republish it")
        if (record.state !== "CONFLICT") {
          const head = await remote(repo, record.branch, signal)
          if (head === record.commit) {
            record.state = "SUBMITTED"
            await save(record)
            return receipt(record)
          }
          if (head || record.state === "SUBMITTED")
            throw new Error("Saved submission branch changed or disappeared; retain it for reconciliation")
        }
      }
      if (input.mode === "reconcile_branch") return { state: "NOT_SUBMITTED" }
      if (await local(repo, ["rev-parse", "--verify", `${input.commit}^{commit}`], signal) !== input.commit)
        throw new Error("Submission requires an existing full local commit")
      await local(repo, ["merge-base", "--is-ancestor", input.commit, "HEAD"], signal)
      const baseBranch = publicationBranch("", task.agent.name ?? task.agent.id, input.title, workerName)
      for (let attempt = record?.state === "CONFLICT" ? record.attempt + 1 : record?.attempt ?? 0; attempt <= 10; attempt++) {
        const branch = `${baseBranch}${attempt ? `-${attempt}` : ""}`
        if (await remote(repo, branch, signal)) {
          if (record?.branch === branch) throw new Error("Saved branch allocation is occupied; reconcile before retrying")
          continue
        }
        record = { ...identity, submissionId, title: input.title, signature: hash(publication),
          baseBranch, branch, attempt, state: "ALLOCATED" }
        await save(record)
        try { await push(repo, record, false, signal) }
        catch (error) {
          // A confirmed create-only lease conflict is safe to skip; other failures keep the allocation for reconciliation.
          if (error.refConflict !== true) throw error
          record.state = "CONFLICT"
          await save(record)
          continue
        }
        if (await remote(repo, branch, signal) !== input.commit)
          throw new Error("Submission push is unconfirmed; retry identical inputs to reconcile the saved allocation")
        record.state = "SUBMITTED"
        await save(record)
        return receipt(record)
      }
      throw new Error("All 11 worker publication branch names are occupied")
    }
    if (input.mode !== "delete_submitted_branch") throw new Error("Local producers may submit and retire branches, never create PRs")
    const original = await retirementRecord(repo, input.submissionId,
      input.supersededBySubmissionId ? "changes_requested" : "approved", signal)
    const record = original.record
    if (record.state === "ALLOCATED") throw new Error("Reconcile the submitted branch before retirement")
    const replacement = input.supersededBySubmissionId
      ? await retirementRecord(repo, input.supersededBySubmissionId, "approved", signal) : original
    const accepted = replacement.record
    if (!["SUBMITTED", "DELETING", "CLEANUP_PENDING", "DELETED"].includes(accepted.state)
      || !Number.isSafeInteger(input.pullRequestNumber) || input.pullRequestNumber <= 0
      || (record.pullRequestNumber && record.pullRequestNumber !== input.pullRequestNumber))
      throw new Error("Retirement requires the original confirmed replacement PR")
    const url = repo.publication.pullRequestUrlTemplate.replace("{number}", String(input.pullRequestNumber))
    await approvedReview(repo, accepted, url, signal, replacement.inspection)
    const pr = await client.readPullRequest(input.pullRequestNumber, signal)
    if (pr.url !== url || pr.target !== record.target || pr.remoteCommit !== accepted.commit
      || [record.branch, accepted.branch].includes(pr.branch)
      || (pr.state !== "completed" && await remote(repo, pr.branch, signal) !== accepted.commit))
      throw new Error("Provider verification requires the distinct inspector PR branch at the exact reviewed commit and target")
    const retirementReceipt = () => ({ ...receipt(record), pullRequest: pr,
      ...(record.cleanupError ? { cleanupError: record.cleanupError } : {}),
      ...(input.supersededBySubmissionId ? { supersededBySubmissionId: input.supersededBySubmissionId } : {}) })
    const deferCleanup = async reason => {
      record.state = "CLEANUP_PENDING"
      record.pullRequestNumber = input.pullRequestNumber
      record.cleanupError = redactSecrets(reason, [task.authToken]).slice(0, 2000)
      await save(record)
      return retirementReceipt()
    }
    try {
      const head = await remote(repo, record.branch, signal)
      if (head && (head !== record.commit || record.state === "DELETED" || record.cleanupBlocked)) {
        record.cleanupBlocked = true
        return await deferCleanup("Original submission tip changed or was recreated; no branch was deleted")
      }
      if (head) {
        record.state = "DELETING"
        record.pullRequestNumber = input.pullRequestNumber
        await save(record)
        await push(repo, record, true, signal)
        if (await remote(repo, record.branch, signal))
          return await deferCleanup("Original branch deletion is unconfirmed; reconcile provider state before retrying cleanup")
      }
    } catch (error) {
      if (signal?.aborted) throw error
      return deferCleanup(error instanceof Error ? error.message : String(error))
    }
    record.state = "DELETED"
    delete record.cleanupError
    delete record.cleanupBlocked
    record.pullRequestNumber = input.pullRequestNumber
    await save(record)
    return retirementReceipt()
  }
  let pending = Promise.resolve()
  const managed = createHostedPublicationTool({ repositories: writable, task, apiUrl, inspectorValidationGuidance,
    devboxBranchCleanup: true, pullRequestUrlsEqual: azureDevOpsUrlsEqual,
    request: (...args) => {
      const next = pending.then(() => execute(...args), () => execute(...args))
      pending = next
      return next
    } })
  return {
    tools: managed.tools,
    get registrationError() { return managed.registrationError },
    async assertCanComplete() {
      managed.assertCanComplete()
      await directory()
      for (const file of await fs.readdir(storage)) {
        if (!/^submission-publication-[a-f0-9]{64}\.json$/.test(file)) continue
        const record = await read(file.slice(0, -5))
        if (record?.deployment !== deployment || record.companyId !== task.agent.companyId
          || record.agentId !== task.agent.id || record.issueId !== issueId) continue
        const repo = writable.find(repo => repo.name === record.repositoryAlias)
        if (!repo) throw new Error("An unfinished local submission no longer has a configured writable repository")
        check(repo, record)
        if (!["CONFLICT", "CLEANUP_PENDING", "DELETED"].includes(record.state))
          throw new Error("Branch inspection is not complete. Reconcile and retire the saved local submission before marking this task done.")
      }
    },
  }
}
