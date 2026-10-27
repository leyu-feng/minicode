#!/usr/bin/env node
// clippy-auth: signs a Minicode AgentPool worker in to an Entra-gated Clippy. See README.md.
import { pathToFileURL } from "node:url"
import { readChallenge } from "./src/challenge.js"
import { exchangeForSession, jwtExpiry, sessionAccepted } from "./src/easyauth.js"
import { readSession, removeSession, serverOrigin, sessionPath, writeSession } from "./src/session-store.js"

// Microsoft Azure PowerShell: a first-party public client with a WAM redirect, so workers need no
// client registration of their own. The auth app pre-authorizes it, and Easy Auth allows it.
export const DEFAULT_CLIENT_ID = "1950a258-227b-4e31-a9cf-717495945fc2"

export const EXIT_OK = 0
export const EXIT_ERROR = 1
export const EXIT_INTERACTION_REQUIRED = 2

const USAGE = `Usage:
  clippy-auth login  --server <origin> [--user <upn>] [--silent] [--client-id <id>] [--scope <scope>]
  clippy-auth status --server <origin> [--user <upn>]
  clippy-auth logout --server <origin> [--user <upn>]
  clippy-auth board-token --server <origin> [--user <upn>] [--silent]
  clippy-auth ado-login --organization <https://dev.azure.com/org> --user <upn>
  clippy-auth ado-token --organization <https://dev.azure.com/org> --user <upn> [--silent]

login   Signs in through WAM and saves the Easy Auth session the worker sends as X-ZUMO-AUTH.
        --silent never shows UI and exits ${EXIT_INTERACTION_REQUIRED} if signing in needs you; the worker renews with it.
status  Shows the saved session and whether Easy Auth still accepts it.
logout  Deletes the saved session.
board-token  Returns private Entra token JSON for human board API calls; never save it to worker files or logs.
ado-login  Signs in to Azure DevOps through MSAL/WAM; does not print or save an access token.
ado-token  Returns private token JSON for the worker harness, never for model tools or logs.`

export function parseArgs(argv) {
  const [command, ...rest] = argv
  const options = { command, silent: false }
  const valued = { "--server": "server", "--user": "user", "--client-id": "clientId", "--scope": "scope",
    "--organization": "organization" }
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === "--silent") options.silent = true
    else if (valued[arg] && rest[i + 1] && !rest[i + 1].startsWith("--")) options[valued[arg]] = rest[++i]
    else throw new Error(`Unknown or incomplete argument: ${arg}`)
  }
  if (["ado-login", "ado-token"].includes(command)) {
    if (!options.organization || !options.user || options.server || options.scope) throw new Error(USAGE)
  } else {
    if (!["login", "status", "logout", "board-token"].includes(command) || !options.server || options.organization) throw new Error(USAGE)
    options.server = serverOrigin(options.server)
  }
  return options
}

async function acquireServerToken(options, dependencies) {
  const challenge = await readChallenge(options.server, dependencies.fetchImpl)
  const acquireToken = dependencies.acquireToken ?? (await import("./src/wam.js")).acquireToken
  const token = await acquireToken({
    authority: challenge.authority,
    clientId: options.clientId || DEFAULT_CLIENT_ID,
    // The named scope rather than /.default: a first-party client's registration lists no
    // permissions for our app, so /.default fails with AADSTS650057.
    scopes: [options.scope || `${challenge.resource}/user_impersonation`],
    user: options.user,
    silentOnly: options.silent,
  })
  const user = token.account?.username || options.user
  if (!user) throw new Error("Sign-in did not report which account it used; pass --user.")
  // The worker looks the session up by the --user it was given, so a session saved under whichever
  // account was picked in the WAM prompt instead would never be found.
  if (options.user && user.toLowerCase() !== options.user.toLowerCase()) {
    throw new Error(`Signed in as ${user}, not ${options.user}. Sign in with ${options.user}, or drop --user.`)
  }
  return { token, user, challenge }
}

