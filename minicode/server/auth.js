import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const CLIENT_ID = "Ov23li8tweQw6odWQebz"
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000

function normalizeDomain(value) {
  if (!value) return undefined
  return String(value).replace(/^https?:\/\//, "").replace(/\/$/, "")
}

function dataDir() {
  if (process.env.XDG_DATA_HOME) return path.join(process.env.XDG_DATA_HOME, "opencode")
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || process.env.APPDATA
    if (base) return path.join(base, "opencode")
  }
  return path.join(os.homedir(), ".local", "share", "opencode")
}

export function authFilePath() {
  return path.join(dataDir(), "auth.json")
}

export async function readAuth() {
  try {
    const raw = await fs.readFile(authFilePath(), "utf8")
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

async function writeAuth(data) {
  await fs.mkdir(path.dirname(authFilePath()), { recursive: true })
  await fs.writeFile(authFilePath(), JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 })
}

/* ----------------------------------------------------------------- oauth */

/**
 * GitHub device-code flow. `onPrompt` receives the verification URL and user
 * code so callers can render it however they like.
 */
export async function loginGithubCopilot({ provider, enterpriseUrl, onPrompt = () => {} } = {}) {
  if (provider && provider !== "github-copilot") {
    throw new Error(`Unsupported provider: ${provider}. Only github-copilot is supported.`)
  }

  const domain = enterpriseUrl ? normalizeDomain(enterpriseUrl) : "github.com"
  const deviceCodeUrl = `https://${domain}/login/device/code`
  const accessTokenUrl = `https://${domain}/login/oauth/access_token`
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "minicode",
  }

  const deviceResponse = await fetch(deviceCodeUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ client_id: CLIENT_ID, scope: "read:user" }),
  })
  if (!deviceResponse.ok) {
    throw new Error(`Failed to initiate GitHub device authorization (${deviceResponse.status}).`)
  }

  const deviceData = await deviceResponse.json()
  onPrompt({ verificationUri: deviceData.verification_uri, userCode: deviceData.user_code })

  for (;;) {
    const response = await fetch(accessTokenUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: deviceData.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    })
    if (!response.ok) throw new Error(`OAuth polling failed (${response.status}).`)

    const tokenData = await response.json()
    if (tokenData.access_token) {
      const auth = await readAuth()
      auth["github-copilot"] = {
        type: "oauth",
        refresh: tokenData.access_token,
        access: tokenData.access_token,
        expires: 0,
        ...(enterpriseUrl ? { enterpriseUrl: domain } : {}),
      }
      await writeAuth(auth)
      return { provider: "github-copilot", path: authFilePath() }
    }

    if (tokenData.error && tokenData.error !== "authorization_pending" && tokenData.error !== "slow_down") {
      throw new Error(`OAuth failed: ${tokenData.error}`)
    }

    const intervalSeconds =
      tokenData.error === "slow_down" && typeof tokenData.interval === "number" && tokenData.interval > 0
        ? tokenData.interval
        : (deviceData.interval || 5) + (tokenData.error === "slow_down" ? 5 : 0)
    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS))
  }
}

export async function listProviders() {
  const auth = await readAuth()
  return Object.keys(auth).map((provider) => ({ provider, type: auth[provider]?.type || "unknown" }))
}

export async function logoutProvider(provider = "github-copilot") {
  const auth = await readAuth()
  if (!auth[provider]) return false
  delete auth[provider]
  await writeAuth(auth)
  return true
}

/* ----------------------------------------------------------------- model */

export async function resolveModelConfig() {
  const envKey = process.env.OPENCODE_API_KEY || process.env.OPENAI_API_KEY
  if (envKey) {
    return {
      apiKey: envKey,
      baseUrl: (process.env.OPENCODE_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.githubcopilot.com").replace(
        /\/$/,
        "",
      ),
      model: process.env.OPENCODE_MODEL || process.env.OPENAI_MODEL || "claude-opus-4.8",
    }
  }

  const authPath = authFilePath()
  const copilot = (await readAuth())["github-copilot"]
  if (!copilot?.refresh) {
    throw new Error(`No github-copilot credential in ${authPath}. Run: minicode auth login`)
  }

  const domain = normalizeDomain(copilot.enterpriseUrl)
  return {
    apiKey: copilot.refresh,
    baseUrl: domain ? `https://copilot-api.${domain}` : "https://api.githubcopilot.com",
    model: process.env.OPENCODE_MODEL || "claude-opus-4.8",
  }
}
