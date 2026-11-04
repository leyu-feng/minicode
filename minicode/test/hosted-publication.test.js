import assert from "node:assert/strict"
import test from "node:test"
import { createPrInspectorPostback, createHostedPublicationTool } from "../server/hosted-publication.js"

const agentId = "11111111-1111-4111-8111-111111111111"
const companyId = "22222222-2222-4222-8222-222222222222"
const issueId = "33333333-3333-4333-8333-333333333333"
const inspectorId = "44444444-4444-4444-8444-444444444444"
const parentId = "55555555-5555-4555-8555-555555555555"
const submissionId = `submission-publication-${"d".repeat(64)}`
const commit = "a".repeat(40), remoteCommit = "b".repeat(40)
const inspectionInput = {
  schema: "pr_inspection_result_v1", outcome: "approved", submissionId, reviewedCommit: remoteCommit,
  body: "Reviewed the exact submitted diff.",
}
function inspectionReceipt(overrides = {}) {
  return { id: "receipt-1", body: inspectionInput.body, result: {
    schema: "pr_inspection_result_v1", outcome: "approved", companyId, inspectionIssueId: issueId,
    sourceIssueId: parentId, inspectorAgentId: inspectorId, sourceAgentId: agentId,
    runId: "66666666-6666-4666-8666-666666666666", submissionId, reviewedCommit: remoteCommit,
    repositoryUrl: "https://code.example.test/project/_git/main", branch: "u/producer-one/feature",
    ...overrides,
  } }
}

