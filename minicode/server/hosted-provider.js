export function createHostedProviderTool({ task, baseUrl, routes, request }) {
  const origin = new URL(baseUrl)
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash
    || !Array.isArray(routes) || !routes.length || routes.length > 100
    || routes.some(route => typeof route !== "string" || route.length > 500
      || !route.startsWith("/") || route.startsWith("//") || /[\\\x00-\x1f\x7f]/.test(route))) {
    throw new Error("Provider reads require an HTTPS endpoint and an explicit relative GET route allowlist")
  }
  return {
    name: "provider_read",
    description: `Read the AgentPool provider API at ${baseUrl} using the Hosted worker's managed identity. The trusted parent supplies authentication and enforces its route and query allowlist; no CLI, user sign-in, token extraction or extra headers are needed. GET only: ${routes.join(", ")}. Small JSON is returned in body; binary responses and larger JSON are saved to the returned artifact path, which shell tools can read. Artifacts are temporary and discarded after this assignment. Errors are explicit; never fall back to anonymous calls or another authentication method.`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative GET path matching a provider-advertised route and query allowlist, not an absolute URL." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(input, options = {}) {
      options.signal?.throwIfAborted()
      if (!input || typeof input.path !== "string" || !input.path.startsWith("/") || input.path.startsWith("//")
        || /[\\#\x00-\x20\x7f]/.test(input.path) || Object.keys(input).some(key => key !== "path")) {
        throw new Error("provider_read accepts only a relative path; methods, headers, credentials and output paths are not accepted")
      }
      const result = await request("provider_read", { runId: task.runId, path: input.path }, { signal: options.signal })
      if (JSON.stringify(result).length > 10_000) {
        const { body, ...artifact } = result
        return { ...artifact, bodyOmitted: "JSON exceeds the inline tool budget; read the returned artifact path." }
      }
      return result
    },
  }
}
