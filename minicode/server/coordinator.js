import childProcess from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createCoordinatorFrontend } from "./coordinator-frontend.js"

const COORDINATOR_RESOURCE = "api://72f988bf-86f1-41af-91ab-2d7cd011db47/mmd.dbg.tenantmanagement"
const DEFAULT_POLL_MS = 5000
const DEFAULT_HEARTBEAT_MS = 60_000
const DEFAULT_BUSY_KEEPALIVE_MS = 90_000
const DEFAULT_LEASE_POLL_MS = 1000
const DEFAULT_LEASE_SETTLE_MS = 250
const NO_REPLY = "[NO_REPLY]"
const COORDINATOR_IDLE = 0
const COORDINATOR_BUSY = 1

function coordinatorServer(value) {
  const url = new URL(value)
  const loopback = ["localhost", "[::1]"].includes(url.hostname) || /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new Error("Coordinator server requires HTTPS without URL credentials; HTTP is allowed only on loopback")
  }
  return url.origin
}

function azureCliInvocation(args) {
  if (process.platform !== "win32") return { command: "az", args }
  return {
    command: process.env.ComSpec || process.env.COMSPEC || "cmd.exe",
    args: ["/d", "/s", "/c", ["az", ...args].join(" ")],
  }
}

function execAzureCli(args, azureConfigDir) {
  const invocation = azureCliInvocation(args)
  const env = azureConfigDir
    ? { ...process.env, AZURE_CONFIG_DIR: azureConfigDir, AZURE_CORE_LOGIN_EXPERIENCE_V2: "off" }
    : process.env
  return new Promise((resolve, reject) => {
    childProcess.execFile(invocation.command, invocation.args, {
      encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024, env,
    }, (error, stdout, stderr) => {
      if (!error) {
        resolve(stdout)
        return
      }
      const detail = stderr.trim() || error.message
      reject(new Error(`Coordinator Azure CLI authentication failed: ${detail}`, { cause: error }))
    })
  })
}

export function createCoordinatorTokenProvider({ azureConfigDir, runAzureCli = execAzureCli } = {}) {
  let cached = null
  const provider = async () => {
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token
    const raw = await runAzureCli([
      "account", "get-access-token", "--resource", COORDINATOR_RESOURCE, "--output", "json",
    ], azureConfigDir)
    let response
    try { response = JSON.parse(raw) }
    catch (error) { throw new Error("Coordinator Azure CLI returned invalid JSON", { cause: error }) }
    if (typeof response?.accessToken !== "string" || !response.accessToken) {
      throw new Error("Coordinator Azure CLI returned no access token")
    }
    const expiresOn = Number(response.expires_on)
    cached = {
      token: response.accessToken,
      expiresAt: Number.isFinite(expiresOn) ? expiresOn * 1000 : Date.now() + 30 * 60 * 1000,
    }
    return cached.token
  }
  provider.invalidate = () => { cached = null }
  return provider
}

function tokenIdentity(token) {
  try {
    const parts = token.split(".")
    if (parts.length !== 3) throw new Error("not a JWT")
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
    const caller = claims.oid || claims.sub
    if (typeof caller !== "string" || !caller || typeof claims.tid !== "string" || !claims.tid) {
      throw new Error("missing oid/sub or tid")
    }
    return `${claims.tid.toLowerCase()}:${caller.toLowerCase()}`
  } catch (error) {
    throw new Error("Coordinator access token has no usable caller identity", { cause: error })
  }
}

async function responseError(response) {
  const text = (await response.text()).trim()
  const error = new Error(`Coordinator request failed (HTTP ${response.status})${text ? `: ${text.slice(0, 1000)}` : ""}`)
  error.status = response.status
  return error
}

function sleep(ms, signal, unref = true) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    if (unref) timer.unref?.()
    if (signal.aborted) done()
    else signal.addEventListener("abort", done, { once: true })
  })
}

function leasePrefix(origin, machineName) {
  const key = createHash("sha256")
    .update(["minicode-coordinator-lease-v1", origin, machineName.toLowerCase()].join("\0"))
    .digest("hex")
  return `minicode-coordinator-${key}-`
}