async function login(options, log, dependencies) {
  const { token, user, challenge } = await acquireServerToken(options, dependencies)
  const session = await exchangeForSession(options.server, token.accessToken, dependencies.fetchImpl)
  if (!(await sessionAccepted(options.server, session.sessionToken, dependencies.fetchImpl))) {
    throw new Error("Easy Auth issued a session that it then refused.")
  }
  const file = await writeSession({
    server: options.server,
    user,
    clientId: options.clientId || DEFAULT_CLIENT_ID,
    resource: challenge.resource,
    sessionToken: session.sessionToken,
    expiresAt: session.expiresAt,
    createdAt: new Date().toISOString(),
  })
  log(`Signed in to ${options.server} as ${user}. ${validity(session.expiresAt)}`)
  log(`Session saved to ${file}. A worker started with --entra-user ${user} picks it up on its own.`)
}

async function boardToken(options, log, dependencies) {
  const { token, user } = await acquireServerToken(options, dependencies)
  const response = await (dependencies.fetchImpl ?? fetch)(new URL("/api/auth/get-session", options.server), {
    headers: { authorization: `Bearer ${token.accessToken}` },
    redirect: "error",
  })
  if (!response.ok) throw new Error(`Clippy did not accept the Entra user token for board access (HTTP ${response.status}).`)
  const session = await response.json()
  if (!session?.user?.id || !session?.session?.id) throw new Error("Clippy did not return an authenticated board session.")
  log(JSON.stringify({ accessToken: token.accessToken, expiresAt: jwtExpiry(token.accessToken), user, server: options.server }))
}

export function validity(expiresAt, now = Date.now()) {
  if (!expiresAt) return "Session validity unknown."
  const days = (Date.parse(expiresAt) - now) / 86_400_000
  const span = days >= 1 ? `${Math.floor(days)} days` : `${Math.max(0, Math.round(days * 24))} hours`
  return `Session valid until ${new Date(expiresAt).toLocaleString()} (${span}).`
}

async function status(options, log) {
  const session = await readSession(options.server, options.user)
  if (!session) {
    log(`No saved session for ${options.server}${options.user ? ` and ${options.user}` : ""}. Run: clippy-auth login --server ${options.server}`)
    return EXIT_ERROR
  }
  const accepted = await sessionAccepted(options.server, session.sessionToken)
  log(`${session.user} at ${options.server}: ${accepted ? "accepted" : "refused, run clippy-auth login"} ` +
    `(saved ${session.createdAt}, expires ${session.expiresAt ?? "unknown"}, ${sessionPath(options.server, session.user)})`)
  return accepted ? EXIT_OK : EXIT_ERROR
}

async function logout(options, log) {
  const session = await removeSession(options.server, options.user)
  log(session ? `Removed the saved session for ${session.user} at ${options.server}.` : "No saved session to remove.")
}

export async function main(argv, log = console.log, logError = console.error, dependencies = {}) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    logError(error.message)
    return EXIT_ERROR
  }
  try {
    if (["ado-login", "ado-token"].includes(options.command)) {
      const getToken = dependencies.acquireAzureDevOpsToken ?? (await import("./src/azure-devops.js")).acquireAzureDevOpsToken
      const result = await getToken({ organization: options.organization, user: options.user,
        clientId: options.clientId || DEFAULT_CLIENT_ID, silentOnly: options.silent })
      if (options.command === "ado-token") log(JSON.stringify(result))
      else log(`Signed in to Azure DevOps as ${result.user}. Access token valid until ${result.expiresAt}; no token was saved.`)
    }
    else if (options.command === "login") await login(options, log, dependencies)
    else if (options.command === "board-token") await boardToken(options, log, dependencies)
    else if (options.command === "status") return await status(options, log)
    else await logout(options, log)
    return EXIT_OK
  } catch (error) {
    logError(`clippy-auth ${options.command}: ${error.message}`)
    return error?.code === "interaction_required" ? EXIT_INTERACTION_REQUIRED : EXIT_ERROR
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Exit explicitly: MSAL's native broker keeps a handle open after the call returns, which left
  // the process running -- and a worker waiting on its renewal -- once the work was done.
  process.exit(await main(process.argv.slice(2)))
}
