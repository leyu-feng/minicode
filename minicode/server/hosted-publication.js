import { paperclipPublicationTool } from "./paperclip-publication.js"

export function createHostedPublicationTool({ repositories, task, apiUrl, projectUrl, request }) {
  const tools = new Map()
  for (const repository of repositories.filter(repo => !repo.readOnly)) {
    const alias = repository.alias ?? repository.name
    const identity = `${projectUrl.replace(/\/+$/, "")}/_git/${encodeURIComponent(repository.id)}`
    tools.set(alias, paperclipPublicationTool({
      name: "publish_pull_request",
      description: `Publish the requested local commit from ${alias} through the trusted Hosted harness.`,
      parameters: { type: "object", properties: {
        commit: { type: "string" }, title: { type: "string" }, body: { type: "string" },
      }, required: ["commit", "title", "body"], additionalProperties: false },
      execute: (input, options) => request("publish", {
        repositoryId: repository.id, ...input, existingOnly: !!options.publication?.existing,
      }, options),
    }, {
      apiUrl, authToken: task.authToken, runId: task.runId, agentId: task.agent.id, companyId: task.agent.companyId,
      issueId: task.context.taskId ?? task.context.issueId, repository: identity, provider: "azure_devops",
      pullRequestUrl: number => `${identity}/pullrequest/${number}`,
      branchForCommit: (agent, commit) => `u/hosted/${agent}/${commit}`,
    }))
  }
  return {
    name: "publish_pull_request",
    description: "Publish a local commit as an Azure DevOps PR in a writable catalog repository. Use a separate invocation for each repository. The harness registers each PR with the assigned Paperclip task; retry the same repository and commit on failure.",
    parameters: { type: "object", properties: {
      repository: { type: "string", enum: [...tools.keys()] },
      commit: { type: "string" }, title: { type: "string" }, body: { type: "string" },
      issueId: { type: "string", description: "Assigned task UUID, required only for Run Now without task context." },
    }, required: ["repository", "commit", "title", "body"], additionalProperties: false },
    get registrationError() { return [...tools.values()].find(tool => tool.registrationError)?.registrationError ?? null },
    async execute(input, options) {
      const { repository, ...publication } = input ?? {}
      const tool = tools.get(repository)
      if (!tool) throw new Error("Publication requires a writable repository alias from the Hosted catalog")
      return tool.execute(publication, options)
    },
  }
}