async function processIsAlive(pid) {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === "EPERM") return true
    if (error.code === "ESRCH") return false
    throw error
  }
}

async function createLeaseCandidate({ origin, machineName, leaseDir }) {
  await fs.mkdir(leaseDir, { recursive: true })
  const prefix = leasePrefix(origin, machineName)
  const candidate = {
    token: randomUUID(),
    pid: process.pid,
    createdAt: Date.now(),
  }
  const file = path.join(leaseDir, `${prefix}${candidate.token}.json`)
  await fs.writeFile(file, JSON.stringify(candidate), { encoding: "utf8", flag: "wx", mode: 0o600 })
  return { ...candidate, file, prefix }
}

async function electLeaseCandidate(candidate, leaseDir) {
  const contenders = []
  for (const name of await fs.readdir(leaseDir)) {
    if (!name.startsWith(candidate.prefix) || !name.endsWith(".json")) continue
    const file = path.join(leaseDir, name)
    let value
    try {
      value = JSON.parse(await fs.readFile(file, "utf8"))
    } catch {
      await fs.rm(file, { force: true })
      continue
    }
    if (!Number.isInteger(value.pid) || value.pid <= 0
      || !Number.isFinite(value.createdAt) || typeof value.token !== "string"
      || !await processIsAlive(value.pid)) {
      await fs.rm(file, { force: true })
      continue
    }
    contenders.push(value)
  }
  contenders.sort((left, right) => left.createdAt - right.createdAt || left.token.localeCompare(right.token))
  return contenders[0]?.token === candidate.token
}

export function updateCommandTarget(message) {
  if (message.senderKind !== 0) return null
  const match = /^\/update\s+@([A-Za-z0-9._-]+)\s*$/i.exec(String(message.text ?? ""))
  return match?.[1]?.toLowerCase() ?? null
}

export function shouldWake(message, member) {
  if (message.senderId === member.coordinatorId) return false
  if (![0, 1].includes(message.senderKind)) return false
  if (message.senderKind === 0) {
    if (/^\/alias(?:\s|$)/i.test(String(message.text ?? "").trim())) return false
    const updateTarget = updateCommandTarget(message)
    if (updateTarget) {
      return updateTarget === "all"
        || updateTarget === String(member.alias || member.name).toLowerCase()
    }
    if (message.audienceAll === true) return true
    if (Array.isArray(message.audienceCoordinatorIds)
      && message.audienceCoordinatorIds.length > 0) {
      return message.audienceCoordinatorIds.includes(member.coordinatorId)
    }
  }
  const text = String(message.text ?? "")
  const alias = String(member.alias || member.name)
  return new RegExp(`(^|\\s)@(?:all|${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?=\\s|[,:;.!?]|$)`, "i").test(text)
}

function recentConversation(snapshot) {
  return snapshot.messages.slice(-30).map(message =>
    `[${message.at}] ${message.senderName}: ${String(message.text).slice(0, 4000)}`).join("\n")
}

export function coordinatorMessagePrompt(message, member, snapshot) {
  const updateTarget = updateCommandTarget(message)
  return [
    `New coordinator-room message from ${message.senderName}:`,
    String(message.text),
    "",
    `You are addressed as @${member.alias || member.name}.`,
    ...(updateTarget ? [
      "",
      "This is an explicit coordinator update command. Locate the Minicode checkout that runs this machine's workers, fetch its configured upstream, and fast-forward only if clean and non-diverged. Verify zero active local assignments before arranging a delayed restart of this machine's canonical workers and coordinator. The delayed restart must begin only after you return the summary that will be posted to chat. Do not push, stash, reset, discard work, or mutate another machine.",
    ] : []),
    "",
    "Recent room conversation:",
    recentConversation(snapshot),
  ].join("\n")
}

