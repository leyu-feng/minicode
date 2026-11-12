import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { createDevboxInspectionPublication } from "../server/devbox-inspection-publication.js"
import { publicationCommand } from "../server/pull-request-publisher.js"

const sourceUrl = "https://fixture.visualstudio.com/DefaultCollection/Project/_git/Repository"
const prUrl = "https://dev.azure.com/fixture/Project/_git/Repository/pullrequest/12"
const repositoryId = "11111111-1111-4111-8111-111111111111"
const projectId = "22222222-2222-4222-8222-222222222222"
const tenantId = "33333333-3333-4333-8333-333333333333"

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "devbox-inspection-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const source = path.join(root, "source"), workspace = path.join(root, "worker")
  const remote = path.join(root, "remote.git"), storage = path.join(root, ".workers", "worker-one", "publications")
  await fs.mkdir(source)
  await fs.mkdir(path.dirname(storage), { recursive: true })
  const git = (cwd, ...args) => publicationCommand("git", args, { cwd })
  await git(source, "init", "--initial-branch=main")
  await fs.writeFile(path.join(source, "code.txt"), "initial")
  await git(source, "add", ".")
  const commit = cwd => git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "-c", "commit.gpgsign=false", "commit", "-am", "Feature\n\nCo-Authored-By: Paperclip <noreply@paperclip.ing>")
  await commit(source)
  await git(root, "clone", "--bare", source, remote)
  await git(source, "remote", "add", "origin", sourceUrl)
  await git(source, "worktree", "add", "-b", "worker-local", workspace)
  await fs.writeFile(path.join(workspace, "code.txt"), "validated")
  await commit(workspace)
  const revision = await git(workspace, "rev-parse", "HEAD")
  await fs.writeFile(path.join(workspace, "uncommitted.txt"), "never publish")
  const task = { authToken: "private-task-token", runId: randomUUID(),
    agent: { id: randomUUID(), companyId: randomUUID(), name: "Engineer" }, context: { issueId: randomUUID() },
    prPolicy: { inspectorAgentId: randomUUID(), isInspector: false } }
  const issue = { id: task.context.issueId, companyId: task.agent.companyId, assigneeAgentId: task.agent.id,
    status: "in_progress", executionRunId: task.runId }
  const children = [], comments = [], receipts = new Map(), products = new Map(), commands = []
  const reviewComments = new Map()
  let liveInspector = task.prPolicy.inspectorAgentId, failHandoff = false, losePush = false, pushes = 0, conflict = false
  let pr = { pullRequestId: 12, status: "active",
    repository: { id: repositoryId, project: { id: projectId } },
    sourceRefName: "refs/heads/u/inspector-one/feature", targetRefName: "refs/heads/main",
    lastMergeSourceCommit: { commitId: revision } }
  const run = async (file, args, options) => {
    assert.ok(!JSON.stringify(args).includes("private-ado-token"))
    assert.ok(!JSON.stringify(options.env).includes("private-ado-token"))
    if (file === process.execPath) return JSON.stringify({ accessToken: "private-ado-token", tenantId,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), user: "fixture@example.test" })
    commands.push([...args])
    if (args.includes("push")) {
      pushes++
      if (conflict) {
        await git(workspace, "push", remote, `${revision}:${args.at(-1).split(":").at(-1)}`)
        const error = new Error("Confirmed create-only lease conflict")
        error.refConflict = true
        throw error
      }
    }
    const output = await publicationCommand(file, args.map(arg => arg === sourceUrl ? remote : arg), options)
    if (losePush && args.includes("push")) {
      losePush = false
      throw new Error("Transport failed after push; outcome unknown")
    }
    return output
  }
  const fetchImpl = async (url, options) => {
    assert.equal(options.headers.Authorization, "Bearer private-ado-token")
    assert.equal(options.redirect, "error")
    assert.equal(options.method, "GET")
    if (/\/pullrequests\/12$/.test(url.pathname)) return Response.json(pr)
    if (/\/commits\/[a-f0-9]{40}$/.test(url.pathname)) {
      const commitId = url.pathname.split("/").at(-1)
      return Response.json({ commitId, comment: await git(workspace, "show", "-s", "--format=%B", commitId) })
    }
    return Response.json({ id: repositoryId, name: "Repository",
      project: { id: projectId, name: "Project" }, remoteUrl: sourceUrl, defaultBranch: "refs/heads/main" })
  }
  t.mock.method(globalThis, "fetch", async (value, options) => {
    const url = new URL(value), route = url.pathname, body = options.body ? JSON.parse(options.body) : undefined
    assert.equal(options.headers.Authorization, `Bearer ${task.authToken}`)
    assert.equal(options.headers["X-Paperclip-Run-Id"], task.runId)
    if (route.endsWith("/pr-inspector")) return Response.json({ agentId: liveInspector })
    if (route.endsWith(`/issues/${issue.id}`)) {
      if (options.method === "PATCH") {
        Object.assign(issue, body)
        comments.push({ id: randomUUID(), body: body.comment, authorAgentId: task.agent.id, issueId: issue.id })
      }
      return Response.json(issue)
    }
    if (route.endsWith(`/issues/${issue.id}/comments`)) return Response.json(comments)
    if (route.endsWith("/agents"))
      return Response.json([{ id: task.prPolicy.inspectorAgentId, companyId: task.agent.companyId, name: "Inspector", status: "idle" }])
    if (route.endsWith(`/companies/${task.agent.companyId}/issues`)) {
      if (options.method === "GET") return Response.json(children)
      if (failHandoff) return new Response("Handoff unavailable", { status: 503 })
      const child = children.find(child => child.idempotencyKey === body.idempotencyKey)
        ?? { ...body, id: randomUUID(), companyId: task.agent.companyId, createdByAgentId: task.agent.id }
      if (!children.includes(child)) children.push(child)
      return Response.json(child)
    }
    const child = children.find(child => route === `/api/issues/${child.id}`)
    if (child) return Response.json(child)
    if (route.endsWith("/comments")) {
      const childId = route.split("/").at(-2), saved = reviewComments.get(childId) ?? []
      if (options.method === "POST") {
        saved.push({ ...body, id: randomUUID(), issueId: childId, authorAgentId: task.agent.id })
        reviewComments.set(childId, saved)
        return Response.json(saved.at(-1))
      }
      return Response.json(saved)
    }
    if (route.endsWith("/inspection-result")) return Response.json(receipts.get(route.split("/").at(-2)) ?? null)
    if (route.endsWith("/work-products")) return Response.json(products.get(route.split("/").at(-2)) ?? [])
    throw new Error(`Unexpected Paperclip route ${route}`)
  })
  const options = { repositories: [
    { name: "application", source: sourceUrl, path: workspace, branch: "main", readOnly: false },
    { name: "reference", source: sourceUrl, path: source, branch: "main", readOnly: true },
  ], storage, workerName: "worker-one", task, apiUrl: "https://clippy.example.test", server: "https://clippy.example.test",
    user: "fixture@example.test", run, fetchImpl }
  let publication = createDevboxInspectionPublication(options)
  const call = (name, input) => publication.tools.find(tool => tool.name === name).execute(input, {})
  const input = { repository: "application", commit: revision, title: "Feature", body: "Validated." }
  const recordInspection = (submission, outcome) => receipts.set(submission.reviewIssueId, {
    id: randomUUID(), result: {
      schema: "pr_inspection_result_v1", outcome, companyId: task.agent.companyId,
      inspectionIssueId: submission.reviewIssueId, sourceIssueId: issue.id, inspectorAgentId: task.prPolicy.inspectorAgentId,
      sourceAgentId: task.agent.id, runId: randomUUID(), submissionId: submission.submissionId,
      reviewedCommit: submission.remoteCommit, repositoryUrl: sourceUrl, branch: submission.branch,
    },
  })
  return { root, source, workspace, remote, storage, revision, git, task, issue, children, receipts, products, commands,
    input, options, call, recordInspection, submit: () => call("submit_branch_for_inspection", input),
    retire: receipt => call("retire_submission_branch", { repository: "application", submissionId: receipt.submissionId, url: prUrl }),
    complete: () => publication.assertCanComplete(),
    restart() {
      options.apiUrl = "http://127.0.0.1:43210"
      publication = createDevboxInspectionPublication(options)
    },
    setInspector(value) { liveInspector = value }, failHandoff(value) { failHandoff = value },
    losePush() { losePush = true }, conflict(value) { conflict = value },
    get pushes() { return pushes }, get pr() { return pr }, setPr(value) { pr = value },
    async approve(submission) {
      const review = children.find(child => child.id === submission.reviewIssueId)
      recordInspection(submission, "approved")
      products.set(review.id, [{ type: "pull_request", url: prUrl, metadata: { submissionId: submission.submissionId,
        sourceAgentId: task.agent.id, inspectionIssueId: review.id, reviewedCommit: submission.remoteCommit } }])
      pr = { ...pr, lastMergeSourceCommit: { commitId: submission.remoteCommit } }
      await git(workspace, "push", remote, `${submission.remoteCommit}:${pr.sourceRefName}`)
    },
  }
}