function fixture(t, isInspector = false, inspectorExists = true, separateBranch = false) {
  const task = {
    authToken: "fixture-token", runId: "fixture-run",
    agent: { id: isInspector ? inspectorId : agentId, companyId },
    context: { issueId }, prPolicy: { inspectorAgentId: inspectorExists ? inspectorId : null, isInspector },
  }
  const repositories = [{
    id: "main", name: "Main", alias: "main", readOnly: false,
    source: "https://code.example.test/project/_git/main",
    publication: {
      provider: "azure_devops", repository: "https://code.example.test/project/_git/main",
      pullRequestUrlTemplate: "https://code.example.test/project/_git/main/pullrequest/{number}",
      branchTemplate: "u/{workerName}/{feature}",
    },
  }, { id: "reference", name: "Reference", readOnly: true }]
  const products = [], comments = [], children = [], publications = []
  const receipts = new Map(isInspector || separateBranch ? [[issueId, inspectionReceipt()]] : [])
  let failHandoff = false, failRegistration = false
  let failProducerNotification = false, failCleanup = false, failSupersededNotification = false
  let failWaiting = false, sourceStatus = "in_progress", waitingWrites = 0
  let sourceUnblockDescriptor
  let liveInspector = inspectorExists
  let submitted = false
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const route = new URL(url).pathname
    const body = options.body ? JSON.parse(options.body) : undefined
    assert.equal(options.headers.Authorization, "Bearer fixture-token")
    assert.equal(options.headers["X-Paperclip-Run-Id"], task.runId)
    if (route.endsWith("/pr-inspector")) return Response.json({ agentId: liveInspector ? inspectorId : null, specialRole: "pr_inspector" })
    if (route.endsWith(`/issues/${issueId}`)) {
      if (options.method === "PATCH") {
        if (failWaiting) return new Response("Waiting state failed", { status: 503 })
        if (body.status === "blocked" && !body.unblockDescriptor)
          return Response.json({ error: "Entering blocked requires an unblockDescriptor" }, { status: 422 })
        if (body.unblockDescriptor?.owner?.agentId !== task.agent.id)
          return Response.json({ error: "Agents may only name themselves as an unblock owner" }, { status: 403 })
        sourceStatus = body.status
        sourceUnblockDescriptor = body.unblockDescriptor
        waitingWrites++
        comments.push({ body: body.comment, id: `comment-${comments.length + 1}`, issueId, authorAgentId: task.agent.id })
      }
      return Response.json({ id: issueId, companyId, assigneeAgentId: task.agent.id, status: sourceStatus,
        unblockDescriptor: sourceUnblockDescriptor,
        ...(isInspector || separateBranch ? { parentId, description: `Submission ID: ${submissionId}\nRemote commit: ${remoteCommit}\nBranch: u/producer-one/feature\nSource agent: ${agentId}\nSource task: ${parentId}\nRepository URL: ${repositories[0].source}` } : {}) })
    }
    if (route.endsWith(`/issues/${parentId}`)) return Response.json({ id: parentId, companyId, assigneeAgentId: agentId })
    if (route.endsWith("/agents")) return Response.json([{ id: inspectorId, companyId, name: "PR Inspector", status: "idle" }])
    if (route.endsWith(`/companies/${companyId}/issues`)) {
      if (options.method === "GET") return Response.json(children)
      if (failHandoff) return new Response("Handoff failed", { status: 503 })
      const saved = children.find(child => child.idempotencyKey === body.idempotencyKey)
        ?? (!body.allowDuplicate ? children.find(child => child.parentId === body.parentId
          && child.title === body.title && !["done", "cancelled"].includes(child.status)) : undefined)
      if (saved) return Response.json(saved)
      const child = { ...body, id: children.length ? `review-task-${children.length + 1}` : "review-task",
        companyId, createdByAgentId: agentId }
      children.push(child)
      return Response.json(child)
    }
    const review = children.find(child => route.endsWith(`/issues/${child.id}`))
    if (review) return Response.json(review)
    if (route.endsWith("/inspection-result")) {
      const targetIssueId = route.split("/").at(-2)
      if (options.method === "POST") {
        const existing = receipts.get(targetIssueId)
        if (existing && (existing.result.outcome !== body.outcome || existing.body !== body.body))
          return new Response("Conflicting inspection result", { status: 409 })
        if (!existing) receipts.set(targetIssueId, {
          ...inspectionReceipt(), body: body.body,
          result: { ...inspectionReceipt().result, schema: body.schema, outcome: body.outcome,
            submissionId: body.submissionId, reviewedCommit: body.reviewedCommit },
        })
      }
      return Response.json(receipts.get(targetIssueId) ?? null)
    }
    if (route.endsWith("/work-products")) {
      const targetIssueId = route.split("/").at(-2)
      if (targetIssueId === parentId) return new Response("Agent cannot mutate another agent's issue", { status: 403 })
      if (options.method === "GET") return Response.json(products.filter(product => product.issueId === targetIssueId))
      if (failRegistration) return new Response("Registration failed", { status: 503 })
      const product = { ...body, id: `product-${products.length + 1}`, issueId: targetIssueId }
      products.push(product)
      return Response.json(product)
    }
    if (route.endsWith("/work-products/product-1")) {
      Object.assign(products[0], body)
      return Response.json(products[0])
    }
    if (route.endsWith("/comments")) {
      const targetIssueId = route.split("/").at(-2)
      if (options.method === "GET") return Response.json(comments.filter(comment => comment.issueId === targetIssueId))
      if (failProducerNotification && targetIssueId === parentId) return new Response("Notification failed", { status: 503 })
      if (failSupersededNotification && targetIssueId === "rejected-review")
        return new Response("Superseded notification failed", { status: 503 })
      const comment = { ...body, id: `comment-${comments.length + 1}`, issueId: targetIssueId, authorAgentId: task.agent.id }
      comments.push(comment)
      return Response.json(comment)
    }
    throw new Error(`Unexpected API route ${route}`)
  })
  const request = async (operation, input) => {
      assert.equal(operation, "publish")
      publications.push(input)
      assert.equal(input.repositoryId, "main")
      if (input.mode === "delete_submitted_branch") {
        if (failCleanup) throw new Error("Provider verification failed")
        return { submissionId: input.submissionId,
          branch: input.supersededBySubmissionId ? "u/w01/rejected-feature" : "u/w01/feature",
          state: "DELETED", ...(input.supersededBySubmissionId ? { supersededBySubmissionId: input.supersededBySubmissionId } : {}) }
      }
      if (input.mode === "publish_pull_request") return {
        submissionId, commit, remoteCommit, branch: "u/w01/feature", provider: "azure_devops",
        repository: repositories[0].publication.repository, number: 12, state: "OPEN", isDraft: input.isDraft,
        url: repositories[0].publication.pullRequestUrlTemplate.replace("{number}", "12"),
      }
      if (input.mode === "reconcile_branch") return submitted
        ? { submissionId, commit, remoteCommit, branch: "u/w01/feature", state: "SUBMITTED" }
        : { state: "NOT_SUBMITTED" }
      assert.equal(input.mode, "submit_branch")
      submitted = true
      return { submissionId, commit, remoteCommit, branch: "u/w01/feature", state: "SUBMITTED" }
    }
  const publication = separateBranch ? createPrInspectorPostback({
    task, apiUrl: "https://paperclip.example.test", separateBranch: true, workerName: "reviewer-one",
  }) : createHostedPublicationTool({
    repositories, task, apiUrl: "https://paperclip.example.test", request,
  })
  return {
    publication, publications, children, products, comments, task, repositories, receipts,
    tool: name => publication.tools.find(tool => tool.name === name),
    failHandoff: value => { failHandoff = value },
    failRegistration: value => { failRegistration = value },
    liveInspector: value => { liveInspector = value },
    failProducerNotification: value => { failProducerNotification = value },
    failCleanup: value => { failCleanup = value },
    failSupersededNotification: value => { failSupersededNotification = value },
    failWaiting: value => { failWaiting = value },
    get sourceStatus() { return sourceStatus },
    get waitingWrites() { return waitingWrites },
    get sourceUnblockDescriptor() { return sourceUnblockDescriptor },
  }
}

