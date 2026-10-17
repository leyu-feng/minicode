// The Easy Auth session an AgentPool worker needs when Clippy sits behind Entra sign-in.
//
// clippy-auth (a separate package, ../../clippy-auth) does the Entra sign-in and saves the
// session; this module only reads it, asks clippy-auth for a new one, and tells the user how to
// sign in when that does not work. See clippy-auth/README.md for the design and the file contract.
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import fs from "node:fs/promises"
import path from "node:path"
import { authFilePath } from "./auth.js"

export const SESSION_HEADER = "x-zumo-auth"
export const SILENT_LOGIN_TIMEOUT_MS = 5000
const SESSION_FILE_VERSION = 1
const DEFAULT_CLIPPY_AUTH = fileURLToPath(new URL("../../clippy-auth/cli.js", import.meta.url))

// Only Easy Auth's 401 names an authorization_uri; Clippy's own 401s do not.
export function isEasyAuthChallenge(status, header) {
  return status === 401 && /authorization_uri="[^"]+"/i.test(header ?? "")
}

function sessionDir(server) {
  return path.join(path.dirname(authFilePath()), "entra", new URL(server).host.toLowerCase())
}

function sessionFileName(user) {
  return `${String(user).toLowerCase().replace(/[^a-z0-9@._-]/g, "_")}.json`
}

async function readFile(file) {
  try {
    const session = JSON.parse(await fs.readFile(file, "utf8"))
    return session?.version === SESSION_FILE_VERSION && typeof session.sessionToken === "string" ? session : null
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null
    throw error
  }
}

// The user's saved session, or without a user the newest one saved for the server.
export async function readSavedSession(server, user) {
  if (user) return readFile(path.join(sessionDir(server), sessionFileName(user)))
  let names
  try {
    names = (await fs.readdir(sessionDir(server))).filter((name) => name.endsWith(".json"))
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
  const sessions = (await Promise.all(names.map((name) => readFile(path.join(sessionDir(server), name))))).filter(Boolean)
  sessions.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  return sessions[0] ?? null
}

function usable(session, now = Date.now()) {
  return Boolean(session) && (!session.expiresAt || Date.parse(session.expiresAt) > now + 60_000)
}

export function loginCommand({ server, user, clippyAuth = DEFAULT_CLIPPY_AUTH }) {
  return `node "${clippyAuth}" login --server ${server}${user ? ` --user ${user}` : ""}`
}

// `clippy-auth login --silent`, killed if it has not finished within the timeout. Resolves with the
// outcome rather than rejecting: every failure ends in the same instruction to the user.
export async function runSilentLogin({ server, user, clippyAuth = DEFAULT_CLIPPY_AUTH, timeoutMs = SILENT_LOGIN_TIMEOUT_MS }) {
  try {
    await fs.access(clippyAuth)
  } catch {
    return { ok: false, reason: `clippy-auth was not found at ${clippyAuth}` }
  }
  try {
    await fs.access(path.join(path.dirname(clippyAuth), "node_modules"))
  } catch {
    return { ok: false, reason: `clippy-auth is not installed; run npm install in ${path.dirname(clippyAuth)}` }
  }
  const args = [clippyAuth, "login", "--server", server, ...(user ? ["--user", user] : []), "--silent"]
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    let output = ""
    child.stdout.on("data", (chunk) => { output += chunk })
    child.stderr.on("data", (chunk) => { output += chunk })
    const timer = setTimeout(() => {
      child.kill()
      resolve({ ok: false, reason: `silent sign-in did not finish within ${timeoutMs / 1000}s` })
    }, timeoutMs)
    child.on("error", (error) => {
      clearTimeout(timer)
      resolve({ ok: false, reason: error.message })
    })
    child.on("exit", (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ ok: true })
      else if (code === 2) resolve({ ok: false, reason: "signing in needs you" })
      else resolve({ ok: false, reason: output.trim().split("\n").at(-1) || `clippy-auth exited with ${code}` })
    })
  })
}

// One session per worker. token() is what goes in X-ZUMO-AUTH; renew() gets a new session when
// Easy Auth refuses the current one, sharing a single attempt between concurrent callers.
export function createEntraSession({
  server, user, clippyAuth = DEFAULT_CLIPPY_AUTH,
  log = (message) => process.stderr.write(`${message}\n`),
  silentLogin = runSilentLogin, pollMs = 5000,
}) {
  let current = null
  let renewing = null

  async function waitForSignIn(reason, previous) {
    log([
      `Clippy needs an Entra sign-in${user ? ` for ${user}` : ""} (${reason}). Run this, and the worker continues on its own:`,
      `  ${loginCommand({ server, user, clippyAuth })}`,
    ].join("\n"))
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, pollMs))
      const session = await readSavedSession(server, user)
      if (usable(session) && session.createdAt !== previous?.createdAt) return session
    }
  }

  async function obtain() {
    const previous = current
    const result = await silentLogin({ server, user, clippyAuth })
    const session = await readSavedSession(server, user)
    if (result.ok && usable(session)) return session
    return waitForSignIn(result.ok ? "the saved session is not usable" : result.reason, previous)
  }

  return {
    token: () => current?.sessionToken ?? "",
    async ensure() {
      const saved = await readSavedSession(server, user)
      current = usable(saved) ? saved : await this.renew()
      return current
    },
    renew() {
      renewing ??= obtain().then((session) => {
        current = session
        log(`Entra session ready for ${session.user} (valid until ${session.expiresAt ?? "unknown"})`)
        return session
      }).finally(() => { renewing = null })
      return renewing
    },
  }
}