test("local producer submits an exact commit, reconciles handoff across restart, and retires only its verified original branch", async t => {
  const f = await fixture(t)
  const sourceHead = await f.git(f.source, "rev-parse", "HEAD")
  const status = await f.git(f.workspace, "status", "--porcelain")
  await f.git(f.workspace, "push", f.remote, `${f.revision}:refs/heads/u/worker-one/feature`)
  f.failHandoff(true)
  await assert.rejects(f.submit(), /Branch was saved, but its review-task handoff is unconfirmed/)
  await assert.rejects(f.complete(), /inspection is not complete/)
  assert.equal(f.pushes, 1)
  f.restart()
  await assert.rejects(f.complete(), /inspection is not complete/)
  f.failHandoff(false)
  const submitted = await f.submit()
  assert.equal(submitted.branch, "u/worker-one/feature-1")
  assert.equal(submitted.remoteCommit, f.revision)
  assert.equal(f.pushes, 1)
  assert.equal(f.children.length, 1)
  assert.equal(f.issue.unblockDescriptor.owner.agentId, f.task.agent.id)
  await assert.rejects(f.complete(), /inspection is not complete/)
  await assert.rejects(f.retire(submitted), /matching server-validated inspection receipt/)
  await f.approve(submitted)
  const deleted = await f.retire(submitted)
  assert.equal(deleted.state, "DELETED")
  assert.equal(deleted.pullRequest.remoteCommit, f.revision)
  assert.match(deleted.pullRequest.commitMessage, /Co-Authored-By: Paperclip/)
  assert.equal(await f.git(f.workspace, "ls-remote", "--heads", f.remote, `refs/heads/${submitted.branch}`), "")
  assert.match(await f.git(f.workspace, "ls-remote", "--heads", f.remote, f.pr.sourceRefName), new RegExp(f.revision))
  assert.match(await f.git(f.workspace, "ls-remote", "--heads", f.remote, "refs/heads/u/worker-one/feature"), new RegExp(f.revision))
  assert.equal(await f.git(f.source, "rev-parse", "HEAD"), sourceHead)
  assert.equal(await f.git(f.workspace, "status", "--porcelain"), status)
  await f.complete()
  f.restart()
  assert.equal((await f.retire(submitted)).state, "DELETED")
  assert.equal(f.pushes, 2)
})

