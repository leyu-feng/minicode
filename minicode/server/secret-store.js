import net from "node:net"
import { randomBytes, timingSafeEqual } from "node:crypto"

// This store is shared by all tools in this process. The inherited capability is
// not an isolation boundary against arbitrary commands or other same-user code.
const MAX_REQUEST = 512 * 1024
const MAX_VALUE = 256 * 1024
const MAX_ENTRIES = 32
const TTL_MS = 8 * 60 * 60 * 1000
const KEY = /^[a-zA-Z0-9._:@/-]{1,200}$/

export async function startSecretStore() {
  const entries = new Map()
  const capability = randomBytes(32).toString("hex")
  const sweep = () => {
    const now = Date.now()
    for (const [key, entry] of entries) if (entry.expiresAt <= now) entries.delete(key)
  }
  const expiryTimer = setInterval(sweep, 60_000)
  expiryTimer.unref()
  const server = net.createServer((socket) => {
    let input = ""
    socket.setEncoding("utf8")
    socket.setTimeout(5000, () => socket.destroy())
    socket.on("error", () => {})
    socket.on("data", (chunk) => {
      input += chunk
      if (Buffer.byteLength(input) > MAX_REQUEST) { socket.destroy(); return }
      const end = input.indexOf("\n")
      if (end < 0) return
      socket.pause()
      let result
      try {
        const request = JSON.parse(input.slice(0, end))
        const supplied = typeof request.capability === "string" ? Buffer.from(request.capability) : Buffer.alloc(0)
        const expected = Buffer.from(capability)
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error("unauthorized")
        if (typeof request.key !== "string" || !KEY.test(request.key)) throw new Error("invalid key")
        sweep()
        const now = Date.now()
        if (request.op === "get") {
          result = { ok: true, value: entries.get(request.key)?.value ?? null }
        } else if (request.op === "set") {
          if (typeof request.value !== "string" || Buffer.byteLength(request.value) > MAX_VALUE) throw new Error("invalid value")
          if (!entries.has(request.key) && entries.size >= MAX_ENTRIES) throw new Error("store full")
          entries.set(request.key, { value: request.value, expiresAt: now + TTL_MS })
          result = { ok: true }
        } else if (request.op === "delete") {
          entries.delete(request.key)
          result = { ok: true }
        } else throw new Error("invalid operation")
      } catch {
        result = { ok: false }
      }
      socket.end(JSON.stringify(result) + "\n")
    })
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve() })
  })
  server.on("error", () => {})
  server.unref()
  return {
    env: { MINICODE_SECRET_STORE_PORT: String(server.address().port), MINICODE_SECRET_STORE_CAPABILITY: capability },
    close() { clearInterval(expiryTimer); entries.clear(); server.close() },
  }
}

let sharedStore
export async function secretStoreEnvironment() {
  sharedStore ??= startSecretStore().catch((error) => { sharedStore = undefined; throw error })
  return (await sharedStore).env
}