test("ordinary agents receive branch submission and owned retirement, handing off idempotently without creating a PR", async t => {
  const f = fixture(t)
  assert.deepEqual(f.publication.tools.map(tool => tool.name), ["submit_branch_for_inspection", "retire_submission_branch"])
  const input = { repository: "main", commit, title: "Feature", body: "Review this change." }
  const receipt = await f.tool("submit_branch_for_inspection").execute(input)
  assert.equal(receipt.reviewIssueId, "review-task")
  assert.equal(receipt.waitingForInspection, true)
  assert.equal(f.sourceStatus, "blocked")
  assert.deepEqual(f.sourceUnblockDescriptor.owner, { agentId })
  assert.ok(f.sourceUnblockDescriptor.action.includes("review-task"))
  assert.equal(f.children[0].assigneeAgentId, inspectorId)
  assert.ok(f.children[0].description.includes(submissionId))
  assert.ok(f.children[0].description.includes(`Repository URL: ${f.repositories[0].source}`))
  assert.ok(f.children[0].description.includes("Branch: u/w01/feature"))
  assert.ok(f.children[0].description.includes(`Remote commit: ${remoteCommit}`))
  assert.equal(f.publications.find(call => call.mode === "submit_branch").readableBranchNames, true)
  await f.tool("submit_branch_for_inspection").execute(input)
  assert.equal(f.children.length, 1)
  assert.equal(f.waitingWrites, 1)
  assert.equal(f.publications.filter(call => call.mode === "submit_branch").length, 1)
  assert.equal(f.products.length, 0)
  assert.equal(f.publication.registrationError, null)
  assert.throws(() => f.publication.assertCanComplete(), /retire_submission_branch/)
  await f.tool("retire_submission_branch").execute({
    repository: "main", submissionId,
    url: f.repositories[0].publication.pullRequestUrlTemplate.replace("{number}", "12"),
  })
  f.publication.assertCanComplete()
})