test("an uncertain branch push is reconciled from its saved allocation without a second push", async t => {
  const f = await fixture(t)
  f.losePush()
  await assert.rejects(f.submit(), /outcome unknown/)
  f.restart()
  const saved = await f.submit()
  assert.equal(saved.branch, "u/worker-one/feature")
  assert.equal(f.pushes, 1)
  await assert.rejects(f.call("submit_branch_for_inspection", { ...f.input, body: "Changed retry." }), /same commit, title and body/)
})

test("known create-only conflicts never become owned receipts, even at the last suffix after restart", async t => {
  const f = await fixture(t)
  f.conflict(true)
  await assert.rejects(f.submit(), /All 11 worker publication branch names are occupied/)
  assert.equal(f.pushes, 11)
  f.restart()
  await f.complete()
  f.conflict(false)
  await assert.rejects(f.submit(), /All 11 worker publication branch names are occupied/)
  assert.equal(f.pushes, 11)
  assert.equal(f.children.length, 0)
})

test("local publication rejects read-only repositories, changed run/policy, redirected origins and commits outside worker HEAD", async t => {
  const f = await fixture(t)
  await assert.rejects(f.call("submit_branch_for_inspection", { ...f.input, repository: "reference" }), /writable repository/)
  f.setInspector(randomUUID())
  await assert.rejects(f.submit(), /current assigned run and unchanged company PR Inspector/)
  f.setInspector(f.task.prPolicy.inspectorAgentId)
  f.issue.executionRunId = randomUUID()
  await assert.rejects(f.submit(), /current assigned run/)
  f.issue.executionRunId = f.task.runId
  await f.git(f.workspace, "remote", "set-url", "origin", "https://dev.azure.com/other/Project/_git/Repository")
  await assert.rejects(f.submit(), /unchanged origin/)
  await f.git(f.workspace, "remote", "set-url", "origin", sourceUrl)
  await f.git(f.workspace, "checkout", "--detach", "HEAD^")
  await assert.rejects(f.submit(), /merge-base failed/)
  assert.equal(f.pushes, 0)
})

