import assert from "node:assert/strict"
import test from "node:test"
import { createPaperclipTaskTools } from "../server/paperclip-task-tools.js"

const scope = {
  apiUrl: "https://paperclip.example/bridge-prefix", authToken: "private-run-token",
  runId: "run", issueId: "assigned-issue", agentId: "agent", companyId: "company",
}
const original = { id: scope.issueId, companyId: scope.companyId, assigneeAgentId: scope.agentId, status: "in_progress" }
const context = { signal: new AbortController().signal }
const assignee = { id: "12345678-1234-1234-1234-123456789abc", companyId: scope.companyId, name: "Coder", role: "engineer", status: "idle" }
const childInput = {
  title: "Fix observed exception", description: "Evidence and acceptance criteria.",
  assigneeAgentId: assignee.id, priority: "high", idempotencyKey: "exception-01",
}
const child = { ...childInput, id: "child", companyId: scope.companyId, parentId: scope.issueId, status: "todo" }

function tools() {
  return Object.fromEntries(createPaperclipTaskTools(scope).map(tool => [tool.name, tool]))
}

test("task tools use the fixed assignment, preserve proxy prefixes and confirm comment/status writes", async t => {
  let issue = { ...original }
  const comments = []
  const requests = []
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, ...options })
    assert.equal(options.headers.Authorization, `Bearer ${scope.authToken}`)
    assert.equal(options.headers["X-Paperclip-Run-Id"], scope.runId)
    assert.equal(options.redirect, "error")
    assert.ok(url.startsWith(`${scope.apiUrl}/api/issues/${scope.issueId}`)
      || url.startsWith(`${scope.apiUrl}/api/companies/${scope.companyId}/issues?parentId=${scope.issueId}`))
    if (url.includes("/companies/")) return Response.json([])
    const body = options.body && JSON.parse(options.body)
    if (options.method === "PATCH") issue = { ...issue, status: body.status }
    if (options.method === "POST") {
      const saved = { id: "comment", issueId: scope.issueId, authorAgentId: scope.agentId, body: body.body }
      comments.push(saved)
      return Response.json(saved)
    }
    return Response.json(url.includes("/comments") ? comments : issue)
  })
  const available = tools()
  assert.ok(!JSON.stringify(Object.values(available)).includes(scope.authToken))
  assert.deepEqual(await available.paperclip_get_issue.execute({}, context), { issue: original, comments: [], children: [] })
  assert.equal(issue.status, "in_progress")
  const saved = await available.paperclip_add_comment.execute({ body: "Findings\n\nVerified." }, context)
  assert.equal(saved.body, "Findings\n\nVerified.")
  assert.equal(issue.status, "in_progress", "A comment alone must never close the task")
  const updated = await available.paperclip_update_issue.execute({ status: "done", comment: "Acceptance criteria verified." }, context)
  assert.equal(updated.status, "done")
  assert.deepEqual(requests.at(-1).body, JSON.stringify({ status: "done", comment: "Acceptance criteria verified." }))
  assert.equal(requests.filter(request => request.method !== "GET").length, 2)
})

test("task tools reject extra scope/auth arguments and invalid writes before making requests", async t => {
  t.mock.method(globalThis, "fetch", () => assert.fail("Invalid tool arguments must not reach the API"))
  const available = tools()
  await assert.rejects(available.paperclip_get_issue.execute({ issueId: "other" }, context), /harness-owned/)
  for (const input of [
    { status: "done", comment: "Completed", issueId: "other" },
    { status: "done", comment: "Completed", headers: {} },
    { status: "done", comment: "" },
    { status: "done", comment: "x".repeat(16001) },
    { status: "unknown", comment: "Completed" },
  ]) await assert.rejects(available.paperclip_update_issue.execute(input, context), /arguments|comment|status/)
})

test("blocked updates preserve an explicit unblock owner/action and reject unconfirmed waiting metadata", async t => {
  let confirm = true
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    if (options.method === "GET") return Response.json(original)
    const body = JSON.parse(options.body)
    return Response.json({ ...original, status: body.status,
      ...(confirm ? { unblockDescriptor: body.unblockDescriptor } : {}) })
  })
  const descriptor = { owner: { agentId: scope.agentId }, action: "Reinspect after the producer returns a corrected submission." }
  const saved = await tools().paperclip_update_issue.execute({
    status: "blocked", comment: "Waiting for correction.", unblockDescriptor: descriptor,
  }, context)
  assert.deepEqual(saved.unblockDescriptor, descriptor)
  confirm = false
  await assert.rejects(tools().paperclip_update_issue.execute({
    status: "blocked", comment: "Waiting.", unblockDescriptor: { owner: { agentId: scope.agentId }, action: "Review findings." },
  }, context), /did not confirm the requested unblock/)
})

