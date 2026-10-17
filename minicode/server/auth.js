import childProcess from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const AZURE_OPENAI_RESOURCE = "https://cognitiveservices.azure.com"
export const DEFAULT_AZURE_MODEL = "gpt-5.6-sol"
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1000
const DEPLOYMENT_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i

const tokenCache = new Map()

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
  tokenCache.clear()
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

export async function addAzureDeployment({ name, model = DEFAULT_AZURE_MODEL, endpoint, activate = true, entraUser, tenant }) {
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
  if (tenant && !entraUser) throw new Error("--tenant requires --entra-user.")
  let credential = {}
  if (entraUser !== undefined) {
    const user = String(entraUser).trim()
    if (!/^[^\s@]+@[^\s@]+$/.test(user)) throw new Error("--entra-user must be a UPN (user@tenant).")
    if (tenant && !/^[a-z0-9][a-z0-9.-]*$/i.test(tenant)) throw new Error("Invalid Entra tenant ID or domain.")
    const key = createHash("sha256").update(JSON.stringify([user.toLowerCase(), tenant?.toLowerCase() || ""])).digest("hex")
    const azureConfigDir = path.resolve(configDir(), "azure-cli", key)
    credential = { credentialProvider: "azure-cli", user, ...(tenant ? { tenant } : {}), azureConfigDir }
    await loginAzureCli(credential)
  }

  const auth = await readAuth()
  const azure = auth["azure-entra"]
  azure.deployments[deploymentName] = {
    endpoint: url.toString().replace(/\/$/, ""),
    model: modelName,
    ...credential,
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
    ...credentialFields(deployment),
    user: deployment.user || "login@az.cli",
    provider: "azure-entra",
    active: auth.active?.provider === "azure-entra" && auth.active.name === name,
  }))
}

export async function getActiveAzureDeployment() {
  const auth = await readAuth()
  const azure = auth["azure-entra"]
  const name = process.env.MINICODE_AUTH_ENTRY || process.env.AZURE_OPENAI_DEPLOYMENT || azure.active
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
    ...credentialFields(deployment),
  }
}

export async function setActiveAuth(name) {
  return setActiveAzureDeployment(name)
}

export async function listAuthConfigs() {
  return listAzureDeployments()
}

export async function getActiveAuthSummary() {
  if (!process.env.MINICODE_AUTH_ENTRY && (process.env.OPENCODE_API_KEY || process.env.OPENAI_API_KEY)) {
    return {
      name: "API key",
      model: process.env.OPENCODE_MODEL || process.env.OPENAI_MODEL || "gpt-5.4",
      user: "API key",
      provider: "api-key",
    }
  }
  const azure = await getActiveAzureDeployment()
  return {
    ...azure, provider: "azure-entra", user: azure.user || "login@az.cli",
    model: process.env.OPENCODE_MODEL || process.env.AZURE_OPENAI_MODEL || azure.model,
  }
}

function credentialFields(deployment) {
  const provider = deployment.credentialProvider
  if (provider === "clippy-auth") {
    throw new Error("clippy-auth model profiles are no longer supported. Re-add this deployment with: minicode auth add <name> --entra-user <upn>")
  }
  if (provider && provider !== "azure-cli") {
    throw new Error(`Unknown credential provider "${provider}".`)
  }
  if (!deployment.azureConfigDir) return {}
  if (typeof deployment.user !== "string" || !deployment.user || typeof deployment.tenant !== "string" || !deployment.tenant) {
    throw new Error(`Incomplete ${provider} profile. Run: minicode auth add <name> --entra-user <upn>`)
  }
  if (typeof deployment.azureConfigDir !== "string" || !path.isAbsolute(deployment.azureConfigDir)) {
    throw new Error("Invalid Azure CLI cache directory. Run: minicode auth add <name> --entra-user <upn>")
  }
  if (!/^[a-f0-9-]{36}$/i.test(deployment.tenant)) throw new Error("Invalid saved Azure CLI tenant ID.")
  return {
    credentialProvider: provider,
    user: deployment.user,
    tenant: deployment.tenant,
    ...(deployment.azureConfigDir ? { azureConfigDir: deployment.azureConfigDir } : {}),
  }
}

function azureCliInvocation(args) {
  if (process.platform !== "win32") return { command: "az", args }
  const command = process.env.ComSpec || process.env.COMSPEC || "cmd.exe"
  return {
    command,
    args: ["/d", "/s", "/c", ["az", ...args].join(" ")],
  }
}

function runAzureCli(args, { inherit = false, profile } = {}) {
  const invocation = azureCliInvocation(args)
  const env = profile?.azureConfigDir
    ? { ...process.env, AZURE_CONFIG_DIR: profile.azureConfigDir, AZURE_CORE_LOGIN_EXPERIENCE_V2: "off" }
    : process.env
  if (inherit) {
    return new Promise((resolve, reject) => {
      const proc = childProcess.spawn(invocation.command, invocation.args, {
        stdio: "inherit",
        windowsHide: false,
        env,
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
      { encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024, env },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout)
          return
        }
        const detail = stderr.trim() || error.message
        reject(new Error(`Azure CLI authentication failed: ${detail}\nRun: ${profile?.azureConfigDir ? "minicode auth login" : "az login"}`, { cause: error }))
      },
    )
  })
}