test("a corrected submission creates a separate same-title review and retries only that submission", async t => {
  const f = fixture(t)
  const rejected = {
    id: "rejected-review", companyId, parentId: issueId, assigneeAgentId: inspectorId,
    createdByAgentId: agentId, status: "blocked", priority: "medium",
    title: "Review PR: Feature", description: "Review the rejected original submission.",
    idempotencyKey: `worker-child:${issueId}:rejected-submission`,
  }
  f.children.push({ ...rejected })
  const input = { repository: "main", commit, title: "Feature", body: "Review the corrected commit." }
  const receipt = await f.tool("submit_branch_for_inspection").execute(input)
  assert.notEqual(receipt.reviewIssueId, rejected.id)
  assert.equal(f.children.length, 2)
  assert.deepEqual(f.children[0], rejected)
  assert.ok(f.children[1].description.includes(`Submission ID: ${submissionId}`))
  assert.ok(f.children[1].description.includes(`Remote commit: ${remoteCommit}`))
  assert.equal(f.children[1].assigneeAgentId, inspectorId)
  assert.equal(f.sourceStatus, "blocked")
  assert.equal((await f.tool("submit_branch_for_inspection").execute(input)).reviewIssueId, receipt.reviewIssueId)
  assert.equal(f.children.length, 2)
  assert.equal(f.publications.filter(call => call.mode === "submit_branch").length, 1)
  assert.equal(f.publication.registrationError, null)
})

test("an existing submission key bound to a different review still requires explicit reconciliation", async t => {
  const f = fixture(t)
  const conflicting = {
    id: "rejected-review", companyId, parentId: issueId, assigneeAgentId: inspectorId,
    createdByAgentId: agentId, status: "blocked", priority: "medium",
    title: "Review PR: Feature", description: "Review the rejected original submission.",
    idempotencyKey: `worker-child:${issueId}:${submissionId}`,
  }
  f.children.push({ ...conflicting })
  const input = { repository: "main", commit, title: "Feature", body: "Review the corrected commit." }
  await assert.rejects(f.tool("submit_branch_for_inspection").execute(input), /did not confirm the requested child/)
  assert.deepEqual(f.children, [conflicting])
  assert.match(f.publication.registrationError, /handoff is incomplete/)
  assert.throws(() => f.publication.assertCanComplete(), /not complete/)
})

test("no inspector allows direct PR publication and reconciles registration with identical inputs", async t => {
  const f = fixture(t, false, false)
  assert.deepEqual(f.publication.tools.map(tool => tool.name), ["publish_pull_request"])
  const input = { repository: "main", commit, title: "Feature", body: "Review", isDraft: true }
  f.failRegistration(true)
  await assert.rejects(f.tool("publish_pull_request").execute(input), /PR exists.*registration is incomplete/)
  assert.match(f.publication.registrationError, /registration is incomplete/)
  f.failRegistration(false)
  const receipt = await f.tool("publish_pull_request").execute(input)
  assert.equal(receipt.number, 12)
  assert.equal(f.products[0].status, "draft")
  assert.equal(f.publications.at(-1).mode, "publish_pull_request")
  assert.equal(f.publications.at(-1).readableBranchNames, true)
  assert.equal(f.publication.registrationError, null)
  await assert.rejects(f.tool("publish_pull_request").execute({ ...input, body: "Different" }), /same title, body/)
  await f.tool("publish_pull_request").execute(input)
  assert.equal(f.publications.at(-1).existingOnly, true)
  assert.equal(f.products.length, 1)
  assert.equal(f.comments.length, 1)
  assert.equal(f.children.length, 0)
})

test("missing assignment policy and newly created inspector prevent direct provider mutation", async t => {
  const f = fixture(t, false, false)
  const input = { repository: "main", commit, title: "Feature", body: "Review" }
  f.liveInspector(true)
  await assert.rejects(f.tool("publish_pull_request").execute(input), /PR Inspector exists/)
  delete f.task.prPolicy
  await assert.rejects(f.tool("publish_pull_request").execute(input), /trusted assignment/)
  assert.equal(f.publications.length, 0)
})

