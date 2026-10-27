export function createHostedProviderTool({ task, baseUrl, routes, request }) {
  return createProviderTool({ task, baseUrl, routes, request, method: "GET" })
}

export function createHostedProviderPostTool({ task, baseUrl, routes, bodySchema, request }) {
  if (!bodySchema || bodySchema.type !== "object" || Array.isArray(bodySchema)) {
    throw new Error("Provider posts require a provider-advertised object body schema")
  }
  return createProviderTool({ task, baseUrl, routes, bodySchema, request, method: "POST" })
}

function createProviderTool({ task, baseUrl, routes, bodySchema, request, method }) {
  const post = method === "POST"
  const name = post ? "provider_post" : "provider_read"
  const origin = new URL(baseUrl)
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash
    || !Array.isArray(routes) || !routes.length || routes.length > 100
    || routes.some(route => typeof route !== "string" || route.length > 500
      || !route.startsWith("/") || route.startsWith("//") || /[\\\x00-\x1f\x7f]/.test(route))) {
    throw new Error(`Provider requests require an HTTPS endpoint and an explicit relative ${method} route allowlist`)
  }
  return {
    name,
    description: `${post ? "Send an authorized POST to" : "Read"} the AgentPool provider API at ${baseUrl} using the Hosted worker's managed identity. The trusted parent supplies authentication and enforces its route and query allowlist; no CLI, user sign-in, token extraction or extra headers are needed. ${method} only: ${routes.join(", ")}. Small JSON is returned in body; binary responses and larger JSON are saved to the returned artifact path, which shell tools can read. Artifacts are temporary and discarded after this assignment. Errors are explicit; never fall back to anonymous calls or another authentication method.${post ? " Send only the advertised JSON body. A timeout, cancellation or connection failure can leave the mutation outcome unknown: inspect live state before considering another request, never automatically replay the POST." : ""}`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: `Relative ${method} path matching a provider-advertised route and query allowlist, not an absolute URL.` },
        ...(post ? { body: bodySchema } : {}),
      },
      required: post ? ["path", "body"] : ["path"],
      additionalProperties: false,
    },
    async execute(input, options = {}) {
      options.signal?.throwIfAborted()
      if (!input || typeof input.path !== "string" || !input.path.startsWith("/") || input.path.startsWith("//")
        || /[\\#\x00-\x20\x7f]/.test(input.path) || Object.keys(input).some(key => key !== "path" && !(post && key === "body"))) {
        throw new Error(`${name} accepts only a relative path${post ? " and JSON body" : ""}; methods, headers, credentials and output paths are not accepted`)
      }
      if (post && (!input.body || typeof input.body !== "object" || Array.isArray(input.body)
        || Buffer.byteLength(JSON.stringify(input.body), "utf8") > 8192)) {
        throw new Error("provider_post requires a JSON object body of at most 8 KiB matching the provider-advertised schema")
      }
      const result = await request(name, { runId: task.runId, path: input.path, ...(post ? { body: input.body } : {}) }, { signal: options.signal })
      if (JSON.stringify(result).length > 10_000) {
        const { body, ...artifact } = result
        return { ...artifact, bodyOmitted: "JSON exceeds the inline tool budget; read the returned artifact path." }
      }
      return result
    },
  }
}
