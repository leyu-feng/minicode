import childProcess from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const AZURE_OPENAI_RESOURCE = "https://cognitiveservices.azure.com"
export const DEFAULT_AZURE_MODEL = "gpt-5.6-sol"
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1000
const DEPLOYMENT_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i

let cachedToken
let cachedTokenExpires = 0

function configDir() {
  if (process.env.MINICODE_CONFIG_HOME) return process.env.MINICODE_CONFIG_HOME
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, "minicode")
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || process.env.APPDATA
    if (base) return path.join(base, "minicode")
  }
  return path.join(os.homedir(), ".config", "minicode")
}

export function authFilePath() {
  return path.join(configDir(), "auth.json")
}

function emptyAuth() {
  return {
    active: null,
    "azure-entra": { active: null, deployments: {} },
  }
}

export async function readAuth() {
  let raw
  try {
    raw = await fs.readFile(authFilePath(), "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") return emptyAuth()
    throw new Error(`Could not read ${authFilePath()}: ${error.message}`, { cause: error })
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`Invalid JSON in ${authFilePath()}: ${error.message}`, { cause: error })
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid auth configuration in ${authFilePath()}.`)
  }
  const azure = parsed["azure-entra"]
  if (!azure || typeof azure !== "object" || Array.isArray(azure)) {
    parsed["azure-entra"] = emptyAuth()["azure-entra"]
  } else if (!azure.deployments || typeof azure.deployments !== "object" || Array.isArray(azure.deployments)) {
    azure.deployments = {}
  }
  if (!parsed.active && parsed["azure-entra"].active) {
    parsed.active = { provider: "azure-entra", name: parsed["azure-entra"].active }
  }
  if (parsed["github-copilot"]) {
    delete parsed["github-copilot"]
    if (parsed.active?.provider !== "azure-entra") {
      parsed.active = parsed["azure-entra"].active
        ? { provider: "azure-entra", name: parsed["azure-entra"].active }
        : null
    }
    await writeAuth(parsed)
  }
  return parsed
}

async function writeAuth(auth) {
  const file = authFilePath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(auth, null, 2), { encoding: "utf8", mode: 0o600 })
}

export async function clearAuth() {
  try {
    await fs.unlink(authFilePath())
    return true
  } catch (error) {
    if (error?.code === "ENOENT") return false
    throw new Error(`Could not clear ${authFilePath()}: ${error.message}`, { cause: error })
  }
}

function validateDeploymentName(name) {
  const value = String(name || "").trim()
  if (!DEPLOYMENT_NAME_PATTERN.test(value)) {
    throw new Error("Azure deployment name must contain only letters, numbers, and hyphens.")
  }
  return value
}

function deploymentEndpoint(name) {
  return `https://${name}.services.ai.azure.com/openai/v1/responses`
}

export async function addAzureDeployment({ name, model = DEFAULT_AZURE_MODEL, endpoint, activate = true }) {
  const deploymentName = validateDeploymentName(name)
  const modelName = String(model || "").trim()
  if (!modelName) throw new Error("Azure model name is required.")
  const resolvedEndpoint = String(endpoint || deploymentEndpoint(deploymentName)).replace(/\/$/, "")
  let url
  try {
    url = new URL(resolvedEndpoint)
  } catch (error) {
    throw new Error(`Invalid Azure Responses endpoint: ${resolvedEndpoint}`, { cause: error })
  }
  if (url.protocol !== "https:" || !url.pathname.endsWith("/openai/v1/responses")) {
    throw new Error("Azure endpoint must use HTTPS and end with /openai/v1/responses.")
  }

  const auth = await readAuth()
  const azure = auth["azure-entra"]
  azure.deployments[deploymentName] = {
    endpoint: url.toString().replace(/\/$/, ""),
    model: modelName,
  }
  if (activate || !azure.active) azure.active = deploymentName
  if (activate || !auth.active) auth.active = { provider: "azure-entra", name: deploymentName }
  await writeAuth(auth)
  return {
    name: deploymentName,
    ...azure.deployments[deploymentName],
    active: auth.active.provider === "azure-entra" && auth.active.name === deploymentName,
  }
}

export async function setActiveAzureDeployment(name) {
  const deploymentName = validateDeploymentName(name)
  const auth = await readAuth()
  const azure = auth["azure-entra"]
  if (!azure.deployments[deploymentName]) {
    throw new Error(`Unknown Azure deployment "${deploymentName}". Run: minicode auth list`)
  }
  azure.active = deploymentName
  auth.active = { provider: "azure-entra", name: deploymentName }
  await writeAuth(auth)
  return { name: deploymentName, ...azure.deployments[deploymentName], active: true }
}

