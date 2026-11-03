import fs from "node:fs/promises"
import path from "node:path"
import { createServer } from "node:http"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { skillDigest } from "./skill-integrity.js"

export async function startHostedKustoSkill({ workspace, getToken, signal, onError }) {
  const cache = path.join(workspace, ".worker")
  await fs.mkdir(cache, { recursive: true })
  if ((await fs.lstat(cache)).isSymbolicLink()) throw new Error("Hosted Kusto cache must not be a link")
  const directory = await fs.mkdtemp(path.join(cache, "kusto-"))
  let server
  try {
    for (const file of ["SKILL.md", "query.ps1"]) {
      await fs.copyFile(new URL(`./kusto-skill/${file}`, import.meta.url), path.join(directory, file))
    }
    const skill = { name: "platform/kusto", source: "platform", file: path.join(directory, "SKILL.md"),
      sha256: await skillDigest(directory) }
    const capability = randomBytes(32).toString("hex")
    server = createServer((request, response) => {
      const json = (status, body) => {
        response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
        response.end(JSON.stringify(body))
      }
      void (async () => {
        if (request.method !== "POST" || request.url !== "/v1/kusto/token") return json(404, { error: "Unknown Kusto token operation" })
        const supplied = Buffer.from(request.headers.authorization ?? "")
        const expected = Buffer.from(`Bearer ${capability}`)
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json(401, { error: "Run capability required" })
        let body = ""
        for await (const chunk of request) {
          body += chunk.toString("utf8")
          if (Buffer.byteLength(body) > 1024) return json(413, { error: "Kusto token request exceeds 1 KiB" })
        }
        let input
        try { input = JSON.parse(body) }
        catch { return json(400, { error: "Expected an empty JSON object" }) }
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 0) {
          return json(400, { error: "Kusto token requests do not accept resource or identity overrides" })
        }
        signal.throwIfAborted()
        const token = await getToken({ signal })
        signal.throwIfAborted()
        if (typeof token?.accessToken !== "string" || !token.accessToken
          || token.tokenType !== "Bearer" || !(Date.parse(token.expiresOn) > Date.now())) {
          throw new Error("Invalid worker Kusto token response")
        }
        json(200, { accessToken: token.accessToken, tokenType: token.tokenType, expiresOn: token.expiresOn })
      })().catch(() => {
        onError("Worker Kusto token issuance failed; no alternate authentication was attempted.")
        if (!response.headersSent) json(502, { error: "Worker Kusto token issuance failed" })
        else response.destroy()
      })
    })
    await new Promise((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    server.unref()
    let closing
    return {
      skill,
      env: {
        WORKER_KUSTO_TOKEN_URL: `http://127.0.0.1:${server.address().port}/v1/kusto/token`,
        WORKER_KUSTO_TOKEN_CAPABILITY: capability,
      },
      close() {
        return closing ??= (async () => {
          await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
          await fs.rm(directory, { recursive: true, force: true })
        })()
      },
    }
  } catch (error) {
    server?.close()
    await fs.rm(directory, { recursive: true, force: true })
    throw error
  }
}