test("invalid unblock descriptors cannot send mutations or scope overrides", async t => {
  t.mock.method(globalThis, "fetch", () => assert.fail("Invalid descriptors must not reach Paperclip"))
  for (const descriptor of [
    {}, [], { owner: "board", action: " " }, { owner: "board", action: "x".repeat(2001) },
    { owner: { agentId: [assignee.id] }, action: "Review." },
    { owner: { agentId: assignee.id, userId: "reviewer" }, action: "Review." },
    { owner: { agentId: "not-a-uuid" }, action: "Review." },
    { owner: { agentId: assignee.id }, action: "Review." },
    { owner: { userId: "reviewer" }, action: "Review." },
    { owner: "board", action: "Review." },
    { owner: "other", action: "Review." },
    { owner: "board", action: "Review.", companyId: "other" },
  ]) await assert.rejects(tools().paperclip_update_issue.execute({
    status: "blocked", comment: "Waiting.", unblockDescriptor: descriptor,
  }, context), /arguments|action|owner/)
  await assert.rejects(tools().paperclip_update_issue.execute({
    status: "done", comment: "Complete.", unblockDescriptor: { owner: "board", action: "Review." },
  }, context), /requires blocked/)
})

test("completion guards reject premature done before any status write", async t => {
  let guarded = false
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.method, "GET")
    return Response.json(original)
  })
  const available = createPaperclipTaskTools({ ...scope, assertCanComplete() {
    guarded = true
    throw new Error("Inspection and owned branch cleanup are incomplete")
  } })
  await assert.rejects(available.find(tool => tool.name === "paperclip_update_issue").execute({
    status: "done", comment: "The review child was created.",
  }, context), /cleanup are incomplete/)
  assert.equal(guarded, true)
})

test("parent reports reconcile uncertain saves without delegating back or changing parent state", async t => {
  const parentId = "23456789-1234-1234-1234-123456789abc"
  const comments = []
  let writes = 0, parentStatus = "blocked"
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.endsWith(`/${scope.issueId}`)) return Response.json({ ...original, parentId })
    if (url.endsWith(`/${parentId}`)) return Response.json({ id: parentId, companyId: scope.companyId, status: parentStatus })
    assert.equal(url, `${scope.apiUrl}/api/issues/${parentId}/comments`)
    if (options.method === "GET") return Response.json(comments)
    assert.equal(options.method, "POST")
    writes++
    comments.push({ id: "parent-report", issueId: parentId, authorAgentId: scope.agentId,
      body: JSON.parse(options.body).body })
    throw new Error("Response lost after save")
  })
  const report = tools().paperclip_report_to_parent
  const input = { body: "Reviewed the exact submission. Correct the missing blank line and resubmit." }
  await assert.rejects(report.execute(input, context), /outcome may be unknown/)
  assert.equal(writes, 1)
  const receipt = await report.execute(input, context)
  assert.equal(receipt.commentId, "parent-report")
  assert.equal(receipt.requiresOperatorReopen, false)
  parentStatus = "done"
  assert.equal((await report.execute(input, context)).requiresOperatorReopen, true)
  assert.equal(writes, 1)
})

test("parent reporting refuses missing, foreign, or unconfirmed parents before any write", async t => {
  const parentId = "23456789-1234-1234-1234-123456789abc"
  let issue = { ...original }, parent = { id: parentId, companyId: "other" }
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(options.method, "GET")
    return Response.json(url.endsWith(`/${scope.issueId}`) ? issue : parent)
  })
  const report = tools().paperclip_report_to_parent
  await assert.rejects(report.execute({ body: "Findings." }, context), /no valid direct parent/)
  issue = { ...original, parentId }
  await assert.rejects(report.execute({ body: "Findings." }, context), /direct parent in this company/)
  parent = { id: "different-parent", companyId: scope.companyId }
  await assert.rejects(report.execute({ body: "Findings." }, context), /direct parent in this company/)
  await assert.rejects(report.execute({ body: "Findings.", parentId }, context), /harness-owned/)
})

