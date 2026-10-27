import readline from "node:readline"
import { randomBytes, randomUUID } from "node:crypto"
import { AgentSession } from "./agent-session.js"
import { startAgentPoolWorker } from "./agent-pool-worker.js"
import { hostedBindingToken, startHostedFleet } from "./hosted-fleet.js"
import { createHostedPublicationTool } from "./hosted-publication.js"
import { createHostedProviderTool, createHostedProviderPostTool } from "./hosted-provider.js"

// The parent owns managed identity and repository restoration. Credentials cross this private
// stdio channel only, never argv, model context, inherited shell environment or a saved auth file.
export async function runHostedWorkerCli() {
  const pending = new Map()
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  let nextId = 0
  let worker
  let closing = false
  function request(operation, input = {}, { signal } = {}) {
    signal?.throwIfAborted()
    const id = ++nextId
    return new Promise((resolve, reject) => {
      const abort = () => {
        pending.delete(id)
        reject(new Error("Hosted worker operation cancelled"))
      }
      pending.set(id, {
        resolve: value => { signal?.removeEventListener("abort", abort); resolve(value) },
        reject: error => { signal?.removeEventListener("abort", abort); reject(error) },
      })
      signal?.addEventListener("abort", abort, { once: true })
      process.stdout.write(`${JSON.stringify({ id, operation, ...input })}\n`)
    })
  }
  lines.on("line", line => {
    try {
      if (line.length > 2 * 1024 * 1024) throw new Error("Hosted parent response exceeded its limit")
      const message = JSON.parse(line)
      if (message.control === "bindings") {
        void worker?.updateBindings?.(message.bindings).catch(error => worker.stop(error))
        return
      }
      if (message.control === "stop") {
        closing = true
        void worker?.stop()
        return
      }
      const waiter = pending.get(message.id)
      if (!waiter) return // A cancelled preparation may finish after its caller stopped.
      pending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error))
      else waiter.resolve(message.result)
    } catch (error) {
      for (const waiter of pending.values()) waiter.reject(error)
      pending.clear()
      void worker?.stop(error)
    }
  })
  lines.on("close", () => {
    closing = true
    const error = new Error("Hosted worker parent disconnected")
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
    void worker?.stop(error)
  })
  try {
    const instanceId = randomUUID()
    const clientToken = randomBytes(32).toString("hex")
    const configuration = await request("bootstrap", { instanceId, clientToken })
    if (closing) throw new Error("Hosted worker was stopped during bootstrap")
    let sessionToken = null
    const entraSession = configuration.easyAuthEnabled ? {
      token: () => sessionToken,
      async renew() {
        sessionToken = (await request("session")).sessionToken
        if (!sessionToken) throw new Error("Hosted worker received no Easy Auth session")
      },
    } : null
    await entraSession?.renew()
    const start = (binding, onStateChange) => startAgentPoolWorker({
      server: configuration.server, workerId: binding?.workerId ?? configuration.workerId, instanceId,
      clientToken: binding ? hostedBindingToken(clientToken, binding) : clientToken,
      cwd: configuration.cwd, sourceBranch: configuration.branch, entraSession,
      workerShared: configuration.workerShared,
      hostedWorkspaceMode: configuration.workspaceMode,
      hostedPublicationTool: options => createHostedPublicationTool({
        ...options, request,
      }),
      hostedProviderTool: configuration.providerRead?.authentication === "managed_identity"
        ? options => createHostedProviderTool({
          ...options, baseUrl: configuration.providerRead.baseUrl, routes: configuration.providerRead.routes, request,
        })
        : undefined,
      hostedProviderPostTool: configuration.providerPost?.authentication === "managed_identity"
        ? options => createHostedProviderPostTool({
          ...options, baseUrl: configuration.providerPost.baseUrl, routes: configuration.providerPost.routes,
          bodySchema: configuration.providerPost.bodySchema, request,
        })
        : undefined,
      minFreeGiB: configuration.minFreeGiB, targetFreeGiB: configuration.targetFreeGiB,
      assignmentTimeoutMs: configuration.assignmentTimeoutSeconds * 1000,
      idleTimeoutMs: configuration.idleTimeoutSeconds * 1000,
      prepareHostedRepositories: (repositories, options) => request("repositories", { repositories }, options),
      gitEnvironment: options => request("git", {}, options),
      onStateChange: onStateChange ?? (async state => {
        const result = await request("state", state)
        return result.accepting
      }),
      onActivity: activity => {
        void request("activity", { ...activity, bindingId: binding?.workerId }).then(result => {
          if (!result.accepted) process.stderr.write("Hosted live activity was not accepted.\n")
        }).catch(error => process.stderr.write(`Hosted live activity failed: ${error.message}\n`))
      },
      onModelFailure: configuration.academyEnabled === true
        ? evidence => request("learning_failure", { ...evidence, bindingId: binding?.workerId })
        : undefined,
      sessionFactory: options => new AgentSession({
        ...options,
        modelConfigProvider: async () => ({
          api: "responses", endpoint: configuration.modelEndpoint, model: configuration.model,
          getAccessToken: async () => (await request("model")).token,
        }),
      }),
    })
    worker = Array.isArray(configuration.bindings)
      ? await startHostedFleet({ bindings: configuration.bindings, startWorker: start, request })
      : await start()
    if (closing) await worker.stop()
    const stop = () => { void worker.stop() }
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
    try {
      const error = await worker.finished
      if (error) throw error
    } finally {
      process.off("SIGINT", stop)
      process.off("SIGTERM", stop)
    }
  } finally {
    lines.close()
    process.stdin.pause()
    for (const waiter of pending.values()) waiter.reject(new Error("Hosted worker stopped"))
    pending.clear()
  }
}
