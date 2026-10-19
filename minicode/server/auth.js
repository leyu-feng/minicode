import childProcess from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import timers from "node:timers/promises"
import { httpErrorDetails } from "./http-error.js"

const AZURE_OPENAI_RESOURCE = "https://cognitiveservices.azure.com"
export const DEFAULT_AZURE_MODEL = "gpt-5.6-sol"
export const COPILOT_AUTH_NAME = "@copilot"
const COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98"
// Check https://github.com/ericc-ch/copilot-api/blob/master/src/lib/api-config.ts for version updates.
const COPILOT_VERSION = "0.26.7"
const EDITOR_PLUGIN_VERSION = `copilot-chat/${COPILOT_VERSION}`
const USER_AGENT = `GitHubCopilotChat/${COPILOT_VERSION}`
const API_VERSION = "2025-04-01"
const GITHUB_REST_API_VERSION = "2022-11-28"
const VSCODE_COMPATIBILITY_VERSION = "1.104.3"
const COPILOT_HEADERS = {
  "Copilot-Integration-Id": "vscode-chat",
  "Editor-Version": `vscode/${VSCODE_COMPATIBILITY_VERSION}`,
  "Editor-Plugin-Version": EDITOR_PLUGIN_VERSION,
  "User-Agent": USER_AGENT,
  "X-GitHub-Api-Version": API_VERSION,
  "Openai-Intent": "conversation-panel",
  "X-Vscode-User-Agent-Library-Version": "electron-fetch",
}
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
  if (name === COPILOT_AUTH_NAME) {
    const auth = await readAuth()
    const profile = copilotSummary(auth)
    auth.active = { provider: "github-copilot", name: COPILOT_AUTH_NAME }
    await writeAuth(auth)
    return { ...profile, active: true }
  }
  return setActiveAzureDeployment(name)
}

export async function listAuthConfigs() {
  const auth = await readAuth()
  return [
    ...await listAzureDeployments(),
    ...(auth["github-copilot"] ? [{
      ...copilotSummary(auth),
      active: auth.active?.provider === "github-copilot",
    }] : []),
  ]
}

function selectedAuthName(auth) {
  return process.env.MINICODE_AUTH_ENTRY || process.env.AZURE_OPENAI_DEPLOYMENT
    || (auth.active?.provider === "github-copilot" ? COPILOT_AUTH_NAME : auth.active?.name)
    || auth["azure-entra"].active
}

function copilotSummary(auth) {
  const entry = auth["github-copilot"]
  if (typeof entry?.refresh !== "string" || !entry.refresh.trim()) {
    throw new Error("Copilot is not configured. Run: minicode auth add --copilot")
  }
  if (entry.enterpriseUrl) {
    throw new Error("Legacy enterprise Copilot profiles are not supported. Run: minicode auth add --copilot")
  }
  if (typeof entry.model !== "string" || !entry.model.trim()) {
    throw new Error("Copilot has no selected model. Run: minicode auth add --copilot")
  }
  return {
    name: COPILOT_AUTH_NAME,
    model: entry.model,
    user: entry.user || "login@github.com",
    provider: "github-copilot",
  }
}

async function copilotRequest(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30_000) })
  if (!response.ok) {
    const secrets = [options.headers?.Authorization?.replace(/^(?:Bearer|token)\s+/i, "")]
    if (options.body) secrets.push(JSON.parse(options.body).device_code)
    const detail = await httpErrorDetails(response, secrets)
    throw new Error(`Copilot authentication request failed (HTTP ${response.status}) at ${url}:\n${detail}\nRun: minicode auth login`)
  }
  return response.json()
}

async function getCopilotAccessToken(entry) {
  const key = `copilot:${createHash("sha256").update(entry.refresh).digest("hex")}`
  const cached = tokenCache.get(key)
  if (cached && cached.expires > Date.now()) return cached.token
  const now = Date.now()
  const credential = await copilotRequest("https://api.github.com/copilot_internal/v2/token", {
    headers: { ...COPILOT_HEADERS, Accept: "application/json",
      "X-GitHub-Api-Version": GITHUB_REST_API_VERSION,
      Authorization: `token ${entry.refresh}` },
  })
  if (typeof credential?.token !== "string" || !credential.token.trim()
    || !Number.isFinite(credential.expires_at) || credential.expires_at * 1000 <= Date.now()
    || !Number.isFinite(credential.refresh_in) || credential.refresh_in <= 0) {
    throw new Error("Copilot returned an invalid or expired API credential. Run: minicode auth login --copilot")
  }
  tokenCache.set(key, {
    token: credential.token,
    expires: Math.min(credential.expires_at * 1000, now + credential.refresh_in * 1000) - 60_000,
  })
  return credential.token
}

async function copilotModels(entry) {
  const headers = { ...COPILOT_HEADERS, "X-Request-Id": randomUUID(),
    Authorization: `Bearer ${await getCopilotAccessToken(entry)}` }
  const catalog = await copilotRequest("https://api.githubcopilot.com/models", { headers })
  if (!Array.isArray(catalog?.data)) throw new Error("Copilot returned an invalid model catalog.")
  return catalog.data
}

function copilotModelApi(remote) {
  const endpoints = remote.supported_endpoints
  if (endpoints !== undefined) {
    if (!Array.isArray(endpoints)) return undefined
    if (endpoints.includes("/responses")) return "responses"
    if (endpoints.includes("/chat/completions")) return "chat-completions"
    return undefined
  }
  // Older catalogs omit endpoints; match the existing OpenCode Copilot routing.
  const gpt = /^gpt-(\d+)/.exec(remote.id)
  return gpt && Number(gpt[1]) >= 5 && !remote.id.startsWith("gpt-5-mini") ? "responses" : "chat-completions"
}

