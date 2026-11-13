import childProcess from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { stripVTControlCharacters } from "node:util"
import { killTree } from "./kill-tree.js"

const MAX_OUTPUT = 24_000

function inside(root, target) {
  const relative = path.relative(root, target)
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function safePath(root, value = ".") {
  if (typeof value !== "string" || value.includes("\0")) throw new Error("Invalid path")
  const resolved = path.resolve(root, value)
  if (!inside(root, resolved)) throw new Error("Path escapes its repository")
  return resolved
}

function slug(value) {
  return String(value).normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "").slice(0, 48).replace(/-$/, "")
}

async function allocateSiblingWorktree(repoRoot) {
  const parent = path.dirname(repoRoot)
  const name = path.basename(repoRoot)
  for (let index = 1; index <= 9999; index++) {
    const workspace = path.join(parent, `${name}-${String(index).padStart(2, "0")}`)
    try {
      await fs.mkdir(workspace)
      return workspace
    } catch (error) {
      if (error.code !== "EEXIST") throw error
    }
  }
  throw new Error(`No sibling repair workspace is available for '${name}'`)
}

function rejectUnsafeRemoteMutation(text) {
  const gitPush = /\bgit(?:\.exe)?\b[^\r\n;&|]*\bpush\b([^\r\n;&|]*)/i.exec(text)
  if ((gitPush && /(?:--delete|--mirror|--prune|--force(?!-with-lease)|(?:^|\s)-f(?:\s|$)|(?:^|\s)\+|(?:^|\s):(?:refs\/heads\/)?\S+)/i.test(gitPush[1]))
    || /\bgh(?:\.exe)?\b[^\r\n;&|]*\bpr\s+(?:merge|close|ready|review)\b/i.test(text)
    || /\baz(?:\.cmd|\.exe)?\b[^\r\n;&|]*\brepos\s+pr\s+(?:update|set-vote)\b/i.test(text)) {
    throw new Error("Destructive remote mutation is disabled")
  }
}

function command(file, args, { cwd, env = process.env, signal, allowExit = [] } = {}) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    let timedOut = false
    const child = childProcess.execFile(file, args, {
      cwd, env, windowsHide: true, encoding: "utf8", maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      const code = error?.code
      if (!error || allowExit.includes(code)) {
        resolve({ code: error ? code : 0, stdout: stdout.trim(), stderr: stderr.trim() })
        return
      }
      const detail = stripVTControlCharacters(stderr || stdout || error.message).trim().slice(0, 2000)
      reject(new Error(`${path.basename(file)} ${args[0]} failed${timedOut ? " (timed out)" : ""}: ${detail}`))
    })
    const abort = () => killTree(child.pid)
    const timer = setTimeout(() => { timedOut = true; abort() }, 120_000)
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
  })
}

function git(cwd, args, options) {
  return command("git", args, { cwd, ...options }).then(result => result.stdout)
}

async function exists(value) {
  try { await fs.lstat(value); return true }
  catch (error) { if (error.code !== "ENOENT") throw error; return false }
}

async function readManifest(root) {
  try {
    const config = JSON.parse(await fs.readFile(path.join(root, "workspace.json"), "utf8"))
    return Array.isArray(config?.repositories) ? config.repositories : []
  } catch (error) {
    if (error.code === "ENOENT") return []
    throw new Error("Coordinator workspace.json is invalid", { cause: error })
  }
}

async function resolveRepository(root, manifest, id) {
  if (!/^[a-z][a-z0-9_-]{0,31}$/i.test(id ?? "")) throw new Error("Invalid repository ID")
  const configured = manifest.find(repo => repo.id.toLowerCase() === id.toLowerCase())
  const candidates = [
    path.join(root, id),
    ...(configured?.branch ? [path.join(root, id, configured.branch)] : []),
    path.join(root, id, "dev"),
    path.join(root, id, "main"),
  ]
  for (const candidate of [...new Set(candidates)]) {
    if (!await exists(candidate)) continue
    try {
      const top = path.resolve(await git(candidate, ["rev-parse", "--show-toplevel"]))
      if (!inside(root, top)) throw new Error("Repository escapes the coordinator workspace")
      const remote = await git(top, ["remote", "get-url", "origin"])
      if (configured?.source && remote !== configured.source) {
        throw new Error(`Repository '${id}' origin does not match workspace.json`)
      }
      const branch = configured?.branch
        ?? (await git(top, ["branch", "--show-current"]))
        ?? "main"
      return { id: id.toLowerCase(), root: top, remote, branch }
    } catch (error) {
      if (!/not a git repository|cannot change to/i.test(error.message)) throw error
    }
  }
  throw new Error(`Coordinator repository '${id}' is not available`)
}