test("retirement refuses a changed original, distinct PR tip, wrong target or missing approved receipt", async t => {
  const f = await fixture(t)
  const submitted = await f.submit()
  await f.approve(submitted)
  const review = f.receipts.get(submitted.reviewIssueId)
  review.result.reviewedCommit = "a".repeat(40)
  await assert.rejects(f.retire(submitted), /matching server-validated inspection receipt/)
  review.result.reviewedCommit = f.revision
  const pr = structuredClone(f.pr)
  f.setPr({ ...pr, targetRefName: "refs/heads/other" })
  await assert.rejects(f.retire(submitted), /exact reviewed commit and target/)
  f.setPr(pr)
  const initial = await f.git(f.workspace, "rev-parse", "HEAD^")
  await f.git(f.workspace, "push", "--force", f.remote, `${initial}:${pr.sourceRefName}`)
  await assert.rejects(f.retire(submitted), /exact reviewed commit and target/)
  await f.git(f.workspace, "push", f.remote, `${f.revision}:${pr.sourceRefName}`)
  await f.git(f.workspace, "push", "--force", f.remote, `${initial}:refs/heads/${submitted.branch}`)
  await assert.rejects(f.retire(submitted), /Original submission tip changed/)
  assert.equal(f.pushes, 1)
  assert.match(await f.git(f.workspace, "ls-remote", "--heads", f.remote, `refs/heads/${submitted.branch}`), new RegExp(initial))
})

test("an uncertain deletion is reconciled after restart without deleting again or losing the completion gate", async t => {
  const f = await fixture(t)
  const submitted = await f.submit()
  await f.approve(submitted)
  f.losePush()
  await assert.rejects(f.retire(submitted), /outcome unknown/)
  f.restart()
  await assert.rejects(f.complete(), /inspection is not complete/)
  assert.equal((await f.retire(submitted)).state, "DELETED")
  assert.equal(f.pushes, 2)
  await f.complete()
})

test("a verified replacement retires its unchanged rejected predecessor without touching the inspector branch", async t => {
  const f = await fixture(t)
  const original = await f.submit()
  const review = f.children.find(child => child.id === original.reviewIssueId)
  Object.assign(review, { status: "blocked", unblockDescriptor: { owner: { agentId: f.task.prPolicy.inspectorAgentId } } })
  f.recordInspection(original, "changes_requested")
  await fs.writeFile(path.join(f.workspace, "code.txt"), "corrected")
  await f.git(f.workspace, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "-c", "commit.gpgsign=false", "commit", "-am", "Corrected feature")
  const corrected = await f.git(f.workspace, "rev-parse", "HEAD")
  const replacement = await f.call("submit_branch_for_inspection", { ...f.input, commit: corrected })
  await f.approve(replacement)
  const retired = await f.retire(replacement)
  assert.equal(retired.superseded.length, 1)
  assert.equal(retired.superseded[0].submissionId, original.submissionId)
  assert.equal(retired.superseded[0].supersededBySubmissionId, replacement.submissionId)
  for (const submission of [original, replacement])
    assert.equal(await f.git(f.workspace, "ls-remote", "--heads", f.remote, `refs/heads/${submission.branch}`), "")
  assert.match(await f.git(f.workspace, "ls-remote", "--heads", f.remote, f.pr.sourceRefName), new RegExp(corrected))
  await f.complete()
})