for (const field of ["id", "companyId", "assigneeAgentId"]) {
  test(`task tools refuse foreign ${field} before any mutation`, async t => {
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      assert.equal(options.method, "GET")
      return Response.json({ ...original, [field]: "other" })
    })
    await assert.rejects(tools().paperclip_update_issue.execute({ status: "done", comment: "Complete" }, context), /assigned to this agent/)
  })
}

for (const status of [401, 403, 409]) {
  test(`task tools surface HTTP ${status} without retrying or leaking authentication`, async t => {
    let writes = 0
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      if (options.method === "GET") return Response.json(original)
      writes++
      return Response.json({ error: `Denied ${scope.authToken}` }, { status })
    })
    await assert.rejects(tools().paperclip_update_issue.execute({ status: "done", comment: "Complete" }, context), error => {
      assert.ok(error.message.includes(`HTTP ${status}`))
      assert.ok(!error.message.includes(scope.authToken))
      return true
    })
    assert.equal(writes, 1)
  })
}

test("an uncertain mutation is not replayed; a subsequent read exposes its actual outcome", async t => {
  let issue = { ...original }
  let writes = 0
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (options.method === "PATCH") {
      writes++
      issue.status = "done"
      throw new Error("Connection lost after request")
    }
    return Response.json(url.includes("/comments") || url.includes("/companies/") ? [] : issue)
  })
  const available = tools()
  await assert.rejects(available.paperclip_update_issue.execute({ status: "done", comment: "Complete" }, context), /outcome may be unknown/)
  assert.equal((await available.paperclip_get_issue.execute({}, context)).issue.status, "done")
  assert.equal(writes, 1)
})

for (const result of [{}, { ...original, status: "in_review" }, "not JSON"]) {
  test(`unconfirmed status response is not reported as completion: ${JSON.stringify(result)}`, async t => {
    t.mock.method(globalThis, "fetch", async (_url, options) => options.method === "GET"
      ? Response.json(original)
      : typeof result === "string" ? new Response(result) : Response.json(result))
    await assert.rejects(tools().paperclip_update_issue.execute({ status: "done", comment: "Complete" }, context),
      /did not confirm|was not confirmed|did not return valid JSON/)
  })
}

test("unconfirmed comments and cancelled calls fail explicitly", async t => {
  t.mock.method(globalThis, "fetch", async (_url, options) => options.method === "GET"
    ? Response.json(original) : Response.json({ id: "unbound-comment" }))
  await assert.rejects(tools().paperclip_add_comment.execute({ body: "Findings" }, context), /did not confirm the saved comment/)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(tools().paperclip_get_issue.execute({}, { signal: controller.signal }), { name: "AbortError" })
})

test("company lookup omits configuration and child creation confirms fixed scope and assignee", async t => {
  const requests = []
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, ...options })
    assert.equal(options.headers.Authorization, `Bearer ${scope.authToken}`)
    assert.equal(options.headers["X-Paperclip-Run-Id"], scope.runId)
    assert.equal(options.redirect, "error")
    if (url.endsWith("/agents")) return Response.json([{ ...assignee, adapterConfig: { secret: "not-for-model" } }])
    return Response.json(options.method === "POST" ? child : original)
  })
  const available = tools()
  assert.deepEqual(await available.paperclip_list_agents.execute({}, context),
    [{ id: assignee.id, name: assignee.name, role: assignee.role, status: assignee.status }])
  assert.deepEqual(await available.paperclip_create_issue.execute(childInput, context), child)
  assert.equal(requests.at(-1).url, `${scope.apiUrl}/api/companies/${scope.companyId}/issues`)
  assert.deepEqual(JSON.parse(requests.at(-1).body), {
    title: childInput.title, description: childInput.description, priority: childInput.priority,
    assigneeAgentId: assignee.id, parentId: scope.issueId, status: "todo",
    idempotencyKey: `worker-child:${scope.issueId}:${childInput.idempotencyKey}`,
  })
})

