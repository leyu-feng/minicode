// Where sessions live, and the file format the Minicode worker reads (see README "Session file").
// The directory follows Minicode's own configDir() in minicode/server/auth.js; keep the two in step.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export const SESSION_FILE_VERSION = 1

export function configDir() {
  if (process.env.MINICODE_CONFIG_HOME) return process.env.MINICODE_CONFIG_HOME
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, "minicode")
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || process.env.APPDATA
    if (base) return path.join(base, "minicode")
  }
  return path.join(os.homedir(), ".config", "minicode")
}

export function serverOrigin(server) {
  const url = new URL(server)
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("--server must be an HTTP(S) origin")
  const loopback = ["localhost", "[::1]"].includes(url.hostname) || /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
  if (url.username || url.password || (url.protocol === "http:" && !loopback)) {
    throw new Error("Entra sign-in requires HTTPS without URL credentials; HTTP is allowed only on loopback.")
  }
  return url.origin
}

export function sessionDir(server) {
  return path.join(configDir(), "entra", new URL(serverOrigin(server)).host.toLowerCase())
}

export function sessionFileName(user) {
  return `${String(user).toLowerCase().replace(/[^a-z0-9@._-]/g, "_")}.json`
}

export function sessionPath(server, user) {
  return path.join(sessionDir(server), sessionFileName(user))
}

export async function writeSession(session) {
  const file = sessionPath(session.server, session.user)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify({ version: SESSION_FILE_VERSION, ...session }, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(temporary, file)
  return file
}

// The named user's session, or without one the most recently saved session for the server.
export async function readSession(server, user) {
  if (user) return readFile(sessionPath(server, user))
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

export async function removeSession(server, user) {
  const session = await readSession(server, user)
  if (!session) return null
  await fs.rm(sessionPath(server, session.user), { force: true })
  return session
}

async function readFile(file) {
  try {
    const session = JSON.parse(await fs.readFile(file, "utf8"))
    return session?.version === SESSION_FILE_VERSION && typeof session.sessionToken === "string" ? session : null
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}
