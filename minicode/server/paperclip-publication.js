import { validatePublicationInput } from "./pull-request-publisher.js"

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i

export function paperclipPublicationTool(tool, { apiUrl, authToken, runId, issueId, agentId, companyId, repository,
  provider = "github", pullRequestUrl = number => `https://github.com/${repository}/pull/${number}`,
  branchForCommit = (agent, commit) => `minicode/${agent}/${commit}` }) {
  const failures = new Map()
  return {
    ...tool,
    description: `${tool.description} Automatically registers the PR in Paperclip and posts its task-chat link. Supply issueId when this run has no assigned task. Retry the same commit if registration fails; do not publish a different commit to recover.`,
    parameters: { ...tool.parameters, properties: { ...tool.parameters.properties,
      issueId: { type: "string", description: "Assigned Paperclip issue UUID; required only for a general Run Now without task context." },
    } },
    get registrationError() { return failures.values().next().value ?? null },
    async execute(input, options = {}) {
      const target = input?.issueId ?? issueId
      const key = `${target}:${input?.commit}`
      let receipt
      try {
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("PR tool arguments must be an object")
        if (!UUID.test(target ?? "") || (issueId && target !== issueId)) {
          throw new Error("PR publication requires the assigned Paperclip issue UUID; task-scoped runs cannot override it")
        }
        if (!authToken || !runId) throw new Error("PR registration requires run-scoped Paperclip credentials")
        const api = async (route, method = "GET", body) => {
          let response
          try {
            response = await fetch(new URL(`${apiUrl.replace(/\/+$/, "")}/api${route}`), {
              method, redirect: "error",
              signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
              headers: { Authorization: `Bearer ${authToken}`, "X-Paperclip-Run-Id": runId,
                ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            })
          } catch (cause) { throw new Error(`Paperclip ${method} ${route} request failed`, { cause }) }
          if (!response.ok) throw new Error(`Paperclip ${method} ${route} returned HTTP ${response.status}`)
          return response.json()
        }
        const issue = await api(`/issues/${target}`)
        if (issue.id !== target || issue.assigneeAgentId !== agentId || (companyId && issue.companyId !== companyId)) {
          throw new Error("PR publication target must be assigned to this agent in this company")
        }
        const { issueId: _issueId, ...publicationInput } = input
        validatePublicationInput(publicationInput, agentId)
        const products = await api(`/issues/${target}/work-products`)
        if (!Array.isArray(products)) throw new Error("Paperclip returned an invalid work-product list")
        const matches = products.filter(product => ["pull_request", "branch"].includes(product.type)
          && product.provider === provider && product.metadata?.repository === repository
          && product.metadata?.commit === publicationInput.commit)
        if (matches.some(product => product.issueId !== target || typeof product.id !== "string" || !product.id)) {
          throw new Error("Saved publication has an invalid task binding")
        }
        if (matches.some(product => product.metadata.agentId !== agentId)) throw new Error("Saved publication belongs to another agent")
        const prs = matches.filter(product => product.type === "pull_request")
        const allocations = matches.filter(product => product.type === "branch" && product.externalId === `minicode-publication:${agentId}:${publicationInput.commit}`)
        if (prs.length > 1 || allocations.length > 1) throw new Error("Ambiguous saved publication; no new PR will be created")
        const savedPr = prs[0]
        let allocationProduct = allocations[0], allocation = allocationProduct?.metadata
        if (savedPr && (!Number.isSafeInteger(savedPr.metadata.number) || savedPr.metadata.number < 1
          || savedPr.url !== pullRequestUrl(savedPr.metadata.number) || typeof savedPr.metadata.branch !== "string")) {
          throw new Error("Saved PR identity is invalid; no replacement PR will be created")
        }
        if (allocation && (typeof allocation.baseBranch !== "string" || !Number.isInteger(allocation.attempt)
          || allocation.attempt < 0 || allocation.attempt > 10
          || allocation.branch !== `${allocation.baseBranch}${allocation.attempt ? `-${allocation.attempt}` : ""}`)) {
          throw new Error("Saved publication branch allocation is invalid")
        }
        if (savedPr && allocation && ["branch", "target", "repositoryId", "projectId"].some(key =>
          savedPr.metadata[key] != null && allocation[key] != null && savedPr.metadata[key] !== allocation[key])) {
          throw new Error("Saved PR and branch allocation disagree; no replacement PR will be created")
        }
        receipt = await tool.execute(publicationInput, { ...options, publication: {
          existing: savedPr?.metadata, allocation,
          async saveAllocation(value) {
            const metadata = { ...value, repository, agentId }
            const payload = { metadata, status: "draft" }
            const product = allocationProduct
              ? await api(`/work-products/${allocationProduct.id}`, "PATCH", payload)
              : await api(`/issues/${target}/work-products`, "POST", {
                ...payload, type: "branch", provider, externalId: `minicode-publication:${agentId}:${publicationInput.commit}`,
                title: `PR branch: ${publicationInput.title}`, reviewState: "none", isPrimary: false,
              })
            if (!product?.id || product.issueId !== target || product.type !== "branch" || product.provider !== provider
              || Object.entries(metadata).some(([key, value]) => product.metadata?.[key] !== value)) {
              throw new Error("Paperclip did not confirm the saved publication branch; no further provider writes attempted")
            }
            allocationProduct = product
            allocation = metadata
          },
        } })
        if (!receipt || receipt.repository !== repository || (receipt.provider ?? "github") !== provider
          || !Number.isSafeInteger(receipt.number) || receipt.number < 1
          || (savedPr && receipt.number !== savedPr.metadata.number)
          || receipt.url !== pullRequestUrl(receipt.number)
          || !["OPEN", "CLOSED", "MERGED"].includes(receipt.state)
          || (receipt.isDraft !== undefined && typeof receipt.isDraft !== "boolean")
          || receipt.commit !== publicationInput.commit
          || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(receipt.commit ?? "")
          || receipt.branch !== (savedPr?.metadata.branch ?? allocation?.branch ?? branchForCommit(agentId, receipt.commit))) {
          throw new Error("Harness returned an invalid PR receipt")
        }
        const existing = savedPr ?? products.find(product => product.type === "pull_request"
          && product.provider === provider && product.url?.replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase() === receipt.url.toLowerCase())
        let status = receipt.state.toLowerCase()
        if (receipt.state === "OPEN") {
          status = ["approved", "changes_requested", "draft"].includes(existing?.status) ? existing.status : "ready_for_review"
          if (receipt.isDraft === true) status = "draft"
          else if (receipt.isDraft === false && status === "draft") status = "ready_for_review"
        }
        const payload = {
          status, reviewState: receipt.state === "OPEN" ? existing?.reviewState ?? "needs_board_review" : "none",
          metadata: { ...existing?.metadata, repository, number: receipt.number, branch: receipt.branch,
            commit: receipt.commit, state: receipt.state.toLowerCase(), agentId,
            ...(receipt.isDraft !== undefined ? { isDraft: receipt.isDraft } : {}),
            ...(receipt.target ? { target: receipt.target } : {}),
            ...(receipt.repositoryId ? { repositoryId: receipt.repositoryId } : {}),
            ...(receipt.projectId ? { projectId: receipt.projectId } : {}) },
        }
        const product = existing
          ? await api(`/work-products/${existing.id}`, "PATCH", payload)
          : await api(`/issues/${target}/work-products`, "POST", {
            ...payload, type: "pull_request", provider, externalId: `${repository}#${receipt.number}`,
            title: publicationInput.title, url: receipt.url, isPrimary: true,
          })
        if (!product?.id || product.issueId !== target || product.url !== (existing?.url ?? receipt.url)
          || product.status !== status || product.metadata?.commit !== receipt.commit) {
          throw new Error("Paperclip did not confirm the saved PR work product")
        }
        const comments = await api(`/issues/${target}/comments`)
        if (!Array.isArray(comments)) throw new Error("Paperclip returned an invalid comment list")
        const marker = `<!-- minicode-pr:${repository.toLowerCase()}#${receipt.number}:${receipt.state} -->`
        let comment = comments.find(entry => entry.authorAgentId === agentId && entry.body?.includes(marker))
        if (!comment) {
          comment = await api(`/issues/${target}/comments`, "POST", {
            body: `## Pull request ${receipt.state.toLowerCase()}\n\n[${repository}#${receipt.number}](${receipt.url})\n\nCommit: \`${receipt.commit}\`\nBranch: \`${receipt.branch}\`\n\n${receipt.state === "OPEN" ? "Awaiting PR review and merge. Publication is not task completion." : receipt.state === "MERGED" ? "PR merge verified. Check the task acceptance and approval gates before completing the task." : "PR is closed without merge; task completion is not implied."}\n\n${marker}`,
          })
        }
        if (!comment?.id || comment.issueId !== target || comment.authorAgentId !== agentId || !comment.body?.includes(marker)) {
          throw new Error("Paperclip did not confirm the saved PR task-chat link")
        }
        failures.delete(key)
        return { ...receipt, paperclip: { issueId: target, workProductId: product.id, commentId: comment.id } }
      } catch (cause) {
        const message = receipt
          ? `${provider === "github" ? "GitHub" : provider === "azure_devops" ? "Azure DevOps" : provider} PR exists, but Paperclip registration is incomplete. Retry the same commit to reconcile. Receipt: ${JSON.stringify(receipt)}. ${cause.message}`
          : `PR publication/registration failed: ${cause.message}`
        if (receipt) failures.set(key, message)
        throw new Error(message, { cause })
      }
    },
  }
}