export async function listAzureDeployments() {
  const auth = await readAuth()
  const azure = auth["azure-entra"]
  return Object.entries(azure.deployments).map(([name, deployment]) => ({
    name,
    endpoint: deployment.endpoint,
    model: deployment.model,
    provider: "azure-entra",
    active: auth.active?.provider === "azure-entra" && auth.active.name === name,
  }))
}

export async function getActiveAzureDeployment() {
  const auth = await readAuth()
  const azure = auth["azure-entra"]
  const name = process.env.AZURE_OPENAI_DEPLOYMENT || azure.active
  if (!name) {
    const error = new Error(`No Azure deployment configured. Run: minicode auth add`)
    error.code = "MINICODE_AUTH_SETUP_REQUIRED"
    throw error
  }
  const deployment = azure.deployments[name]
  if (!deployment) {
    throw new Error(`Azure deployment "${name}" is not configured. Run: minicode auth list`)
  }
  return {
    name,
    endpoint: deployment.endpoint,
    model: deployment.model,
  }
}

export async function setActiveAuth(name) {
  return setActiveAzureDeployment(name)
}

export async function listAuthConfigs() {
  return listAzureDeployments()
}

export async function getActiveAuthSummary() {
  const azure = await getActiveAzureDeployment()
  return { ...azure, provider: "azure-entra" }
}

function azureCliInvocation(args) {
  if (process.platform !== "win32") return { command: "az", args }
  const command = process.env.ComSpec || process.env.COMSPEC || "cmd.exe"
  return {
    command,
    args: ["/d", "/s", "/c", ["az", ...args].join(" ")],
  }
}

function runAzureCli(args, { inherit = false } = {}) {
  const invocation = azureCliInvocation(args)
  if (inherit) {
    return new Promise((resolve, reject) => {
      const proc = childProcess.spawn(invocation.command, invocation.args, {
        stdio: "inherit",
        windowsHide: false,
      })
      proc.on("error", reject)
      proc.on("exit", (code) => {
        if (code === 0) resolve()
        else reject(new Error(`Azure CLI exited with code ${code ?? 1}.`))
      })
    })
  }

  return new Promise((resolve, reject) => {
    childProcess.execFile(
      invocation.command,
      invocation.args,
      { encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout)
          return
        }
        const detail = stderr.trim() || error.message
        reject(new Error(`Azure CLI authentication failed: ${detail}\nRun: az login`, { cause: error }))
      },
    )
  })
}

export async function getAzureAccessToken() {
  if (cachedToken && cachedTokenExpires > Date.now() + TOKEN_EXPIRY_MARGIN_MS) return cachedToken

  const output = await runAzureCli([
    "account",
    "get-access-token",
    "--resource",
    AZURE_OPENAI_RESOURCE,
    "--output",
    "json",
  ])
  let token
  try {
    token = JSON.parse(output)
  } catch (error) {
    throw new Error("Azure CLI returned an invalid access-token response.", { cause: error })
  }
  if (typeof token.accessToken !== "string" || !token.accessToken) {
    throw new Error("Azure CLI did not return an access token. Run: az login")
  }

  cachedToken = token.accessToken
  const expiresOn = Number(token.expires_on)
  cachedTokenExpires = Number.isFinite(expiresOn) ? expiresOn * 1000 : Date.now() + 30 * 60 * 1000
  return cachedToken
}

export async function loginAzureCli() {
  await runAzureCli(["login"], { inherit: true })
  cachedToken = undefined
  cachedTokenExpires = 0
  await getAzureAccessToken()
}

export async function resolveModelConfig() {
  const envKey = process.env.OPENCODE_API_KEY || process.env.OPENAI_API_KEY
  if (envKey) {
    const baseUrl =
      process.env.OPENCODE_BASE_URL ||
      process.env.OPENAI_BASE_URL ||
      (process.env.OPENAI_API_KEY ? "https://api.openai.com/v1" : undefined)
    if (!baseUrl) throw new Error("OPENCODE_BASE_URL is required when OPENCODE_API_KEY is set.")
    return {
      api: "chat-completions",
      apiKey: envKey,
      endpoint: `${baseUrl.replace(/\/$/, "")}/chat/completions`,
      model: process.env.OPENCODE_MODEL || process.env.OPENAI_MODEL || "gpt-5.4",
    }
  }

  const deployment = await getActiveAzureDeployment()
  await getAzureAccessToken()
  return {
    api: "responses",
    deployment: deployment.name,
    endpoint: (process.env.AZURE_OPENAI_ENDPOINT || deployment.endpoint).replace(/\/$/, ""),
    getAccessToken: getAzureAccessToken,
    model: process.env.OPENCODE_MODEL || process.env.AZURE_OPENAI_MODEL || deployment.model,
  }
}
