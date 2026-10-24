export function createHostedEngsysTool({ task, baseUrl, request }) {
  return {
    name: "engsys_read",
    description: `Read Engineering Systems at ${baseUrl} using the Hosted worker's managed identity. The trusted parent supplies authentication; no Azure CLI, user sign-in, auth approval, token extraction or extra headers are needed. GET only: /v1/health/greetings, /v1/builds, /v1/builds/board, /v1/builds/pipeline/{id}, /v1/builds/{id}, /v1/builds/{id}/stages, /v1/builds/{id}/stages/{guid}/logs. Only the two build-list routes support ?max=1..200. Small JSON is returned in body; ZIP logs and larger JSON are saved to the returned artifact path, which shell tools can read. Artifacts are temporary and discarded after this assignment. Errors are explicit; never fall back to anonymous calls or Azure CLI.`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Exact allowlisted relative /v1/... GET route, not a URL. Stage IDs are timeline GUIDs." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(input, options = {}) {
      options.signal?.throwIfAborted()
      if (!input || typeof input.path !== "string" || Object.keys(input).some(key => key !== "path")) {
        throw new Error("engsys_read accepts only a relative path; methods, headers, credentials and output paths are not accepted")
      }
      const result = await request("engsys_read", { runId: task.runId, path: input.path }, { signal: options.signal })
      if (JSON.stringify(result).length > 10_000) {
        const { body, ...artifact } = result
        return { ...artifact, bodyOmitted: "JSON exceeds the inline tool budget; read the returned artifact path." }
      }
      return result
    },
  }
}
