import { httpErrorDetails } from "./http-error.js"

const STATUSES = ["in_progress", "in_review", "blocked", "done"]
const MAX_COMMENT = 16000
const PRIORITIES = ["critical", "high", "medium", "low"]
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i

export function createPaperclipTaskTools({ apiUrl, authToken, runId, issueId, agentId, companyId }) {
  if (!issueId || !authToken || !runId || !agentId || !companyId) return []
  const route = `/issues/${encodeURIComponent(issueId)}`
  const companyRoute = `/companies/${encodeURIComponent(companyId)}`
  const guidance = " Uses harness-owned run authentication and the run audit header. Task writes are limited to the assigned issue and creation of its children in this company; never supply credentials, company or parent overrides. Existing server authorization gates still apply. A transport failure can leave a write's outcome unknown: use paperclip_get_issue to inspect live state and children, never blindly replay a mutation."
  const parameters = properties => ({
    type: "object", properties, required: Object.keys(properties), additionalProperties: false,
  })
  const validate = (input, keys) => {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some(key => !keys.includes(key))
      || keys.some(key => !Object.hasOwn(input, key))) {
      throw new Error("Supply only the advertised Paperclip tool arguments; task scope and authentication are harness-owned")
    }
  }
  const text = (value, label, maximum) => {
    if (typeof value !== "string" || !value.trim() || value.length > maximum) {
      throw new Error(`Paperclip ${label} must contain 1-${maximum} characters`)
    }
  }
  const comment = value => text(value, "comment", MAX_COMMENT)
  const api = async (path, method, body, signal) => {
    signal?.throwIfAborted()
    const uncertain = method === "GET" ? "" : " Mutation outcome may be unknown; inspect the assigned issue before another write."
    let response
    try {
      response = await fetch(`${apiUrl.replace(/\/+$/, "")}/api${path}`, {
        method, redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
        headers: { Authorization: `Bearer ${authToken}`, "X-Paperclip-Run-Id": runId,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (cause) {
      throw new Error(`Paperclip ${method} request failed.${uncertain}`, { cause })
    }
    if (!response.ok) {
      const detail = await httpErrorDetails(response, [authToken])
      throw new Error(`Paperclip ${method} returned HTTP ${response.status}: ${detail}${uncertain}`)
    }
    try { return await response.json() }
    catch (cause) { throw new Error(`Paperclip ${method} did not return valid JSON.${uncertain}`, { cause }) }
  }
  const assignedIssue = issue => {
    if (!issue || issue.id !== issueId || issue.companyId !== companyId || issue.assigneeAgentId !== agentId) {
      throw new Error("Paperclip did not confirm an issue assigned to this agent in this company; inspect the assigned issue before another write")
    }
    return issue
  }
  const read = async signal => assignedIssue(await api(route, "GET", undefined, signal))
  const agents = async signal => {
    const entries = await api(`${companyRoute}/agents`, "GET", undefined, signal)
    if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry.id !== "string" || !entry.id.trim()
      || entry.companyId !== companyId || typeof entry.name !== "string" || typeof entry.status !== "string")) {
      throw new Error("Paperclip returned an invalid company-agent directory")
    }
    return entries.map(({ id, name, role, status }) => ({ id, name, role, status }))
  }
  const children = async signal => {
    const entries = []
    const seen = new Set()
    let page
    do {
      page = await api(`${companyRoute}/issues?parentId=${encodeURIComponent(issueId)}&limit=100&offset=${entries.length}&sortField=id&sortDir=asc`, "GET", undefined, signal)
      if (!Array.isArray(page) || page.some(entry => !entry || typeof entry.id !== "string" || !entry.id.trim()
        || entry.companyId !== companyId || entry.parentId !== issueId || seen.has(entry.id))) {
        throw new Error("Paperclip returned an invalid assigned-issue child list")
      }
      for (const entry of page) {
        if (seen.has(entry.id)) throw new Error("Paperclip returned duplicate assigned-issue children")
        seen.add(entry.id)
        const { id, identifier, companyId, parentId, title, description, status, priority, assigneeAgentId } = entry
        entries.push({ id, identifier, companyId, parentId, title, description, status, priority, assigneeAgentId })
      }
    } while (page.length === 100)
    return entries
  }
  return [
    {
      name: "paperclip_get_issue",
      description: "Read the assigned Paperclip issue, its latest 20 comments and its child issues, including status and ownership. Inspect children before creating tasks or reconciling uncertain writes." + guidance,
      parameters: parameters({}),
      async execute(input = {}, { signal } = {}) {
        validate(input, [])
        const issue = await read(signal)
        const comments = await api(`${route}/comments?limit=20&order=desc`, "GET", undefined, signal)
        if (!Array.isArray(comments) || comments.some(entry => !entry || entry.issueId !== issueId)) {
          throw new Error("Paperclip returned an invalid assigned-issue comment list")
        }
        return { issue, comments, children: await children(signal) }
      },
    },
    {
      name: "paperclip_list_agents",
      description: "List agent IDs, names, roles and statuses in this assignment's company. Resolve the requested assignee by name before creating a child issue; this does not grant assignment permission." + guidance,
      parameters: parameters({}),
      async execute(input = {}, { signal } = {}) {
        validate(input, [])
        await read(signal)
        return agents(signal)
      },
    },
    {
      name: "paperclip_create_issue",
      description: "Create a child task of the assigned issue, assigned to a company agent. Use only when the task authorizes filing/delegating work. Inspect existing children first. Supply a stable idempotencyKey for each planned child (for example exception-01), unchanged across continuations. Returns the confirmed issue, or a server-deduplicated existing issue. No automatic retries or reassignment of existing issues." + guidance,
      parameters: parameters({
        title: { type: "string", minLength: 1, maxLength: 240 },
        description: { type: "string", minLength: 1, maxLength: MAX_COMMENT },
        assigneeAgentId: { type: "string", description: "Agent UUID from paperclip_list_agents in this company." },
        priority: { type: "string", enum: PRIORITIES },
        idempotencyKey: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
      }),
      async execute(input, { signal } = {}) {
        validate(input, ["title", "description", "assigneeAgentId", "priority", "idempotencyKey"])
        text(input.title, "title", 240)
        text(input.description, "description", MAX_COMMENT)
        if (typeof input.assigneeAgentId !== "string" || !UUID.test(input.assigneeAgentId)) {
          throw new Error("Paperclip assignee must be a company agent UUID")
        }
        if (!PRIORITIES.includes(input.priority)) throw new Error("Unsupported Paperclip issue priority")
        if (typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.idempotencyKey)) {
          throw new Error("Paperclip child idempotencyKey must contain 1-128 letters, digits, dots, underscores, colons or hyphens")
        }
        await read(signal)
        if (!(await agents(signal)).some(agent => agent.id === input.assigneeAgentId)) {
          throw new Error("Paperclip assignee is not in this assignment's company")
        }
        const saved = await api(`${companyRoute}/issues`, "POST", {
          title: input.title.trim(), description: input.description, priority: input.priority,
          assigneeAgentId: input.assigneeAgentId, parentId: issueId, status: "todo",
          idempotencyKey: `worker-child:${issueId}:${input.idempotencyKey}`,
        }, signal)
        if (typeof saved?.id !== "string" || !saved.id.trim() || saved.companyId !== companyId
          || saved.parentId !== issueId || saved.assigneeAgentId !== input.assigneeAgentId
          || saved.title !== input.title.trim() || saved.description !== input.description
          || saved.priority !== input.priority || typeof saved.status !== "string") {
          throw new Error("Paperclip did not confirm the requested child task and assignee; inspect the assigned issue's children before another write")
        }
        return saved
      },
    },
    {
      name: "paperclip_add_comment",
      description: "Post meaningful progress or findings to the assigned Paperclip issue. Returns the confirmed saved comment; this does not change task status." + guidance,
      parameters: parameters({ body: { type: "string", minLength: 1, maxLength: MAX_COMMENT } }),
      async execute(input, { signal } = {}) {
        validate(input, ["body"])
        comment(input.body)
        await read(signal)
        const saved = await api(`${route}/comments`, "POST", { body: input.body }, signal)
        if (typeof saved?.id !== "string" || !saved.id.trim() || saved.issueId !== issueId || saved.authorAgentId !== agentId || saved.body !== input.body) {
          throw new Error("Paperclip did not confirm the saved comment; inspect the assigned issue before another write")
        }
        return saved
      },
    },
    {
      name: "paperclip_update_issue",
      description: "Save the assigned Paperclip issue's status with an explanatory comment. Use done only when the task acceptance criteria are met. Existing checkout, pause, approval and authorization gates remain enforced. A successful CLI exit or final message never changes task status." + guidance,
      parameters: parameters({
        status: { type: "string", enum: STATUSES },
        comment: { type: "string", minLength: 1, maxLength: MAX_COMMENT },
      }),
      async execute(input, { signal } = {}) {
        validate(input, ["status", "comment"])
        if (!STATUSES.includes(input.status)) throw new Error("Unsupported Paperclip task status")
        comment(input.comment)
        await read(signal)
        const issue = assignedIssue(await api(route, "PATCH", { status: input.status, comment: input.comment }, signal))
        if (issue.status !== input.status) {
          throw new Error(`Paperclip returned status ${issue.status}; requested ${input.status} was not confirmed. Inspect the assigned issue and its gates before another write.`)
        }
        return issue
      },
    },
  ]
}