test("Devbox inspector records an external PR link without provider calls or provider credentials", async t => {
  const f = fixture(t, true)
  assert.deepEqual(f.publication.tools.map(tool => tool.name), ["record_inspection_result", "record_pull_request"])
  const input = { url: "https://code.example.test/project/_git/main/pullrequest/12", title: "Feature", provider: "azure_devops" }
  const receipt = await f.tool("record_pull_request").execute(input)
  assert.equal(receipt.url, input.url)
  assert.equal(receipt.verification, "not_verified")
  await f.tool("record_pull_request").execute(input)
  assert.equal(f.publications.length, 0)
  assert.equal(f.products.length, 1)
  assert.equal(f.comments.length, 1)
  assert.equal(f.products[0].metadata.publicationMode, "external")
})

test("failed review handoff stays an execution failure until the same submission reconciles", async t => {
  const f = fixture(t)
  const input = { repository: "main", commit, title: "Feature", body: "Review" }
  f.failHandoff(true)
  await assert.rejects(f.tool("submit_branch_for_inspection").execute(input), /saved.*handoff is unconfirmed/)
  assert.match(f.publication.registrationError, /handoff is incomplete/)
  assert.match(f.publication.registrationError, /HTTP 503/)
  assert.throws(() => f.publication.assertCanComplete(), /not complete/)
  f.failHandoff(false)
  await f.tool("submit_branch_for_inspection").execute(input)
  assert.equal(f.publication.registrationError, null)
  assert.equal(f.children.length, 1)
})

test("an unconfirmed source waiting state fails handoff and retries the same child before releasing the source assignment", async t => {
  const f = fixture(t)
  const input = { repository: "main", commit, title: "Feature", body: "Review" }
  f.failWaiting(true)
  await assert.rejects(f.tool("submit_branch_for_inspection").execute(input), /handoff is unconfirmed/)
  assert.equal(f.children.length, 1)
  assert.equal(f.sourceStatus, "in_progress")
  assert.match(f.publication.registrationError, /handoff is incomplete/)
  f.failWaiting(false)
  await f.tool("submit_branch_for_inspection").execute(input)
  assert.equal(f.children.length, 1)
  assert.equal(f.sourceStatus, "blocked")
  assert.equal(f.publication.registrationError, null)
})
test("external PR postback rejects unsafe links, credentials and task overrides", async t => {
  const f = fixture(t, true)
  const input = { url: "https://code.example.test/pull/12", title: "Feature", provider: "azure_devops" }
  await assert.rejects(f.tool("record_pull_request").execute({ ...input, url: "https://secret@code.example.test/pull/12" }), /without credentials/)
  await assert.rejects(f.tool("record_pull_request").execute({ ...input, issueId: "other-task" }), /only a URL/)
  await assert.rejects(f.tool("record_pull_request").execute({ ...input, credentials: "secret" }), /only a URL/)
  const unassigned = createPrInspectorPostback({ task: { ...f.task, context: {} }, apiUrl: "https://paperclip.example.test" })
  await assert.rejects(unassigned.tools.find(tool => tool.name === "record_pull_request").execute(input), /assigned Paperclip issue/)
  assert.equal(f.publications.length, 0)
  assert.equal(f.products.length, 0)
})

test("external PR postback failures remain execution failures until the same link reconciles", async t => {
  const f = fixture(t, true)
  const input = { url: "https://code.example.test/pull/12", title: "Feature", provider: "azure_devops" }
  f.failRegistration(true)
  await assert.rejects(f.tool("record_pull_request").execute(input), /HTTP 503/)
  assert.match(f.publication.registrationError, /postback is incomplete/)
  f.failRegistration(false)
  await f.tool("record_pull_request").execute(input)
  assert.equal(f.publication.registrationError, null)
  assert.equal(f.publications.length, 0)
})

