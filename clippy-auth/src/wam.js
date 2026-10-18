// Entra sign-in through the Windows broker (WAM), with an isolated Azure CLI fallback for
// machines where Application Control prevents Node from loading MSAL's native addon.

import childProcess from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { configDir } from "./session-store.js"

const execFile = promisify(childProcess.execFile)

// --silent's outcome when signing in needs the user: the CLI turns it into its own exit code, which
// is how the worker tells "ask the user" from "something is broken".
export class InteractionRequiredError extends Error {
  code = "interaction_required"
}

async function loadLibraries() {
  const [msal, extensions] = await Promise.all([
    import("@azure/msal-node"), import("@azure/msal-node-extensions"),
  ])
  return { msal, extensions }
}

export async function createBrokerApplication({ authority, clientId }, load = loadLibraries) {
  const { msal, extensions } = await load()
  const { PublicClientApplication, InteractionRequiredAuthError } = msal
  const { NativeBrokerPlugin } = extensions
  const broker = new NativeBrokerPlugin()
  if (!broker.isBrokerAvailable) throw new Error("WAM native broker is unavailable.")
  return {
    app: new PublicClientApplication({
      auth: { clientId, authority },
      broker: { nativeBrokerPlugin: broker },
    }),
    InteractionRequiredAuthError,
  }
}

function tokenClaims(token) {
  try {
    const parts = token.split(".")
    if (parts.length !== 3) throw new Error("not a JWT")
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
  } catch (error) {
    throw new Error("Azure CLI returned a token whose identity claims could not be read.", { cause: error })
  }
}

function authorityTenant(authority) {
  const tenant = new URL(authority).pathname.split("/").filter(Boolean).at(-1)
  return tenant && !["common", "organizations", "consumers"].includes(tenant.toLowerCase()) ? tenant : null
}

export function azureCliConfigDir({ authority, user }) {
  const tenant = authorityTenant(authority) || "common"
  const key = createHash("sha256").update(JSON.stringify([
    String(user || "").toLowerCase(), tenant.toLowerCase(),
  ])).digest("hex")
  return path.join(configDir(), "azure-cli", "clippy-auth", key)
}

async function isFile(file) {
  try {
    return (await fs.stat(file)).isFile()
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false
    throw error
  }
}

export async function azureCliInvocation(args, { env = process.env } = {}) {
  if (process.platform !== "win32") return { command: "az", args }
  for (const entry of (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean)) {
    const directory = entry.replace(/^"|"$/g, "")
    const executable = path.join(directory, "az.exe")
    if (await isFile(executable)) return { command: executable, args }
    if (!await isFile(path.join(directory, "az.cmd"))) continue
    // The Windows installer shim runs this interpreter. Bypass cmd.exe so scopes stay data.
    const python = path.resolve(directory, "..", "python.exe")
    if (!await isFile(python)) {
      throw new Error("Azure CLI's bundled python.exe was not found. Reinstall Microsoft Azure CLI for Windows.")
    }
    return { command: python, args: ["-IBm", "azure.cli", ...args] }
  }
  throw new Error("Azure CLI was not found on PATH. Install Microsoft Azure CLI for Windows.")
}

async function runAzureCli(args, { inherit = false, azureConfigDir, run = execFile, spawn = childProcess.spawn, env: baseEnv = process.env } = {}) {
  const invocation = await azureCliInvocation(args, { env: baseEnv })
  const env = {
    ...baseEnv,
    AZURE_CONFIG_DIR: azureConfigDir,
    AZURE_CORE_LOGIN_EXPERIENCE_V2: "off",
  }
  if (inherit) {
    return new Promise((resolve, reject) => {
      const child = spawn(invocation.command, invocation.args, { stdio: "inherit", windowsHide: false, env })
      child.on("error", reject)
      child.on("exit", (code) => code === 0
        ? resolve("")
        : reject(new Error(`Azure CLI exited with code ${code ?? 1}.`)))
    })
  }
  try {
    return (await run(invocation.command, invocation.args, {
      encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024, env,
    })).stdout
  } catch (error) {
    throw new Error(`Azure CLI authentication failed: ${error.stderr?.trim() || error.message}`, { cause: error })
  }
}