async function copilotModelConfig(entry, model, models) {
  models ||= await copilotModels(entry)
  const remote = models.find(item => item?.id === model)
  if (!remote) throw new Error(`Copilot model "${model}" is not available for this account. Select an available model with --model.`)
  if (remote.policy?.state === "disabled") throw new Error(`Copilot model "${model}" is disabled. Enable it in GitHub Copilot settings.`)
  const api = copilotModelApi(remote)
  if (!api) {
    throw new Error(`Copilot model "${model}" does not support Responses or Chat Completions. Select another model with --model.`)
  }
  return {
    api,
    endpoint: `https://api.githubcopilot.com/${api === "responses" ? "responses" : "chat/completions"}`,
    getAccessToken: () => getCopilotAccessToken(entry),
    deployment: COPILOT_AUTH_NAME,
    provider: "github-copilot",
    model,
    user: entry.user || "login@github.com",
    headers: COPILOT_HEADERS,
  }
}

export async function addCopilotAuth({ model, selectModel, onPrompt, activate = true } = {}) {
  if (model !== undefined && (typeof model !== "string" || !model.trim())) throw new Error("Copilot model name is required.")
  if (model === undefined && typeof selectModel !== "function") {
    throw new Error("Select a Copilot model interactively or use: minicode auth add --copilot --model <id>")
  }
  if (typeof onPrompt !== "function") throw new Error("Copilot sign-in requires a device-code prompt.")
  const headers = { Accept: "application/json", "Content-Type": "application/json" }
  const device = await copilotRequest("https://github.com/login/device/code", {
    method: "POST", headers, body: JSON.stringify({ client_id: COPILOT_CLIENT_ID, scope: "read:user" }),
  })
  if (typeof device?.device_code !== "string" || !device.device_code
    || typeof device.user_code !== "string" || !device.user_code
    || device.verification_uri !== "https://github.com/login/device"
    || !Number.isFinite(device.expires_in) || device.expires_in <= 0
    || (device.interval !== undefined && (!Number.isFinite(device.interval) || device.interval <= 0))) {
    throw new Error("GitHub returned an invalid device-authorization response.")
  }
  const expires = Date.now() + device.expires_in * 1000
  let interval = device.interval ?? 5
  await onPrompt({ verificationUri: device.verification_uri, userCode: device.user_code })
  while (Date.now() < expires) {
    await timers.setTimeout(Math.min(interval * 1000 + 3000, expires - Date.now()))
    if (Date.now() >= expires) break
    const token = await copilotRequest("https://github.com/login/oauth/access_token", {
      method: "POST", headers,
      body: JSON.stringify({
        client_id: COPILOT_CLIENT_ID, device_code: device.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    })
    if (typeof token?.access_token === "string" && token.access_token.trim()) {
      const account = await copilotRequest("https://api.github.com/user", {
        headers: { "User-Agent": USER_AGENT, Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": GITHUB_REST_API_VERSION,
          Authorization: `token ${token.access_token}` },
      })
      if (typeof account?.login !== "string" || !account.login.trim()) throw new Error("GitHub did not return an account login.")
      const entry = { type: "oauth", refresh: token.access_token, user: `${account.login}@github.com` }
      const models = await copilotModels(entry)
      const selectable = models.filter(item => typeof item?.id === "string" && item.id
        && item.policy?.state !== "disabled" && item.model_picker_enabled !== false && copilotModelApi(item))
        .map(item => ({ id: item.id, name: typeof item.name === "string" ? item.name : item.id }))
      if (model === undefined && !selectable.length) {
        throw new Error("No enabled Copilot models support Responses or Chat Completions for this account.")
      }
      const selected = model === undefined ? await selectModel(selectable) : model.trim()
      if (typeof selected !== "string" || !selected.trim()) throw new Error("No Copilot model selected.")
      if (model === undefined && !selectable.some(item => item.id === selected.trim())) {
        throw new Error("The selected Copilot model is not in the available model list.")
      }
      const config = await copilotModelConfig(entry, selected.trim(), models)
      entry.model = config.model
      const auth = await readAuth()
      auth["github-copilot"] = entry
      if (activate || !auth.active) auth.active = { provider: "github-copilot", name: COPILOT_AUTH_NAME }
      await writeAuth(auth)
      return { ...copilotSummary(auth), active: auth.active?.provider === "github-copilot" }
    }
    if (token?.error === "slow_down") {
      interval = Math.max(interval + 5, Number.isFinite(token.interval) ? token.interval : 0)
      continue
    }
    if (token?.error === "authorization_pending") continue
    const reason = ["access_denied", "expired_token"].includes(token?.error) ? token.error : "invalid authorization response"
    throw new Error(`GitHub Copilot sign-in failed: ${reason}. Run: minicode auth add --copilot`)
  }
  throw new Error("GitHub Copilot device code expired. Run: minicode auth add --copilot")
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
  const auth = await readAuth()
  if (selectedAuthName(auth) === COPILOT_AUTH_NAME) {
    const profile = copilotSummary(auth)
    return { ...profile, model: process.env.OPENCODE_MODEL || profile.model }
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

export async function loginActiveDeployment({ onPrompt } = {}) {
  const auth = await readAuth()
  if (selectedAuthName(auth) === COPILOT_AUTH_NAME) {
    return addCopilotAuth({ model: copilotSummary(auth).model, onPrompt, activate: false })
  }
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

  const auth = await readAuth()
  if (selectedAuthName(auth) === COPILOT_AUTH_NAME) {
    const profile = copilotSummary(auth)
    return copilotModelConfig(auth["github-copilot"], process.env.OPENCODE_MODEL || profile.model)
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