test("separate inspector PR postback returns the link to the producer and reconciles a partial notification without duplicates", async t => {
  const f = fixture(t, true, true, true)
  const input = { url: "https://code.example.test/project/_git/main/pullrequest/12", title: "Feature",
    provider: "azure_devops", submissionId, branch: "u/reviewer-one/feature", reviewedCommit: remoteCommit }
  f.failProducerNotification(true)
  await assert.rejects(f.tool("record_pull_request").execute(input), /HTTP 503/)
  assert.match(f.publication.registrationError, /postback is incomplete/)
  assert.equal(f.products.length, 1)
  f.failProducerNotification(false)
  const receipt = await f.tool("record_pull_request").execute(input)
  assert.equal(receipt.producer.issueId, parentId)
  assert.equal(receipt.verification, "not_verified")
  await f.tool("record_pull_request").execute(input)
  assert.equal(f.products.length, 1)
  assert.equal(f.comments.length, 2)
  assert.ok(f.comments.find(comment => comment.issueId === parentId).body.includes("retire_submission_branch"))
  assert.equal(f.products[0].metadata.sourceAgentId, agentId)
  assert.equal(f.publications.length, 0)
  assert.equal(f.publication.registrationError, null)
})

test("separate inspector postback rejects another worker namespace and an unreviewed commit before notifying the producer", async t => {
  const f = fixture(t, true, true, true)
  const input = { url: "https://code.example.test/project/_git/main/pullrequest/12", title: "Feature",
    provider: "azure_devops", submissionId, branch: "u/reviewer-one/feature", reviewedCommit: remoteCommit }
  await assert.rejects(f.tool("record_pull_request").execute({ ...input, branch: "u/producer-one/feature" }), /separate inspector-owned/)
  await assert.rejects(f.tool("record_pull_request").execute({ ...input, reviewedCommit: commit }), /separate inspector-owned/)
  assert.equal(f.products.length, 0)
  assert.equal(f.comments.length, 0)
})

test("producer retirement is repository-bound, fails explicitly and reconciles only the same PR link", async t => {
  const f = fixture(t)
  const tool = f.tool("retire_submission_branch")
  const input = { repository: "main", submissionId, url: "https://code.example.test/project/_git/main/pullrequest/12" }
  await assert.rejects(tool.execute({ ...input, url: "https://other.example.test/pullrequest/12" }), /configured repository/)
  assert.equal(f.publications.length, 0)
  f.failCleanup(true)
  await assert.rejects(tool.execute(input), /verification failed/)
  assert.match(f.publication.registrationError, /cleanup is unconfirmed/)
  await assert.rejects(tool.execute({ ...input, url: input.url.replace("/12", "/13") }), /same original PR/)
  f.failCleanup(false)
  assert.equal((await tool.execute(input)).state, "DELETED")
  assert.equal(f.publications.at(-1).pullRequestNumber, 12)
  assert.equal(f.publication.registrationError, null)
})

async function supersessionFixture(t) {
  const f = fixture(t)
  await f.tool("submit_branch_for_inspection").execute({ repository: "main", commit, title: "Feature", body: "Review" })
  const accepted = f.children[0]
  accepted.status = "done"
  const previous = `submission-publication-${"e".repeat(64)}`
  const rejectedCommit = "c".repeat(40)
  const rejected = {
    ...accepted, id: "rejected-review", status: "blocked",
    description: accepted.description.replace(submissionId, previous).replace(remoteCommit, rejectedCommit)
      .replace("u/w01/feature", "u/w01/rejected-feature"),
    unblockDescriptor: { owner: { agentId: inspectorId }, action: "Reinspect after correction." },
  }
  f.children.push(rejected)
  f.comments.push({ id: "findings", issueId, authorAgentId: inspectorId,
    body: `Changes requested for ${previous}, reviewed commit ${rejectedCommit}.` })
  f.receipts.set(accepted.id, inspectionReceipt({
    inspectionIssueId: accepted.id, sourceIssueId: issueId, branch: "u/w01/feature",
  }))
  f.receipts.set(rejected.id, inspectionReceipt({
    outcome: "changes_requested", inspectionIssueId: rejected.id, sourceIssueId: issueId,
    submissionId: previous, reviewedCommit: rejectedCommit, branch: "u/w01/rejected-feature",
  }))
  const url = "https://code.example.test/project/_git/main/pullrequest/12"
  f.products.push({ id: "accepted-pr", issueId: accepted.id, type: "pull_request", url,
    metadata: { submissionId, sourceAgentId: agentId, inspectionIssueId: accepted.id, reviewedCommit: remoteCommit } })
  return { ...f, rejected, previous, input: { repository: "main", submissionId, url } }
}

