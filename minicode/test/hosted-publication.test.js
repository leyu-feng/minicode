import assert from "node:assert/strict"
import test from "node:test"
import { createHostedPublicationTool } from "../server/hosted-publication.js"

function fixture(t) {
  const agentId = "11111111-1111-4111-8111-111111111111"
  const companyId = "22222222-2222-4222-8222-222222222222"
  const issueId = "33333333-3333-4333-8333-333333333333"
  const projectUrl = "https://dev.azure.com/fixture/Project"
  const repositories = [
    { id: "44444444-4444-4444-8444-444444444444", name: "First", readOnly: false },
    { id: "55555555-5555-4555-8555-555555555555", name: "Second", readOnly: false },
    { id: "66666666-6666-4666-8666-666666666666", name: "Reference", readOnly: true },
  ]
  const products = [], comments = [], publications = []
  let failRegistration = false
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const route = new URL(url).pathname
    const body = options.body ? JSON.parse(options.body) : undefined
    if (route.endsWith(`/issues/${issueId}`)) {
      return Response.json({ id: issueId, assigneeAgentId: agentId, companyId })
    }
    if (route.endsWith("/work-products")) {
      if (options.method === "GET") return Response.json(products)
      if (failRegistration) return new Response("Registration failed", { status: 503 })
      const product = { ...body, id: `product-${products.length}`, issueId }
      products.push(product)
      return Response.json(product)
    }
    if (route.includes("/work-products/")) {
      const product = products.find(product => route.endsWith(`/${product.id}`))
      assert.ok(product)
      Object.assign(product, body)
      return Response.json(product)
    }
    if (route.endsWith("/comments")) {
      if (options.method === "GET") return Response.json(comments)
      const comment = { ...body, id: `comment-${comments.length}`, issueId, authorAgentId: agentId }
      comments.push(comment)
      return Response.json(comment)
    }
    throw new Error(`Unexpected API route ${route}`)
  })
  const tool = createHostedPublicationTool({
    repositories, projectUrl, apiUrl: "https://paperclip.example.test",
    task: { authToken: "fixture-token", runId: "fixture-run", agent: { id: agentId, companyId }, context: { taskId: issueId } },
    async request(operation, input) {
      assert.equal(operation, "publish")
      publications.push(input)
      const repository = repositories.find(repository => repository.id === input.repositoryId)
      assert.ok(repository && !repository.readOnly)
      const identity = `${projectUrl}/_git/${repository.id}`
      const number = repository.name === "First" ? 1 : 2
      return {
        provider: "azure_devops", repository: identity, number,
        url: `${identity}/pullrequest/${number}`, state: "OPEN",
        commit: input.commit, branch: `u/hosted/${agentId}/${input.commit}`,
      }
    },
  })
  return {
    tool, products, comments, publications,
    input: { commit: "a".repeat(40), title: "Multi-repository change", body: "Awaiting review." },
    failRegistration(value) { failRegistration = value },
  }
}

test("Hosted publication registers separate repository PRs and reconciles only the selected saved receipt", async t => {
  const f = fixture(t)
  assert.deepEqual(f.tool.parameters.properties.repository.enum, ["First", "Second"])
  const first = await f.tool.execute({ ...f.input, repository: "First" })
  const second = await f.tool.execute({ ...f.input, repository: "Second" })
  assert.notEqual(first.repository, second.repository)
  assert.equal(f.products.length, 2)
  assert.equal(f.comments.length, 2)
  assert.deepEqual(f.publications.map(input => input.existingOnly), [false, false])

  const retry = await f.tool.execute({ ...f.input, repository: "First" })
  assert.equal(retry.number, first.number)
  assert.equal(f.publications.at(-1).existingOnly, true)
  assert.equal(f.products.length, 2)
  assert.equal(f.comments.length, 2)
  await assert.rejects(f.tool.execute({ ...f.input, repository: "Reference" }), /writable repository/)
  assert.equal(f.publications.length, 3)
})

test("Hosted publication retains another repository's registration failure until that receipt is repaired", async t => {
  const f = fixture(t)
  f.failRegistration(true)
  await assert.rejects(f.tool.execute({ ...f.input, repository: "Second" }), /registration is incomplete/)
  assert.match(f.tool.registrationError, /PR exists/)
  f.failRegistration(false)
  await f.tool.execute({ ...f.input, repository: "First" })
  assert.match(f.tool.registrationError, /PR exists/)
  await f.tool.execute({ ...f.input, repository: "Second" })
  assert.equal(f.tool.registrationError, null)
  assert.equal(f.products.length, 2)
})
