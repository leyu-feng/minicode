import http from "node:http"
import { randomBytes, timingSafeEqual } from "node:crypto"

// This store is shared by all tools holding its capability. It is a convenience
// for trusted local processes, not an isolation boundary against same-user code.
const MAX_REQUEST = 512 * 1024
const MAX_VALUE = 256 * 1024
const MAX_ENTRIES = 32
const TTL_MS = 8 * 60 * 60 * 1000
const KEY = /^[a-zA-Z0-9._:@/-]{1,200}$/

function authorized(header, capability) {
  const match = /^Bearer ([a-f0-9]{64})$/.exec(header || "")
  if (!match) return false
  const supplied = Buffer.from(match[1])
  const expected = Buffer.from(capability)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

export async function startSecretStore() {
  const entries = new Map()
  const capability = randomBytes(32).toString("hex")
  const sweep = () => {
    const now = Date.now()
    for (const [key, entry] of entries) if (entry.expiresAt <= now) entries.delete(key)
  }
  const expiryTimer = setInterval(sweep, 60_000)
  expiryTimer.unref()
  const server = http.createServer((request, response) => {
    const fail = (status = 400) => {
      response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
      response.end(JSON.stringify({ ok: false }))
    }
    if (request.method !== "POST" || request.url !== "/v1/secrets") return fail(404)
    if (!authorized(request.headers.authorization, capability)) return fail(401)
    let input = ""
    request.setEncoding("utf8")
    request.on("data", chunk => {
      input += chunk
      if (Buffer.byteLength(input) > MAX_REQUEST) request.destroy()
    })
    request.on("end", () => {
      let result
      try {
        const body = JSON.parse(input)
        if (typeof body.key !== "string" || !KEY.test(body.key)) throw new Error("invalid key")
        sweep()
        const now = Date.now()
        if (body.op === "get") {
          result = { ok: true, value: entries.get(body.key)?.value ?? null }
        } else if (body.op === "set") {
          if (typeof body.value !== "string" || Buffer.byteLength(body.value) > MAX_VALUE) throw new Error("invalid value")
          if (!entries.has(body.key) && entries.size >= MAX_ENTRIES) throw new Error("store full")
          entries.set(body.key, { value: body.value, expiresAt: now + TTL_MS })
          result = { ok: true }
        } else if (body.op === "delete") {
          entries.delete(body.key)
          result = { ok: true }
        } else throw new Error("invalid operation")
      } catch {
        return fail()
      }
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
      response.end(JSON.stringify(result))
    })
    request.on("error", () => {})
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve() })
  })
  server.on("error", () => {})
  server.unref()
  const port = String(server.address().port)
  return {
    env: {
      MINICODE_SECRET_STORE_URL: `http://127.0.0.1:${port}/v1/secrets`,
      MINICODE_SECRET_STORE_CAPABILITY: capability,
    },
    close() { clearInterval(expiryTimer); entries.clear(); server.close() },
  }
}

let sharedStore
export async function secretStoreEnvironment() {
  const url = process.env.MINICODE_ORCHESTRATOR_SECRET_STORE_URL
  const capability = process.env.MINICODE_ORCHESTRATOR_SECRET_STORE_CAPABILITY
  if (/^http:\/\/127\.0\.0\.1:\d+\/v1\/secrets$/.test(url || "") && /^[a-f0-9]{64}$/.test(capability || "")) {
    return { MINICODE_SECRET_STORE_URL: url, MINICODE_SECRET_STORE_CAPABILITY: capability }
  }
  sharedStore ??= startSecretStore().catch((error) => { sharedStore = undefined; throw error })
  return (await sharedStore).env
}
