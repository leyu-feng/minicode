import fs from "node:fs/promises"
import path from "node:path"
import childProcess from "node:child_process"
import { fileURLToPath } from "node:url"
import { startSecretStore } from "./secret-store.js"

const FIELDS = new Set([
  "name", "server", "workerId", "repoRoot", "workspaceMode", "entraUser", "toolAzureConfigDir",
  "workerShared", "outputMode", "minFreeGiB", "targetFreeGiB", "githubRepo",
  "githubUser", "azureDevOpsOrg", "azureDevOpsProject", "azureDevOpsRepo", "azureDevOpsUser",
  "azureDevOpsAlias", "clippyAuth", "pairingTokenEnv",
])

function scalar(text) {
  const value = text.trim()
  if (!value) return ""
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value[0] === '"' ? JSON.parse(value) : value.slice(1, -1).replaceAll("''", "'")
  }
  if (value === "true") return true
  if (value === "false") return false
  if (/^(0|[1-9]\d*)$/.test(value)) return Number(value)
  if (/[#]|:\s/.test(value)) throw new Error(`workers.yml scalar must be quoted: ${value}`)
  return value
}

// Deliberately small parser for the fixed workers.yml schema. It rejects YAML
// features such as aliases, tags and multiline values instead of accepting a
// broader configuration language in this operator-owned startup file.
export function parseWorkersYaml(text) {
  const result = { version: undefined, port: undefined, workers: [] }
  let current = null
  for (const [index, raw] of text.replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue
    let match = /^(version|port):\s*(.*?)\s*$/.exec(raw)
    if (match) {
      if (current || result[match[1]] !== undefined) throw new Error(`Invalid workers.yml line ${index + 1}`)
      result[match[1]] = scalar(match[2])
      continue
    }
    if (/^workers:\s*$/.test(raw)) continue
    match = /^  -\s+([A-Za-z][A-Za-z0-9]*):\s*(.*?)\s*$/.exec(raw)
    if (match) {
      current = {}
      result.workers.push(current)
    } else {
      match = /^    ([A-Za-z][A-Za-z0-9]*):\s*(.*?)\s*$/.exec(raw)
      if (!match || !current) throw new Error(`Invalid workers.yml line ${index + 1}`)
    }
    if (!FIELDS.has(match[1]) || Object.hasOwn(current, match[1])) throw new Error(`Invalid or duplicate worker field at line ${index + 1}: ${match[1]}`)
    current[match[1]] = scalar(match[2])
  }
  if (result.version !== 1 || !result.workers.length) throw new Error("workers.yml requires version: 1 and at least one worker")
  if (result.port !== undefined && (!Number.isInteger(result.port) || result.port < 0 || result.port > 65535)) throw new Error("workers.yml port must be between 0 and 65535")
  const names = new Set(), ids = new Set()
  for (const worker of result.workers) {
    if (typeof worker.name !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(worker.name)) throw new Error("Each worker requires a valid name")
    if (names.has(worker.name.toLowerCase())) throw new Error(`Duplicate worker name: ${worker.name}`)
    names.add(worker.name.toLowerCase())
    if (typeof worker.server !== "string" || !/^https:\/\//.test(worker.server)) throw new Error(`${worker.name} requires an HTTPS server`)
    if (typeof worker.workerId !== "string" || !/^[a-f0-9-]{36}$/.test(worker.workerId) || ids.has(worker.workerId)) throw new Error(`${worker.name} requires a unique workerId`)
    ids.add(worker.workerId)
    if (typeof worker.repoRoot !== "string" || !worker.repoRoot) throw new Error(`${worker.name} requires repoRoot`)
    if (worker.pairingTokenEnv !== undefined && (typeof worker.pairingTokenEnv !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(worker.pairingTokenEnv))) throw new Error(`${worker.name} has an invalid pairingTokenEnv`)
  }
  return result
}

function option(name, value, args, workspace) {
  if (value === undefined || value === "") return
  const resolved = name === "repo-root" && String(value).includes("@") && !path.isAbsolute(String(value))
    ? `${String(value).slice(0, String(value).indexOf("@"))}@${path.resolve(workspace, String(value).slice(String(value).indexOf("@") + 1))}`
    : ["repo-root", "tool-azure-config-dir", "worker-shared", "clippy-auth"].includes(name)
      ? path.resolve(workspace, String(value)) : String(value)
  args.push(`--${name}`, resolved)
}

function workerArgs(worker, workspace) {
  const args = [path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js"), "worker"]
  option("server", worker.server, args, workspace)
  option("worker-id", worker.workerId, args, workspace)
  option("repo-root", worker.repoRoot, args, workspace)
  option("worker-name", worker.name, args, workspace)
  option("workspace-mode", worker.workspaceMode, args, workspace)
  option("entra-user", worker.entraUser, args, workspace)
  option("tool-azure-config-dir", worker.toolAzureConfigDir, args, workspace)
  option("worker-shared", worker.workerShared, args, workspace)
  option("output-mode", worker.outputMode, args, workspace)
  option("min-free-gib", worker.minFreeGiB, args, workspace)
  option("target-free-gib", worker.targetFreeGiB, args, workspace)
  option("github-repo", worker.githubRepo, args, workspace)
  option("github-user", worker.githubUser, args, workspace)
  option("azure-devops-org", worker.azureDevOpsOrg, args, workspace)
  option("azure-devops-project", worker.azureDevOpsProject, args, workspace)
  option("azure-devops-repo", worker.azureDevOpsRepo, args, workspace)
  option("azure-devops-user", worker.azureDevOpsUser, args, workspace)
  option("azure-devops-alias", worker.azureDevOpsAlias, args, workspace)
  option("clippy-auth", worker.clippyAuth, args, workspace)
  return args
}

export async function runWorkersMode({ workspace, port }) {
  const file = path.join(workspace, "workers.yml")
  const config = parseWorkersYaml(await fs.readFile(file, "utf8"))
  const store = await startSecretStore()
  process.env.MINICODE_ORCHESTRATOR_SECRET_STORE_URL = store.env.MINICODE_SECRET_STORE_URL
  process.env.MINICODE_ORCHESTRATOR_SECRET_STORE_CAPABILITY = store.env.MINICODE_SECRET_STORE_CAPABILITY
  process.env.MINICODE_REPO_ROOT = workspace
  process.env.MINICODE_WEB_PORT = String(port ?? config.port ?? 0)
  process.env.MINICODE_WORKERS_MODE = "1"

  const children = []
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    for (const child of children) if (child.exitCode === null) child.kill("SIGTERM")
    store.close()
  }
  process.once("exit", stop)
  process.once("SIGINT", () => { stop(); process.exit(130) })
  process.once("SIGTERM", () => { stop(); process.exit(143) })

  for (const worker of config.workers) {
    const env = {
      ...process.env,
      MINICODE_ORCHESTRATOR_SECRET_STORE_URL: store.env.MINICODE_SECRET_STORE_URL,
      MINICODE_ORCHESTRATOR_SECRET_STORE_CAPABILITY: store.env.MINICODE_SECRET_STORE_CAPABILITY,
    }
    delete env.MINICODE_AGENT_POOL_PAIRING_TOKEN
    if (worker.pairingTokenEnv) {
      const token = process.env[worker.pairingTokenEnv]
      if (!token) throw new Error(`${worker.name} pairing token environment variable is not set: ${worker.pairingTokenEnv}`)
      env.MINICODE_AGENT_POOL_PAIRING_TOKEN = token
    }
    const child = childProcess.spawn(process.execPath, workerArgs(worker, workspace), {
      cwd: workspace, env, stdio: "inherit", windowsHide: true,
    })
    children.push(child)
    child.on("error", error => console.error(`[worker:${worker.name}] ${error.message}`))
    child.on("exit", (code, signal) => {
      if (!stopping) console.error(`[worker:${worker.name}] exited (${signal || code})`)
    })
    console.log(`[worker:${worker.name}] started (pid ${child.pid})`)
  }
  console.log(`shared worker secret store: ${store.env.MINICODE_SECRET_STORE_URL}`)
  await import("./index.js")
}