async function verifyAzureCliAccount({ user, tenant, azureConfigDir }, dependencies) {
  let account
  try {
    account = JSON.parse(await runAzureCli(["account", "show", "--output", "json"], {
      azureConfigDir, ...dependencies,
    }))
  } catch (error) {
    throw new Error(`Could not read the isolated Azure CLI account: ${error.message}`, { cause: error })
  }
  if (account?.user?.type !== "user" || account.user.name?.toLowerCase() !== user.toLowerCase()) {
    throw new Error(`Azure CLI signed in as ${account?.user?.name || "an unknown account"}, not ${user}.`)
  }
  if (tenant && account.tenantId?.toLowerCase() !== tenant.toLowerCase()) {
    throw new Error("Azure CLI selected a different or missing tenant.")
  }
  return account
}

export async function acquireTokenWithAzureCli({ authority, scopes, user, silentOnly }, dependencies = {}) {
  if (!user) throw new Error("Azure CLI fallback requires --user.")
  const tenant = authorityTenant(authority)
  if (!tenant) throw new Error("Azure CLI fallback requires a tenant-specific Easy Auth authority.")
  const azureConfigDir = dependencies.azureConfigDir || azureCliConfigDir({ authority, user })
  await fs.mkdir(azureConfigDir, { recursive: true, mode: 0o700 })
  const tokenArgs = ["account", "get-access-token", "--scope", scopes.join(" "),
    "--tenant", tenant, "--output", "json"]

  let output
  try {
    await verifyAzureCliAccount({ user, tenant, azureConfigDir }, dependencies)
    output = await runAzureCli(tokenArgs, { azureConfigDir, ...dependencies })
  } catch (error) {
    if (silentOnly) {
      throw new InteractionRequiredError(`Azure CLI needs sign-in as ${user}. Run: clippy-auth login`, { cause: error })
    }
    // The cache is dedicated to this UPN and tenant. Login requests the delegated scope so consent
    // happens in the same interactive flow rather than failing later during get-access-token.
    await runAzureCli(["login", "--tenant", tenant, "--scope", scopes.join(" "),
      "--allow-no-subscriptions", "--output", "none"], {
      azureConfigDir, inherit: true, ...dependencies,
    })
    await verifyAzureCliAccount({ user, tenant, azureConfigDir }, dependencies)
    output = await runAzureCli(tokenArgs, { azureConfigDir, ...dependencies })
  }

  let result
  try {
    result = JSON.parse(output)
  } catch (error) {
    throw new Error("Azure CLI returned an invalid access-token response.", { cause: error })
  }
  if (typeof result.accessToken !== "string" || !result.accessToken) {
    throw new Error("Azure CLI did not return an access token.")
  }
  const claims = tokenClaims(result.accessToken)
  const tokenUser = claims.preferred_username || claims.upn || claims.unique_name
  if (tokenUser?.toLowerCase() !== user.toLowerCase()) {
    throw new Error(`Azure CLI token identifies ${tokenUser || "an unknown account"}, not ${user}.`)
  }
  if (claims.tid?.toLowerCase() !== tenant.toLowerCase()) {
    throw new Error("Azure CLI token identifies a different or missing tenant.")
  }
  return { accessToken: result.accessToken, account: { username: tokenUser, tenantId: claims.tid } }
}

export async function acquireToken(options, createApplication = createBrokerApplication, azureCli = acquireTokenWithAzureCli) {
  if (process.platform !== "win32") throw new Error("clippy-auth signs in through WAM or Azure CLI, which is Windows-only.")
  let application
  try {
    application = await createApplication(options)
  } catch (error) {
    if (!/WAM native broker is unavailable/i.test(error.message)) throw error
    return azureCli(options)
  }
  const { app, InteractionRequiredAuthError } = application

  // The broker remembers accounts across processes, so after the first sign-in this is silent.
  const accounts = await app.getAllAccounts()
  const account = options.user
    ? accounts.find((candidate) => candidate.username?.toLowerCase() === options.user.toLowerCase())
    : accounts[0]
  if (account) {
    try {
      return await app.acquireTokenSilent({ scopes: options.scopes, account })
    } catch (error) {
      if (!(error instanceof InteractionRequiredAuthError)) throw error
    }
  }
  if (options.silentOnly) {
    throw new InteractionRequiredError(`Signing in${options.user ? ` as ${options.user}` : ""} needs you. Run: clippy-auth login`)
  }
  return app.acquireTokenInteractive({
    scopes: options.scopes,
    loginHint: options.user || undefined,
    prompt: options.user ? undefined : "select_account",
    // Let MSAL discover the CLI window without PowerShell Add-Type.
    openBrowser: async () => {
      throw new Error("WAM should handle sign-in without a browser.")
    },
  })
}