async function verifyAzureCliAccount(profile) {
  let account
  try {
    account = JSON.parse(await runAzureCli(["account", "show", "--output", "json"], { profile }))
  } catch (error) {
    throw new Error(`Could not read the selected Azure CLI account: ${error.message}`, { cause: error })
  }
  if (account?.user?.type !== "user" || account.user.name?.toLowerCase() !== profile.user.toLowerCase()) {
    throw new Error(`Azure CLI did not sign in as ${profile.user}. Run: minicode auth add <name> --entra-user ${profile.user}`)
  }
  if (typeof account.tenantId !== "string" || !/^[a-f0-9-]{36}$/i.test(account.tenantId)) {
    throw new Error("Azure CLI returned an invalid tenant ID.")
  }
  if (profile.tenant && /^[a-f0-9-]{36}$/i.test(profile.tenant) && account.tenantId.toLowerCase() !== profile.tenant.toLowerCase()) {
    throw new Error("Azure CLI selected a different tenant.")
  }
  return account
}

function verifyAzureTokenIdentity(accessToken, profile) {
  let claims
  try {
    const parts = accessToken.split(".")
    if (parts.length !== 3) throw new Error("Not a JWT")
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
  } catch {
    throw new Error("Azure CLI returned a token whose identity claims could not be read.")
  }
  const user = claims?.preferred_username || claims?.upn || claims?.unique_name
  if (typeof user !== "string" || user.toLowerCase() !== profile.user.toLowerCase()) {
    throw new Error(`Azure CLI token does not identify the requested user ${profile.user}. Run: minicode auth login`)
  }
  if (typeof claims?.tid !== "string" || claims.tid.toLowerCase() !== profile.tenant.toLowerCase()) {
    throw new Error("Azure CLI token identifies a different or missing tenant. Run: minicode auth login")
  }
}

export async function getAzureAccessToken(profile) {
  profile ||= await getActiveAzureDeployment()
  credentialFields(profile)
  const cacheKey = JSON.stringify([
    authFilePath(), AZURE_OPENAI_RESOURCE,
    profile.user?.toLowerCase(), profile.tenant?.toLowerCase(), profile.azureConfigDir,
  ])
  const cached = tokenCache.get(cacheKey)
  if (cached && cached.expires > Date.now() + TOKEN_EXPIRY_MARGIN_MS) return cached.token

  if (profile.azureConfigDir) await verifyAzureCliAccount(profile)
  const output = await runAzureCli([
    "account",
    "get-access-token",
    "--resource",
    AZURE_OPENAI_RESOURCE,
    ...(profile.azureConfigDir ? ["--tenant", profile.tenant] : []),
    "--output",
    "json",
  ], { profile })
  let token
  try {
    token = JSON.parse(output)
  } catch (error) {
    throw new Error("Azure CLI returned an invalid access-token response.", { cause: error })
  }
  if (!token || typeof token.accessToken !== "string" || !token.accessToken) {
    throw new Error("Azure CLI did not return an access token.")
  }
  if (profile.azureConfigDir) {
    if (typeof token.tenant !== "string" || token.tenant.toLowerCase() !== profile.tenant.toLowerCase()) {
      throw new Error("Azure CLI returned a token for a different tenant.")
    }
    verifyAzureTokenIdentity(token.accessToken, profile)
  }

  const expiresOn = Number(token.expires_on)
  if (profile.azureConfigDir && (!Number.isFinite(expiresOn) || expiresOn * 1000 <= Date.now())) {
    throw new Error("Azure CLI returned an invalid or expired access token. Run: minicode auth login")
  }
  tokenCache.set(cacheKey, {
    token: token.accessToken,
    expires: Number.isFinite(expiresOn) ? expiresOn * 1000 : Date.now() + 30 * 60 * 1000,
  })
  return token.accessToken
}

export async function loginAzureCli(profile = {}) {
  if (profile.azureConfigDir) {
    await fs.mkdir(profile.azureConfigDir, { recursive: true })
    console.error(`Sign in to Azure CLI as ${profile.user}. Select that account in the sign-in dialog.`)
  }
  await runAzureCli(["login", ...(profile.tenant ? ["--tenant", profile.tenant] : []),
    ...(profile.azureConfigDir ? ["--allow-no-subscriptions", "--output", "none"] : [])], { inherit: true, profile })
  if (profile.azureConfigDir) {
    const account = await verifyAzureCliAccount(profile)
    profile.tenant = account.tenantId
  }
  tokenCache.clear()
  await getAzureAccessToken(profile)
}

export async function loginActiveDeployment() {
  const profile = await getActiveAzureDeployment()
  await loginAzureCli(profile)
  return { ...profile, user: profile.user || "login@az.cli" }
}

export async function resolveModelConfig() {
  const envKey = process.env.MINICODE_AUTH_ENTRY ? undefined : process.env.OPENCODE_API_KEY || process.env.OPENAI_API_KEY
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
  const getAccessToken = () => getAzureAccessToken(deployment)
  await getAccessToken()
  return {
    api: "responses",
    deployment: deployment.name,
    endpoint: (process.env.AZURE_OPENAI_ENDPOINT || deployment.endpoint).replace(/\/$/, ""),
    getAccessToken,
    model: process.env.OPENCODE_MODEL || process.env.AZURE_OPENAI_MODEL || deployment.model,
    user: deployment.user || "login@az.cli",
    ...(deployment.azureConfigDir ? { azureConfigDir: deployment.azureConfigDir } : {}),
  }
}