test("child creation rejects invalid input and scope overrides before any API call", async t => {
  t.mock.method(globalThis, "fetch", () => assert.fail("Invalid arguments must not reach Paperclip"))
  for (const override of [
    { parentId: "other" }, { companyId: "other" }, { authToken: "other" }, { status: "done" },
    { title: " " }, { description: "" }, { assigneeAgentId: "not-a-uuid" }, { assigneeAgentId: [assignee.id] },
    { priority: "invalid" }, { idempotencyKey: "../other" }, { idempotencyKey: "x".repeat(129) },
  ]) await assert.rejects(tools().paperclip_create_issue.execute({ ...childInput, ...override }, context),
    /arguments|title|description|assignee|priority|idempotencyKey/)
  await assert.rejects(tools().paperclip_list_agents.execute({ companyId: "other" }, context), /harness-owned/)
})

test("directory and creation reject foreign assignments and company-agent responses without writes", async t => {
  let issue = original
  let directory = [{ ...assignee, companyId: "other" }]
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(options.method, "GET")
    return Response.json(url.endsWith("/agents") ? directory : issue)
  })
  const available = tools()
  await assert.rejects(available.paperclip_list_agents.execute({}, context), /company-agent directory/)
  await assert.rejects(available.paperclip_create_issue.execute(childInput, context), /company-agent directory/)
  directory = []
  await assert.rejects(available.paperclip_create_issue.execute(childInput, context), /not in this assignment's company/)
  issue = { ...original, assigneeAgentId: "other" }
  await assert.rejects(available.paperclip_create_issue.execute(childInput, context), /assigned to this agent/)
  await assert.rejects(available.paperclip_list_agents.execute({}, context), /assigned to this agent/)
})

test("an uncertain child creation is not replayed and its saved child can be reconciled", async t => {
  const saved = []
  const keys = []
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (options.method === "POST") {
      keys.push(JSON.parse(options.body).idempotencyKey)
      if (!saved.length) {
        saved.push(child)
        throw new Error("Response lost after creation")
      }
      return Response.json({ ...child, deduplicated: true })
    }
    return Response.json(url.endsWith("/agents") ? [assignee]
      : url.includes("/companies/") ? saved : url.includes("/comments") ? [] : original)
  })
  const available = tools()
  await assert.rejects(available.paperclip_create_issue.execute(childInput, context), /outcome may be unknown/)
  assert.equal(keys.length, 1)
  assert.equal((await available.paperclip_get_issue.execute({}, context)).children[0].id, child.id)
  const next = Object.fromEntries(createPaperclipTaskTools({ ...scope, runId: "next-run" }).map(tool => [tool.name, tool]))
  assert.equal((await next.paperclip_create_issue.execute(childInput, context)).deduplicated, true)
  assert.equal(keys[0], keys[1], "A continuation must use the same parent-scoped server idempotency key")
  assert.equal(saved.length, 1)
})

test("child reads paginate, include completed children, and reject foreign or repeated pages", async t => {
  let foreign = false
  const page = Array.from({ length: 100 }, (_, index) => ({ ...child, id: `child-${index}`, status: "done" }))
  t.mock.method(globalThis, "fetch", async url => {
    if (url.includes("/comments")) return Response.json([])
    if (!url.includes("/companies/")) return Response.json(original)
    const offset = Number(new URL(url).searchParams.get("offset"))
    return Response.json(offset === 0 ? page : [{ ...child, parentId: foreign ? "other" : scope.issueId }])
  })
  assert.equal((await tools().paperclip_get_issue.execute({}, context)).children.length, 101)
  foreign = true
  await assert.rejects(tools().paperclip_get_issue.execute({}, context), /child list/)
  foreign = false
  page[0] = child
  await assert.rejects(tools().paperclip_get_issue.execute({}, context), /child list/)
})

test("child creation preserves authorization denials and rejects unconfirmed saved scope or assignees", async t => {
  let response = Response.json({ error: `Denied ${scope.authToken}` }, { status: 403 })
  let writes = 0
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (options.method === "POST") { writes++; return response }
    return Response.json(url.endsWith("/agents") ? [assignee] : original)
  })
  await assert.rejects(tools().paperclip_create_issue.execute(childInput, context), error =>
    error.message.includes("HTTP 403") && !error.message.includes(scope.authToken))
  assert.equal(writes, 1)
  for (const override of [{ companyId: "other" }, { parentId: "other" }, { assigneeAgentId: "other" }, { description: "different" }]) {
    response = Response.json({ ...child, ...override })
    await assert.rejects(tools().paperclip_create_issue.execute(childInput, context), /did not confirm/)
  }
  assert.equal(writes, 5)
})
