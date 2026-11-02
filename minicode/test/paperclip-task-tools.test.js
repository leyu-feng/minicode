import assert from "node:assert/strict"
import test from "node:test"
import { createPaperclipTaskTools } from "../server/paperclip-task-tools.js"

const scope = {
  apiUrl: "https://paperclip.example/bridge-prefix", authToken: "private-run-token",
  runId: "run", issueId: "assigned-issue", agentId: "agent", companyId: "company",
}
const original = { id: scope.issueId, companyId: scope.companyId, assigneeAgentId: scope.agentId, status: "in_progress" }
const context = { signal: new AbortController().signal }

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
    assert.ok(url.startsWith(`${scope.apiUrl}/api/issues/${scope.issueId}`))
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
  assert.deepEqual(await available.paperclip_get_issue.execute({}, context), { issue: original, comments: [] })
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
    return Response.json(url.includes("/comments") ? [] : issue)
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
