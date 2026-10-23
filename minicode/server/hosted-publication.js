import { paperclipPublicationTool } from "./paperclip-publication.js"

export function createHostedPublicationTool({ repositories, task, apiUrl, request }) {
  const tools = new Map()
  for (const repository of repositories.filter(repo => !repo.readOnly)) {
    const publication = repository.publication
    if (!publication || typeof publication.provider !== "string" || !publication.provider.trim()
      || typeof publication.repository !== "string" || !publication.repository.trim()
      || typeof publication.pullRequestUrlTemplate !== "string" || !publication.pullRequestUrlTemplate.includes("{number}")
      || /[{}]/.test(publication.pullRequestUrlTemplate.replace("{number}", "1"))
      || typeof publication.branchTemplate !== "string" || !publication.branchTemplate.includes("{commit}")
      || /[{}]/.test(publication.branchTemplate.replaceAll("{agentId}", "").replace("{commit}", ""))) {
      throw new Error(`Writable repository ${repository.name} requires a provider publication descriptor`)
    }
    const url = new URL(publication.pullRequestUrlTemplate.replace("{number}", "1"))
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new Error(`Writable repository ${repository.name} requires an HTTPS pull request URL template without credentials, query or fragment`)
    }
    tools.set(repository.name, paperclipPublicationTool({
      name: "publish_pull_request",
      description: `Publish the requested local commit from ${repository.name} through the trusted Hosted harness.`,
      parameters: { type: "object", properties: {
        commit: { type: "string" }, title: { type: "string" }, body: { type: "string" },
      }, required: ["commit", "title", "body"], additionalProperties: false },
      execute: (input, options) => request("publish", {
        repositoryId: repository.id, ...input, existingOnly: !!options.publication?.existing,
      }, options),
    }, {
      apiUrl, authToken: task.authToken, runId: task.runId, agentId: task.agent.id, companyId: task.agent.companyId,
      issueId: task.context.taskId ?? task.context.issueId, repository: publication.repository, provider: publication.provider,
      pullRequestUrl: number => publication.pullRequestUrlTemplate.replace("{number}", String(number)),
      branchForCommit: (agent, commit) => publication.branchTemplate.replaceAll("{agentId}", agent).replace("{commit}", commit),
    }))
  }
  return {
    name: "publish_pull_request",
    description: "Publish a local commit as a pull request through the AgentPool provider in a writable catalog repository. Use a separate invocation for each repository. The harness registers each PR with the assigned Paperclip task; retry the same repository and commit on failure.",
    parameters: { type: "object", properties: {
      repository: { type: "string", enum: [...tools.keys()] },
      commit: { type: "string" }, title: { type: "string" }, body: { type: "string" },
      issueId: { type: "string", description: "Assigned task UUID, required only for Run Now without task context." },
    }, required: ["repository", "commit", "title", "body"], additionalProperties: false },
    get registrationError() { return [...tools.values()].find(tool => tool.registrationError)?.registrationError ?? null },
    async execute(input, options) {
      const { repository, ...publication } = input ?? {}
      const tool = tools.get(repository)
      if (!tool) throw new Error("Publication requires a writable repository name from the Hosted catalog")
      return tool.execute(publication, options)
    },
  }
}
