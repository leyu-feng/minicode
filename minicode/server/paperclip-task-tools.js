import { httpErrorDetails } from "./http-error.js"

const STATUSES = ["in_progress", "in_review", "blocked", "done"]
const MAX_COMMENT = 16000

export function createPaperclipTaskTools({ apiUrl, authToken, runId, issueId, agentId, companyId }) {
  if (!issueId || !authToken || !runId || !agentId || !companyId) return []
  const route = `/issues/${encodeURIComponent(issueId)}`
  const guidance = " Uses harness-owned run authentication and the run audit header. Only the assigned issue is accessible; never supply credentials or another issue ID. A transport failure can leave a write's outcome unknown: use paperclip_get_issue to inspect live state, never blindly replay a mutation."
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
  const comment = value => {
    if (typeof value !== "string" || !value.trim() || value.length > MAX_COMMENT) {
      throw new Error(`Paperclip comment must contain 1-${MAX_COMMENT} characters`)
    }
  }
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
  return [
    {
      name: "paperclip_get_issue",
      description: "Read the assigned Paperclip issue and its latest 20 comments, including its current status and ownership. Use to inspect uncertain writes." + guidance,
      parameters: parameters({}),
      async execute(input = {}, { signal } = {}) {
        validate(input, [])
        const issue = await read(signal)
        const comments = await api(`${route}/comments?limit=20&order=desc`, "GET", undefined, signal)
        if (!Array.isArray(comments) || comments.some(entry => !entry || entry.issueId !== issueId)) {
          throw new Error("Paperclip returned an invalid assigned-issue comment list")
        }
        return { issue, comments }
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