test("accepted retirement automatically retires rejected same-task submissions and requests inspector-owned closure", async t => {
  const f = await supersessionFixture(t)
  const receipt = await f.tool("retire_submission_branch").execute(f.input)
  assert.equal(receipt.superseded.length, 1)
  assert.equal(receipt.superseded[0].submissionId, f.previous)
  assert.equal(receipt.superseded[0].reviewIssueId, f.rejected.id)
  assert.deepEqual(f.publications.filter(call => call.mode === "delete_submitted_branch").map(call => ({
    submissionId: call.submissionId, supersededBySubmissionId: call.supersededBySubmissionId,
  })), [{ submissionId, supersededBySubmissionId: undefined }, { submissionId: f.previous, supersededBySubmissionId: submissionId }])
  const notifications = () => f.comments.filter(comment => comment.issueId === f.rejected.id)
  assert.equal(notifications().length, 1)
  assert.equal(notifications()[0].authorAgentId, agentId)
  assert.match(notifications()[0].body, /superseded-submission:/)
  assert.equal(f.rejected.status, "blocked")
  f.publication.assertCanComplete()
  await f.tool("retire_submission_branch").execute(f.input)
  assert.equal(notifications().length, 1)
})

test("partial superseded cleanup remains an explicit failure and reconciles without duplicate notifications", async t => {
  const f = await supersessionFixture(t)
  f.failSupersededNotification(true)
  await assert.rejects(f.tool("retire_submission_branch").execute(f.input), /HTTP 503/)
  assert.match(f.publication.registrationError, /cleanup is unconfirmed/)
  assert.throws(() => f.publication.assertCanComplete(), /not complete/)
  f.failSupersededNotification(false)
  await f.tool("retire_submission_branch").execute(f.input)
  assert.equal(f.comments.filter(comment => comment.issueId === f.rejected.id).length, 1)
  assert.equal(f.publication.registrationError, null)
  f.publication.assertCanComplete()
})

test("supersession never retires foreign, active, unpublished, or unconfirmed inspections", async t => {
  for (const mismatch of ["parent", "company", "producer", "busy", "has-pr", "missing-receipt", "replacement-commit"]) {
    await t.test(mismatch, async t => {
      const f = await supersessionFixture(t)
      if (mismatch === "parent") f.rejected.parentId = parentId
      if (mismatch === "company") f.rejected.companyId = "other-company"
      if (mismatch === "producer") f.rejected.createdByAgentId = inspectorId
      if (mismatch === "busy") f.rejected.executionRunId = "active-run"
      if (mismatch === "has-pr") f.products.push({ issueId: f.rejected.id, type: "pull_request", url: f.input.url })
      if (mismatch === "missing-receipt") f.receipts.delete(f.rejected.id)
      if (mismatch === "replacement-commit") f.products[0].metadata.reviewedCommit = commit
      await assert.rejects(f.tool("retire_submission_branch").execute(f.input), /Supersession|Retain the earlier|invalid assigned-issue child list|inspection receipt/)
      assert.equal(f.publications.filter(call => call.supersededBySubmissionId).length, 0)
      assert.equal(f.comments.filter(comment => comment.issueId === f.rejected.id).length, 0)
    })
  }
})

