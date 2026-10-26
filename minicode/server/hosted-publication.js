import { paperclipPublicationTool } from "./paperclip-publication.js"
import { publicationSlug } from "./pull-request-publisher.js"

export function createHostedPublicationTool({ repositories, task, apiUrl, request }) {
  const tools = new Map()
  for (const repository of repositories.filter(repo => !repo.readOnly)) {
    const alias = repository.alias ?? repository.name
    const publication = repository.publication
    const readableBranches = publication?.branchTemplate === "u/{workerName}/{feature}"
    if (!publication || typeof publication.provider !== "string" || !publication.provider.trim()
      || typeof publication.repository !== "string" || !publication.repository.trim()
      || typeof publication.pullRequestUrlTemplate !== "string" || !publication.pullRequestUrlTemplate.includes("{number}")
      || /[{}]/.test(publication.pullRequestUrlTemplate.replace("{number}", "1"))
      || (!readableBranches && (typeof publication.branchTemplate !== "string" || !publication.branchTemplate.includes("{commit}")
        || /[{}]/.test(publication.branchTemplate.replaceAll("{agentId}", "").replace("{commit}", ""))))) {
      throw new Error(`Writable repository ${repository.name} requires a provider publication descriptor`)
    }
    const url = new URL(publication.pullRequestUrlTemplate.replace("{number}", "1"))
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new Error(`Writable repository ${repository.name} requires an HTTPS pull request URL template without credentials, query or fragment`)
    }
    tools.set(alias, paperclipPublicationTool({
      name: "publish_pull_request",
      description: `Publish the requested local commit from ${alias} through the trusted Hosted harness.`,
      parameters: { type: "object", properties: {
        commit: { type: "string" }, title: { type: "string" }, body: { type: "string" },
      }, required: ["commit", "title", "body"], additionalProperties: false },
      execute: (input, options) => request("publish", {
        repositoryId: repository.id, ...input, isDraft: options.isDraft === true, existingOnly: !!options.publication?.existing,
        readableBranchNames: readableBranches,
      }, options),
    }, {
      apiUrl, authToken: task.authToken, runId: task.runId, agentId: task.agent.id, companyId: task.agent.companyId,
      issueId: task.context.taskId ?? task.context.issueId, repository: publication.repository, provider: publication.provider,
      pullRequestUrl: number => publication.pullRequestUrlTemplate.replace("{number}", String(number)),
      branchForCommit: (agent, commit) => publication.branchTemplate.replaceAll("{agentId}", agent).replace("{commit}", commit),
      ...(readableBranches ? { validateBranch: (branch, { agentId, commit, title }) => {
        if (branch === `u/hosted/${agentId}/${commit}`) return true
        const match = /^u\/w(?:0[1-9]|[1-9][0-9])\/(.+)$/.exec(branch ?? "")
        const feature = publicationSlug(title)
        return !!feature && !!match && (match[1] === feature
          || Array.from({ length: 10 }, (_, index) => `${feature}-${index + 1}`).includes(match[1]))
      } } : {}),
    }))
  }
  return {
    name: "publish_pull_request",
    description: "Publish a local commit as a pull request through the AgentPool provider in a writable catalog repository. Use a concise, readable feature title without execution IDs or commit hashes. Hosted branches use u/wNN/<feature-title>, with numeric collision suffixes. Use a separate invocation for each repository. The harness registers each PR with the assigned Paperclip task; retry the same repository and commit on failure.",
    parameters: { type: "object", properties: {
      repository: { type: "string", enum: [...tools.keys()] },
      commit: { type: "string" }, title: { type: "string" }, body: { type: "string" },
      isDraft: { type: "boolean", description: "Follow the assigned workflow: true for draft-only, false for a normal PR awaiting human approval. Defaults to false. Never merge or enable auto-complete." },
      issueId: { type: "string", description: "Assigned task UUID, required only for Run Now without task context." },
    }, required: ["repository", "commit", "title", "body"], additionalProperties: false },
    get registrationError() { return [...tools.values()].find(tool => tool.registrationError)?.registrationError ?? null },
    async execute(input, options) {
      const { repository, isDraft, ...publication } = input ?? {}
      if (isDraft !== undefined && typeof isDraft !== "boolean") throw new Error("isDraft must be a boolean")
      const tool = tools.get(repository)
      if (!tool) throw new Error("Publication requires a writable repository alias from the Hosted catalog")
      return tool.execute(publication, { ...options, isDraft })
    },
  }
}