async function startCoordinatorLeader({
  server, cwd, instanceKey, alias, harness, azureConfigDir, frontendTarget,
  machineName = os.hostname(), pollMs = DEFAULT_POLL_MS, heartbeatMs = DEFAULT_HEARTBEAT_MS,
  busyKeepaliveMs = DEFAULT_BUSY_KEEPALIVE_MS,
  fetchImpl = fetch, tokenProvider = createCoordinatorTokenProvider({ azureConfigDir }),
  frontendFactory = createCoordinatorFrontend,
  log = (message) => process.stderr.write(`${message}\n`),
}) {
  const origin = coordinatorServer(server)
  if (!path.isAbsolute(cwd)) throw new Error("Coordinator workspace must be an absolute path")
  const controller = new AbortController()
  let stopped = false
  let token = await tokenProvider()
  const coordinatorId = createHash("sha256")
    .update(["minicode-coordinator-v2", origin, machineName.toLowerCase(), tokenIdentity(token)].join("\0"))
    .digest("hex")

  async function request(route, options = {}, retry = true) {
    const response = await fetchImpl(new URL(route, origin), {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
      signal: controller.signal,
    })
    if (response.status === 401 && retry && typeof tokenProvider.invalidate === "function") {
      tokenProvider.invalidate()
      token = await tokenProvider()
      return request(route, options, false)
    }
    if (!response.ok) throw await responseError(response)
    return response.json()
  }

  async function join() {
    return request("/v1/coordinationrooms/default/join", {
      method: "POST",
      body: JSON.stringify({ coordinatorId, alias, machineName, agentSessionId: instanceKey }),
    })
  }

  async function setPresence(state, isTyping) {
    const updated = await request(
      `/v1/coordinationrooms/default/members/${encodeURIComponent(coordinatorId)}/presence`,
      {
        method: "POST",
        body: JSON.stringify({ state, isTyping }),
      },
    )
    if (!updated?.coordinatorId) throw new Error("Coordinator presence returned an invalid member")
    Object.assign(member, updated)
  }

  const joined = await join()
  let member = joined.member
  if (!member?.coordinatorId || !member?.name) throw new Error("Coordinator join returned an invalid member")
  const frontend = await frontendFactory({ coordinatorId, frontendTarget, cwd, signal: controller.signal })
  let snapshot
  try {
    snapshot = await request("/v1/coordinationrooms/default")
  } catch (error) {
    controller.abort()
    throw error
  }
  const seen = new Set(snapshot.messages.map(message => message.id))
  let lastHeartbeat = Date.now()
  let lastPresence = ""
  let lastPresenceAt = 0
  let lastProblem = null
  if (harness) log(`[coordinator:${member.name}] coordinator harness settings are obsolete; using the frontend only`)
  log(`[coordinator:${member.name}] attached to ${origin} as a frontend relay`)

  const finished = (async () => {
    while (!stopped) {
      await sleep(pollMs, controller.signal)
      if (stopped) break
      try {
        if (Date.now() - lastHeartbeat >= heartbeatMs) {
          try {
            const heartbeat = await request(`/v1/coordinationrooms/default/members/${encodeURIComponent(coordinatorId)}/heartbeat`, {
              method: "POST",
            })
            if (!heartbeat?.coordinatorId) throw new Error("Coordinator heartbeat returned an invalid member")
            Object.assign(member, heartbeat)
          } catch (error) {
            if (error.status !== 404) throw error
            const rejoined = await join()
            if (rejoined.member?.coordinatorId !== coordinatorId || !rejoined.member?.name) {
              throw new Error("Coordinator rejoin returned an invalid member")
            }
            Object.assign(member, rejoined.member)
            lastPresence = ""
            log(`[coordinator:${member.name}] rejoined ${origin}`)
          }
          lastHeartbeat = Date.now()
        }
        snapshot = await request("/v1/coordinationrooms/default")
        const currentMember = snapshot.members.find(value => value.coordinatorId === coordinatorId)
        if (currentMember) Object.assign(member, currentMember)
        for (const message of snapshot.messages) {
          if (seen.has(message.id)) continue
          if (!shouldWake(message, member)) {
            seen.add(message.id)
            continue
          }
          const updateTarget = updateCommandTarget(message)
          const responseAudience = updateTarget && updateTarget !== "all"
            ? { audienceAll: false, audienceCoordinatorIds: [member.coordinatorId] }
            : message.audienceAll || updateTarget === "all"
            ? { audienceAll: true, audienceCoordinatorIds: [] }
            : {
                audienceAll: false,
                audienceCoordinatorIds: Array.isArray(message.audienceCoordinatorIds)
                  && message.audienceCoordinatorIds.length > 0
                  ? message.audienceCoordinatorIds
                  : [member.coordinatorId],
              }
          await frontend.enqueue({
            messageId: message.id, prompt: coordinatorMessagePrompt(message, member, snapshot),
            audience: responseAudience,
          })
          seen.add(message.id)
          log(`[coordinator:${member.name}] queued message ${message.id} for the frontend`)
          await request("/v1/coordinationrooms/default/messages", {
            method: "POST",
            body: JSON.stringify({
              coordinatorId, text: `Queued for @${member.alias || member.name}'s frontend.`,
              hidden: true, ...responseAudience,
            }),
          })
        }
        const status = await frontend.poll()
        if (stopped) break
        if (status.problem !== lastProblem) {
          if (status.problem) log(`[coordinator:${member.name}] ${status.problem}`)
          else if (lastProblem) log(`[coordinator:${member.name}] frontend connection ready`)
          lastProblem = status.problem
        }
        const presence = { state: status.busy ? COORDINATOR_BUSY : COORDINATOR_IDLE, isTyping: status.isTyping }
        const presenceKey = JSON.stringify(presence)
        if (presenceKey !== lastPresence || member.state !== presence.state || member.isTyping !== presence.isTyping
          || Date.now() - lastPresenceAt >= busyKeepaliveMs) {
          await setPresence(presence.state, presence.isTyping)
          lastPresence = presenceKey
          lastPresenceAt = Date.now()
        }
        if (status.reply) {
          const reply = status.reply
          if (reply.text.trim() !== NO_REPLY) {
            await frontend.markPosting(reply.id)
            await request("/v1/coordinationrooms/default/messages", {
              method: "POST",
              body: JSON.stringify({ coordinatorId, text: reply.text, ...reply.audience }),
            })
            log(`[coordinator:${member.name}] frontend response posted`)
          } else log(`[coordinator:${member.name}] frontend requested no reply`)
          await frontend.acknowledge(reply.id)
        }
        // The room snapshot is the replay window; pending requests are durably owned by the relay.
        const currentIds = new Set(snapshot.messages.map(message => message.id))
        for (const id of seen) if (!currentIds.has(id)) seen.delete(id)
      } catch (error) {
        if (!stopped) log(`[coordinator:${member.name}] ${error.message}`)
      }
    }

  })()

  return {
    member,
    finished,
    async stop() {
      if (stopped) return
      stopped = true
      controller.abort()
      await finished
    },
  }
}