test("read-only repositories and credential-bearing publication descriptors are rejected", async t => {
  const f = fixture(t)
  const input = { repository: "Reference", commit, title: "Feature", body: "Review" }
  await assert.rejects(f.tool("submit_branch_for_inspection").execute(input), /writable repository/)
  f.repositories[0].publication.pullRequestUrlTemplate = "https://secret@code.example.test/pull/{number}"
  await assert.rejects(f.tool("submit_branch_for_inspection").execute({ ...input, repository: "main" }), /HTTPS publication descriptor/)
  assert.equal(f.publications.length, 0)
})

test("structured rejection records arbitrary findings and reconciles failed parent delivery without another receipt", async t => {
  const f = fixture(t, true, true, true)
  f.receipts.clear()
  const input = { ...inspectionInput, outcome: "changes_requested", body: "## Changes requested\n\nPlease preserve the blank line." }
  f.failProducerNotification(true)
  await assert.rejects(f.tool("record_inspection_result").execute(input), /HTTP 503/)
  assert.match(f.publication.registrationError, /findings delivery is unconfirmed/)
  assert.equal(f.receipts.size, 1)
  assert.equal(f.comments.length, 1)
  f.failProducerNotification(false)
  const receipt = await f.tool("record_inspection_result").execute(input)
  assert.equal(receipt.result.outcome, "changes_requested")
  assert.equal(f.comments.length, 2)
  assert.ok(f.comments.find(comment => comment.issueId === parentId).body.includes(input.body))
  assert.equal(f.publication.registrationError, null)
  await f.tool("record_inspection_result").execute(input)
  assert.equal(f.comments.length, 2)
  await assert.rejects(f.tool("record_inspection_result").execute({ ...input, outcome: "approved" }), /HTTP 409/)
})

test("inspection tools reject unknown schemas, actor overrides, wrong commits and missing approval receipts", async t => {
  const f = fixture(t, true, true, true)
  await assert.rejects(f.tool("record_inspection_result").execute({ ...inspectionInput, schema: "unknown" }), /versioned inspection/)
  await assert.rejects(f.tool("record_inspection_result").execute({ ...inspectionInput, inspectorAgentId: agentId }), /versioned inspection/)
  await assert.rejects(f.tool("record_inspection_result").execute({ ...inspectionInput, reviewedCommit: commit }), /original submission/)
  f.receipts.clear()
  await assert.rejects(f.tool("record_pull_request").execute({
    url: "https://code.example.test/project/_git/main/pullrequest/12", title: "Feature",
    provider: "azure_devops", submissionId, branch: "u/reviewer-one/feature", reviewedCommit: remoteCommit,
  }), /server-validated inspection receipt/)
  assert.equal(f.products.length, 0)
  assert.equal(f.comments.length, 0)
})

test("supersession uses typed receipts, independent of Markdown, localization or absent parent findings", async t => {
  for (const body of ["## Changes requested\n\nPlease fix this.", "Bitte die Leerzeile beibehalten.", ""]) {
    await t.test(body || "no comment", async t => {
      const f = await supersessionFixture(t)
      f.comments.length = 0
      if (body) f.comments.push({ issueId, authorAgentId: inspectorId, body })
      assert.equal((await f.tool("retire_submission_branch").execute(f.input)).superseded.length, 1)
    })
  }
})

test("supersession rejects receipt provenance mismatches and never guesses a receipt from prose", async t => {
  const mismatches = {
    schema: "unknown", outcome: "approved", companyId: "foreign-company",
    inspectionIssueId: "foreign-review", sourceIssueId: parentId, inspectorAgentId: agentId,
    sourceAgentId: inspectorId, runId: "", submissionId, reviewedCommit: commit,
    repositoryUrl: "https://other.example.test/repository", branch: "u/other/branch",
  }
  for (const [key, value] of Object.entries(mismatches)) {
    await t.test(key, async t => {
      const f = await supersessionFixture(t)
      f.receipts.get(f.rejected.id).result[key] = value
      await assert.rejects(f.tool("retire_submission_branch").execute(f.input), /server-validated inspection receipt/)
      assert.equal(f.publications.filter(call => call.supersededBySubmissionId).length, 0)
    })
  }
})
