import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

function normalizeDomain(value) {
  if (!value) return undefined
  return String(value).replace(/^https?:\/\//, "").replace(/\/$/, "")
}

function authFilePath() {
  if (process.env.XDG_DATA_HOME) return path.join(process.env.XDG_DATA_HOME, "opencode", "auth.json")
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || process.env.APPDATA
    if (base) return path.join(base, "opencode", "auth.json")
  }
  return path.join(os.homedir(), ".local", "share", "opencode", "auth.json")
}

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
  const raw = await fs.readFile(authPath, "utf8")
  const data = JSON.parse(raw)
  const copilot = data?.["github-copilot"]
  if (!copilot?.refresh) {
    throw new Error(`No github-copilot credential in ${authPath}. Run: .\\minicode.ps1 auth login --provider github-copilot`)
  }

  const domain = normalizeDomain(copilot.enterpriseUrl)
  return {
    apiKey: copilot.refresh,
    baseUrl: domain ? `https://copilot-api.${domain}` : "https://api.githubcopilot.com",
    model: process.env.OPENCODE_MODEL || "claude-opus-4.8",
  }
}