function fileTools(repository) {
  return {
    list: async relative => {
      const directory = safePath(repository.root, relative)
      const entries = await fs.readdir(directory, { withFileTypes: true })
      return entries.slice(0, 200).map(entry => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
      }))
    },
    read: async (relative, startLine = 1, endLine = startLine + 399) => {
      const file = safePath(repository.root, relative)
      const stat = await fs.lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Only regular repository files can be read")
      if (!Number.isInteger(startLine) || !Number.isInteger(endLine)
        || startLine < 1 || endLine < startLine || endLine - startLine > 499) {
        throw new Error("Read range must contain at most 500 lines")
      }
      const lines = (await fs.readFile(file, "utf8")).split(/\r?\n/)
      return lines.slice(startLine - 1, endLine).join("\n").slice(0, MAX_OUTPUT)
    },
  }
}

function publicationEnvironment() {
  const env = { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" }
  for (const key of Object.keys(env)) {
    if (/^(GH_TOKEN|GITHUB_TOKEN|AZURE_DEVOPS_EXT_PAT|GIT_CONFIG.*|GIT_DIR|GIT_WORK_TREE)$/i.test(key)) delete env[key]
  }
  return env
}

function githubRepository(remote) {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(remote)
  return match ? `${match[1]}/${match[2]}` : null
}

function azureRepository(remote) {
  const url = new URL(remote)
  const legacy = /^([a-z0-9-]+)\.visualstudio\.com$/i.exec(url.hostname)
  let parts = url.pathname.replace(/^\/|\/$/g, "").split("/").map(decodeURIComponent)
  let organization
  if (url.hostname === "dev.azure.com") organization = parts.shift()
  else if (legacy) {
    organization = legacy[1]
    if (parts[0]?.toLowerCase() === "defaultcollection") parts.shift()
  }
  if (!organization || parts.length !== 3 || parts[1] !== "_git") return null
  return { organization, project: parts[0], repository: parts[2] }
}

export async function createCoordinatorTools({ root, member, log = () => {} }) {
  root = await fs.realpath(root)
  const manifest = await readManifest(root)
  const repositoryCache = new Map()
  const repairs = new Map()
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-coordinator-"))
  const repository = async id => {
    const key = String(id).toLowerCase()
    let pending = repositoryCache.get(key)
    if (!pending) {
      pending = resolveRepository(root, manifest, key)
      repositoryCache.set(key, pending)
    }
    return pending
  }
  const repair = id => {
    const value = repairs.get(id)
    if (!value) throw new Error("Unknown repair workspace")
    return value
  }
  const tools = [
    {
      name: "run_coordinator_command",
      description: "Run a supervisory command from the common workspace root. Local diagnosis and repair are standing authority after verifying identity, ownership, and active work. Use for repository fetch/sync/reset/clean, process and worker lifecycle repair, isolated worktree creation, code repair, diagnostics, validation, and an explicitly requested branch or PR update. Preserve existing workspace checkouts. Force pushes, remote deletion, merge, close, approval, auto-complete, and deployment are not allowed.",
      parameters: { type: "object", additionalProperties: false, required: ["command"],
        properties: { command: { type: "string" } } },
      async execute({ command: text }, { signal }) {
        if (typeof text !== "string" || !text.trim() || text.length > 8000 || text.includes("\0")) {
          throw new Error("Invalid coordinator command")
        }
        rejectUnsafeRemoteMutation(text)
        const executable = process.platform === "win32" ? "pwsh.exe" : "bash"
        const args = process.platform === "win32"
          ? ["-NoProfile", "-NonInteractive", "-Command", text]
          : ["-lc", text]
        const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" }
        for (const key of Object.keys(env)) {
          if (/^MINICODE_(?:ORCHESTRATOR_)?SECRET_STORE_(?:URL|CAPABILITY|PORT)$/i.test(key)
            || /^MINICODE_AGENT_POOL_PAIRING_TOKEN$/i.test(key)) delete env[key]
        }
        const result = await command(executable, args, { cwd: root, env, signal })
        return result.stdout.slice(0, MAX_OUTPUT)
      },
    },
    {
      name: "repository_state",
      description: "Read Git status, recent commits, and diff summary from an existing workspace repository without modifying it.",
      parameters: { type: "object", additionalProperties: false, required: ["repository"],
        properties: { repository: { type: "string" } } },
      async execute({ repository: id }, { signal }) {
        const repo = await repository(id)
        return {
          repository: repo.id, branch: repo.branch,
          status: await git(repo.root, ["status", "--short", "--branch"], { signal }),
          log: await git(repo.root, ["--no-pager", "log", "-5", "--oneline", "--decorate"], { signal }),
          diff: await git(repo.root, ["--no-pager", "diff", "--stat"], { signal }),
        }
      },
    },
    {
      name: "list_repository_directory",
      description: "List only the immediate children of one directory in an existing workspace repository.",
      parameters: { type: "object", additionalProperties: false, required: ["repository", "path"],
        properties: { repository: { type: "string" }, path: { type: "string" } } },
      async execute({ repository: id, path: relative }) {
        const repo = await repository(id)
        return fileTools(repo).list(relative)
      },
    },
    {
      name: "read_repository_file",
      description: "Read a bounded line range from one regular file in an existing workspace repository.",
      parameters: { type: "object", additionalProperties: false, required: ["repository", "path"],
        properties: { repository: { type: "string" }, path: { type: "string" },
          startLine: { type: "integer" }, endLine: { type: "integer" } } },
      async execute({ repository: id, path: relative, startLine, endLine }) {
        const repo = await repository(id)
        return fileTools(repo).read(relative, startLine, endLine)
      },
    },
    {
      name: "search_repository",
      description: "Search tracked files in one repository. Supply a narrow repository-relative path or direct-child glob.",
      parameters: { type: "object", additionalProperties: false, required: ["repository", "pattern", "path"],
        properties: { repository: { type: "string" }, pattern: { type: "string" }, path: { type: "string" } } },
      async execute({ repository: id, pattern, path: relative }, { signal }) {
        if (typeof pattern !== "string" || !pattern || pattern.length > 500 || /[\r\n\0]/.test(pattern)) {
          throw new Error("Search pattern must be a single line of at most 500 characters")
        }
        const repo = await repository(id)
        const target = path.relative(repo.root, safePath(repo.root, relative)).replaceAll("\\", "/") || "."
        const result = await command("git", ["grep", "-n", "-I", "-m", "100", "-e", pattern, "--", target],
          { cwd: repo.root, signal, allowExit: [1] })
        return result.stdout.slice(0, MAX_OUTPUT)
      },
    },
    {
      name: "create_repair_workspace",
      description: "Create an isolated writable Git worktree for any available workspace repository. Never changes files in the existing workspace checkout.",
      parameters: { type: "object", additionalProperties: false, required: ["repository", "title"],
        properties: { repository: { type: "string" }, title: { type: "string" } } },
      async execute({ repository: id, title }, { signal }) {
        id = String(id).toLowerCase()
        const repo = await repository(id)
        const feature = slug(title)
        if (!feature) throw new Error("Repair title must contain letters or numbers")
        const repairId = randomUUID()
        const branch = `users/${slug(member.name) || "coordinator"}/coordinator/${feature}-${repairId.slice(0, 8)}`
        const workspace = await allocateSiblingWorktree(repo.root)
        try {
          await git(repo.root, ["worktree", "add", "--detach", workspace, "HEAD"], { signal })
          await git(workspace, ["switch", "-c", branch], { signal })
        } catch (error) {
          try {
            await git(repo.root, ["worktree", "remove", "--force", workspace])
          } catch (removeError) {
            try { await fs.rmdir(workspace) }
            catch (cleanupError) {
              throw new AggregateError([error, removeError, cleanupError], "Repair workspace cleanup failed")
            }
          }
          throw error
        }
        repairs.set(repairId, { repairId, repo, workspace, branch, title })
        log(`[coordinator:${member.name}] created isolated ${id} repair ${repairId} at ${workspace}`)
        return { repairId, repository: id, workspace, branch,
          base: await git(workspace, ["rev-parse", "HEAD"]) }
      },
    },
    {
      name: "read_repair_file",
      description: "Read a bounded line range from a file in an isolated repair workspace.",
      parameters: { type: "object", additionalProperties: false, required: ["repairId", "path"],
        properties: { repairId: { type: "string" }, path: { type: "string" },
          startLine: { type: "integer" }, endLine: { type: "integer" } } },
      async execute({ repairId, path: relative, startLine, endLine }) {
        const value = repair(repairId)
        return fileTools({ root: value.workspace }).read(relative, startLine, endLine)
      },
    },
    {
      name: "write_repair_file",
      description: "Write one UTF-8 file inside an isolated repair workspace.",
      parameters: { type: "object", additionalProperties: false, required: ["repairId", "path", "content"],
        properties: { repairId: { type: "string" }, path: { type: "string" }, content: { type: "string" } } },
      async execute({ repairId, path: relative, content }, { signal }) {
        signal.throwIfAborted()
        if (typeof content !== "string") throw new Error("File content must be a string")
        const file = safePath(repair(repairId).workspace, relative)
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, content, "utf8")
        return `wrote ${content.length} characters`
      },
    },
    {
      name: "edit_repair_file",
      description: "Replace one exact unique string in a file inside an isolated repair workspace.",
      parameters: { type: "object", additionalProperties: false, required: ["repairId", "path", "find", "replace"],
        properties: { repairId: { type: "string" }, path: { type: "string" },
          find: { type: "string" }, replace: { type: "string" } } },
      async execute({ repairId, path: relative, find, replace }, { signal }) {
        signal.throwIfAborted()
        if (typeof find !== "string" || !find || typeof replace !== "string") throw new Error("Invalid edit")
        const file = safePath(repair(repairId).workspace, relative)
        const original = await fs.readFile(file, "utf8")
        const eol = original.includes("\r\n") ? "\r\n" : "\n"
        const toEol = value => value.replace(/\r\n/g, "\n").replace(/\n/g, eol)
        if (!original.includes(find) && original.includes(toEol(find))) {
          find = toEol(find)
          replace = toEol(replace)
        }
        const count = original.split(find).length - 1
        if (count !== 1) throw new Error(`Edit text matched ${count} times; expected exactly once`)
        await fs.writeFile(file, original.replace(find, replace), "utf8")
        return "edited 1 occurrence"
      },
    },
    {
      name: "run_repair_command",
      description: "Run a build, test, formatter, or other repair command inside an isolated repair workspace. Do not access or modify paths outside that workspace.",
      parameters: { type: "object", additionalProperties: false, required: ["repairId", "command"],
        properties: { repairId: { type: "string" }, command: { type: "string" } } },
      async execute({ repairId, command: text }, { signal }) {
        if (typeof text !== "string" || !text.trim() || text.length > 8000 || text.includes("\0")) {
          throw new Error("Invalid repair command")
        }
        rejectUnsafeRemoteMutation(text)
        const value = repair(repairId)
        const executable = process.platform === "win32" ? "pwsh.exe" : "bash"
        const args = process.platform === "win32"
          ? ["-NoProfile", "-NonInteractive", "-Command", text]
          : ["-lc", text]
        const env = publicationEnvironment()
        const result = await command(executable, args, { cwd: value.workspace, env, signal })
        return result.stdout.slice(0, MAX_OUTPUT)
      },
    },
    {
      name: "commit_repair",
      description: "Commit all changes in an isolated repair workspace after validation.",
      parameters: { type: "object", additionalProperties: false, required: ["repairId", "message"],
        properties: { repairId: { type: "string" }, message: { type: "string" } } },
      async execute({ repairId, message }, { signal }) {
        if (typeof message !== "string" || !message.trim() || /[\r\n\0]/.test(message) || message.length > 200) {
          throw new Error("Commit message must be one line of at most 200 characters")
        }
        const value = repair(repairId)
        await git(value.workspace, ["add", "--all"], { signal })
        await git(value.workspace, ["commit", "-m", message, "-m",
          "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"], { signal })
        return {
          commit: await git(value.workspace, ["rev-parse", "HEAD"], { signal }),
          status: await git(value.workspace, ["status", "--short"], { signal }),
        }
      },
    },
    {
      name: "publish_repair_pull_request",
      description: "The only authorized remote-write path: publish a committed isolated repair branch and open or reconcile one PR. One explicit engineer approval is required for that repair; do not request approval for its preceding local work. Never merges, enables auto-complete, deploys, or changes the existing workspace checkout.",
      parameters: { type: "object", additionalProperties: false, required: ["repairId", "title", "body"],
        properties: { repairId: { type: "string" }, title: { type: "string" }, body: { type: "string" } } },
      async execute({ repairId, title, body }, { signal }) {
        if (typeof title !== "string" || !title.trim() || title.length > 200 || /[\r\n\0]/.test(title)
          || typeof body !== "string" || !body.trim() || body.length > 8000 || body.includes("\0")) {
          throw new Error("PR title and body are required")
        }
        const value = repair(repairId)
        if (await git(value.workspace, ["status", "--porcelain"], { signal })) {
          throw new Error("Repair workspace has uncommitted changes")
        }
        const commit = await git(value.workspace, ["rev-parse", "HEAD"], { signal })
        const base = value.repo.branch
        const env = publicationEnvironment()
        const remote = await git(value.workspace, ["remote", "get-url", "origin"], { signal })
        const existing = await git(value.workspace, ["ls-remote", "--heads", "origin", `refs/heads/${value.branch}`], { signal })
        if (existing && existing.split(/\s/)[0] !== commit) throw new Error("Remote repair branch exists at a different commit")
        if (!existing) await command("git", ["push", "--porcelain", "origin", `HEAD:refs/heads/${value.branch}`],
          { cwd: value.workspace, env, signal })
        const github = githubRepository(remote)
        if (github) {
          const listed = await command("gh", ["pr", "list", "--repo", github, "--state", "all",
            "--head", value.branch, "--json", "number,url,state,headRefOid"], { cwd: value.workspace, env, signal })
          const prs = JSON.parse(listed.stdout || "[]")
          if (prs.length > 1) throw new Error("Ambiguous existing GitHub PR")
          if (prs.length === 1) {
            if (prs[0].headRefOid !== commit) throw new Error("Existing GitHub PR has a different commit")
            return { provider: "github", ...prs[0], commit, reused: true }
          }
          const created = await command("gh", ["pr", "create", "--repo", github, "--base", base,
            "--head", value.branch, "--title", title, "--body", body], { cwd: value.workspace, env, signal })
          return { provider: "github", url: created.stdout.trim(), commit, reused: false }
        }
        const azure = azureRepository(remote)
        if (!azure) throw new Error("Unsupported PR provider")
        const organization = `https://dev.azure.com/${azure.organization}`
        const common = ["--organization", organization, "--project", azure.project,
          "--repository", azure.repository, "--output", "json", "--only-show-errors"]
        const listed = await command("az", ["repos", "pr", "list", ...common, "--status", "all",
          "--source-branch", value.branch, "--target-branch", base], { cwd: value.workspace, env, signal })
        const prs = JSON.parse(listed.stdout || "[]")
        if (prs.length > 1) throw new Error("Ambiguous existing Azure DevOps PR")
        if (prs.length === 1) {
          if (prs[0].lastMergeSourceCommit?.commitId !== commit) throw new Error("Existing Azure DevOps PR has a different commit")
          return { provider: "azure_devops", number: prs[0].pullRequestId,
            url: `${organization}/${encodeURIComponent(azure.project)}/_git/${encodeURIComponent(azure.repository)}/pullrequest/${prs[0].pullRequestId}`,
            commit, reused: true }
        }
        const created = await command("az", ["repos", "pr", "create", ...common,
          "--source-branch", value.branch, "--target-branch", base, "--title", title, "--description", body],
        { cwd: value.workspace, env, signal })
        const pr = JSON.parse(created.stdout)
        return { provider: "azure_devops", number: pr.pullRequestId,
          url: `${organization}/${encodeURIComponent(azure.project)}/_git/${encodeURIComponent(azure.repository)}/pullrequest/${pr.pullRequestId}`,
          commit, reused: false }
      },
    },
  ]
  return {
    cwd: storage,
    tools,
    async stop() {
      for (const value of repairs.values()) {
        try { await git(value.repo.root, ["worktree", "remove", "--force", value.workspace]) }
        catch (error) { log(`[coordinator:${member.name}] repair cleanup failed: ${error.message}`) }
      }
      await fs.rm(storage, { recursive: true, force: true })
    },
  }
}