export async function startCoordinator(options) {
  const origin = coordinatorServer(options.server)
  const machineName = options.machineName ?? os.hostname()
  const leaseDir = options.leaseDir ?? os.tmpdir()
  const leasePollMs = options.leasePollMs ?? DEFAULT_LEASE_POLL_MS
  const leaseSettleMs = options.leaseSettleMs ?? DEFAULT_LEASE_SETTLE_MS
  const log = options.log ?? (message => process.stderr.write(`${message}\n`))
  const candidate = await createLeaseCandidate({ origin, machineName, leaseDir })
  const controller = new AbortController()
  let active = null
  let stopped = false

  async function reconcile() {
    const elected = await electLeaseCandidate(candidate, leaseDir)
    if (elected && !active) {
      active = await startCoordinatorLeader({ ...options, machineName })
      return
    }
    if (!elected && active) {
      await active.stop()
      active = null
    }
  }

  await sleep(leaseSettleMs, controller.signal, false)
  try {
    await reconcile()
  } catch (error) {
    await fs.rm(candidate.file, { force: true })
    throw error
  }
  if (!active) log(`[coordinator] standby on ${machineName}; another local process owns ${origin}`)

  const finished = (async () => {
    while (!stopped) {
      await sleep(leasePollMs, controller.signal)
      if (stopped) break
      try {
        await reconcile()
      } catch (error) {
        if (!stopped) log(`[coordinator] lease reconciliation failed: ${error.message}`)
      }
    }
  })()

  return {
    get member() { return active?.member ?? null },
    finished,
    async stop() {
      if (stopped) return
      stopped = true
      controller.abort()
      await active?.stop()
      active = null
      await fs.rm(candidate.file, { force: true })
      await finished
    },
  }
}
