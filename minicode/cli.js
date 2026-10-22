#!/usr/bin/env node
import path from "node:path"
import readline from "node:readline"
import readlinePromises from "node:readline/promises"
import { AgentSession, callModelOnce } from "./server/agent-session.js"
import { runAgentPoolWorkerCli } from "./server/agent-pool-worker.js"
import {
  DEFAULT_AZURE_MODEL,
  COPILOT_AUTH_NAME,
  addAzureDeployment,
  addCopilotAuth,
  authFilePath,
  clearAuth,
  getActiveAuthSummary,
  listAuthConfigs,
  loginActiveDeployment,
  resolveModelConfig,
  setActiveAuth,
} from "./server/auth.js"

const C = {
  reset: "\u001b[0m",
  dim: "\u001b[90m",
  green: "\u001b[32m",
  cyan: "\u001b[36m",
  red: "\u001b[31m",
}

const EXIT_COMMANDS = new Set(["exit", "quit", "/exit", "/quit", ":q"])

function usage() {
  console.log(`minicode - a coding agent that runs shell commands

Usage:
  minicode                       Interactive REPL (conversation is remembered)
  minicode "<prompt>"            Run one prompt, print the answer, exit
  minicode --no-tools "<prompt>" Answer without running any shell commands
  minicode web [port]            Start the browser portal
  minicode auth login            Sign in with the selected auth provider
  minicode auth add [name]       Add an Azure deployment
  minicode auth add --copilot    Add/sign in to the @copilot entry
  minicode auth use <name>       Select the active auth
  minicode auth list             List configured auth options
  minicode auth clear            Clear deployment configuration
  minicode worker --server <url> --worker-id <id> --repo-root <dir> [--entra-user <upn>]
                                Connect to an AgentPool as a worker; --entra-user signs in
                                to an Entra-gated Clippy through clippy-auth
  minicode --help

Options:
  --repo-root <dir>       Working directory for shell commands
  --model <name>          Override the model for this run
  --auth <entry>          Use a saved auth entry without changing the active one
  --copilot               Select @copilot; with 'auth add', add/sign in
  --endpoint <url>        Responses endpoint (with 'auth add')
  --entra-user <upn>      Sign in with an isolated Azure CLI identity (with 'auth add')
  --tenant <id>           Select the Entra tenant (with 'auth add --entra-user')
  --clippy-auth <cli.js>  Override the Easy Auth helper (with 'worker' only)
  --worker-shared <dir>   Worker read-only shared folder (default: sibling worker_shared)
  --reference-repo <name>=<dir>  Attach an existing read-only reference checkout (repeatable)
  --workspace-mode <mode>  worktree (default): clean worker-agent siblings; clone: legacy per-agent clones
  --worker-name <name>    Short sibling prefix, e.g. w1 creates w1a1 (default: w-<worker-id prefix>)
  --min-free-gib <GiB>    Evict idle worktrees below this free space (default: 24)
  --target-free-gib <GiB>  LRU cleanup recovery target (default: 36; worktree mode only)
  --github-repo <owner/repo>  Enable harness PR publication for this source GitHub repo
  --github-user <account>    Existing GitHub CLI login used only by the publisher
  --output-mode <mode>   Worker logs: normal (default) or verbose (includes raw tool output)

REPL commands:
  exit, quit, :q     Leave
  cls, clear         Clear the screen and forget the conversation
  /clear             Forget the conversation so far
  /cwd               Show the working directory
  /model             Show the active model

Ctrl+C cancels the current turn; Ctrl+C at an empty prompt exits.

Environment:
  AZURE_OPENAI_DEPLOYMENT, AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_MODEL
  OPENCODE_API_KEY, OPENCODE_BASE_URL, OPENCODE_MODEL (custom provider override)
  MINICODE_REPO_ROOT`)
}

function parseArgs(argv) {
  const options = { positional: [], noTools: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--help" || arg === "-h") options.help = true
    else if (arg === "--version" || arg === "-v") options.version = true
    else if (arg === "--no-tools") options.noTools = true
    else if (arg === "--copilot") options.copilot = true
    else if ((arg === "--repo-root" || arg === "-repo_root") && argv[i + 1]) options.repoRoot = argv[++i]
    else if (arg === "--model" && argv[i + 1]) options.model = argv[++i]
    else if (arg === "--auth") {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("Missing value for --auth.")
      options.auth = argv[++i]
    }
    else if (arg === "--endpoint" && argv[i + 1]) options.endpoint = argv[++i]
    else if (["auth", "providers"].includes(options.positional[0]) && arg === "--clippy-auth") {
      throw new Error("--clippy-auth is only supported with worker. Model sign-in uses Azure CLI.")
    }
    else if (["auth", "providers"].includes(options.positional[0]) && ["--entra-user", "--tenant"].includes(arg)) {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`Missing value for ${arg}.`)
      const key = { "--entra-user": "entraUser", "--tenant": "tenant" }[arg]
      options[key] = argv[++i]
    }
    else options.positional.push(arg)
  }
  if (options.copilot && options.auth && options.auth !== COPILOT_AUTH_NAME) {
    throw new Error("--copilot cannot be combined with a different --auth entry.")
  }
  return options
}

let options
try {
  options = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error(`Minicode: ${error.message}`)
  process.exit(1)
}

if (options.help) {
  usage()
  process.exit(0)
}
if (options.version) {
  console.log("minicode 0.1.0")
  process.exit(0)
}

// --model applies before anything resolves configuration.
if (options.model) process.env.OPENCODE_MODEL = options.model
if (options.copilot) process.env.MINICODE_AUTH_ENTRY = COPILOT_AUTH_NAME
else if (options.auth) process.env.MINICODE_AUTH_ENTRY = options.auth

/* ------------------------------------------------------------------ auth */

async function runAuth(argv) {
  const action = argv[0] || "list"
  if (action !== "add" && (options.entraUser || options.tenant)) {
    throw new Error("--entra-user and --tenant are only supported with auth add.")
  }
  if (options.copilot && ["add", "use"].includes(action) && argv[1] && argv[1] !== COPILOT_AUTH_NAME) {
    throw new Error("--copilot cannot be combined with a different auth name.")
  }
  const name = options.copilot ? COPILOT_AUTH_NAME : argv[1]

  if (action === "login") {
    const added = await ensureAuthConfigured()
    const deployment = added?.provider === "github-copilot"
      ? added : await loginActiveDeployment({ onPrompt: promptForCopilotSignIn })
    console.log(`${C.green}Signed in: ${deployment.name} · ${deployment.model} · ${deployment.user}${C.reset}`)
    return 0
  }

  if (action === "add") {
    const deployment = await promptForAuth(name)
    console.log(`${C.green}Active auth: ${deployment.name} · ${deployment.model} · ${deployment.user || "login@az.cli"}${C.reset}`)
    console.log(`${C.dim}${authFilePath()}${C.reset}`)
    return 0
  }

  if (action === "use") {
    if (!name) throw new Error("Usage: minicode auth use <name> or minicode auth use --copilot")
    const deployment = await setActiveAuth(name)
    console.log(`${C.green}Active auth: ${deployment.name} · ${deployment.model} · ${deployment.user || "login@az.cli"}${C.reset}`)
    return 0
  }

  if (action === "ensure") {
    await ensureAuthConfigured()
    return 0
  }

  if (action === "list") {
    const deployments = await listAuthConfigs()
    if (!deployments.length) {
      console.log("No auth options configured.")
      console.log(`${C.dim}run: minicode auth add${C.reset}`)
      return 0
    }
    for (const deployment of deployments) {
      console.log(`${deployment.active ? "*" : " "} ${deployment.name} · ${deployment.model} · ${deployment.user} (${deployment.credentialProvider || (deployment.provider === "github-copilot" ? "github-copilot" : "azure-cli")})`)
      if (deployment.endpoint) console.log(`  ${C.dim}${deployment.endpoint}${C.reset}`)
    }
    console.log(`${C.dim}${authFilePath()}${C.reset}`)
    return 0
  }

  if (action === "clear") {
    const removed = await clearAuth()
    console.log(removed ? "Cleared minicode auth configuration." : "Minicode auth configuration is already empty.")
    console.log(`${C.dim}Azure CLI and WAM sign-ins were not changed. GitHub OAuth grants were not revoked.${C.reset}`)
    return 0
  }

  if (action === "logout") {
    console.log("Use minicode auth clear to remove saved Minicode credentials. Azure CLI: az logout. WAM: manage accounts in Windows Settings. Revoke Copilot authorization in GitHub Settings > Applications.")
    return 0
  }

  console.error(`Unknown auth command: ${action}`)
  usage()
  return 1
}

function promptForCopilotSignIn({ verificationUri, userCode }) {
  console.log(`Sign in to GitHub Copilot: ${verificationUri}`)
  console.log(`Enter code: ${userCode}`)
}

async function promptForCopilotModel(models) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Copilot model selection requires a terminal. Use: minicode auth add --copilot --model <id>")
  }
  console.log("Available Copilot models:")
  models.forEach((model, index) => console.log(`  ${index + 1}. ${model.name} (${model.id})`))
  const prompt = readlinePromises.createInterface({ input: process.stdin, output: process.stdout })
  try {
    for (;;) {
      const answer = (await prompt.question("Select model (number or ID): ")).trim()
      const selected = models.find(model => model.id === answer)
        || (/^[1-9]\d*$/.test(answer) ? models[Number(answer) - 1] : undefined)
      if (selected) return selected.id
      console.error("Select a listed model number or ID.")
    }
  } finally {
    prompt.close()
  }
}

async function promptForAuth(initialName) {
  let name = initialName?.trim()
  let model = options.model?.trim()
  const interactive = process.stdin.isTTY && process.stdout.isTTY
  let prompt
  try {
    if ((!name || (!model && name !== COPILOT_AUTH_NAME)) && interactive) {
      prompt = readlinePromises.createInterface({ input: process.stdin, output: process.stdout })
      if (!name) name = (await prompt.question("Azure deployment name (or @copilot): ")).trim()
      if (!model && name !== COPILOT_AUTH_NAME) {
        model = (await prompt.question(`Model [${DEFAULT_AZURE_MODEL}]: `)).trim() || DEFAULT_AZURE_MODEL
      }
    }
  } finally {
    prompt?.close()
  }
  if (!name) throw new Error("Auth name is required. Run: minicode auth add <deployment> or minicode auth add --copilot")
  if (name === COPILOT_AUTH_NAME) {
    if (options.entraUser || options.tenant || options.endpoint) {
      throw new Error("--entra-user, --tenant, and --endpoint are only supported with Azure deployments, not @copilot.")
    }
    if (!model && !interactive) {
      throw new Error("Copilot model selection requires a terminal. Use: minicode auth add --copilot --model <id>")
    }
    return addCopilotAuth({ model, selectModel: promptForCopilotModel, onPrompt: promptForCopilotSignIn })
  }
  return addAzureDeployment({
    name,
    model: model || DEFAULT_AZURE_MODEL,
    endpoint: options.endpoint,
    entraUser: options.entraUser,
    tenant: options.tenant,
  })
}

async function ensureAuthConfigured() {
  if (process.env.MINICODE_AUTH_ENTRY) {
    await getActiveAuthSummary()
    return
  }
  if (process.env.OPENCODE_API_KEY || process.env.OPENAI_API_KEY) return
  const deployments = await listAuthConfigs()
  if (deployments.length) return
  console.log(`${C.cyan}First-run auth setup${C.reset}`)
  return promptForAuth()
}

const AUTH_COMMANDS = new Set(["auth", "providers"])
if (AUTH_COMMANDS.has(options.positional[0])) {
  try {
    process.exitCode = await runAuth(options.positional.slice(1))
  } catch (error) {
    console.error(`Minicode auth: ${error.message}`)
    process.exitCode = 1
  }
  process.exit(process.exitCode)
}
if (options.positional[0] === "web") {
  try {
    const [, port, ...extra] = options.positional
    if (extra.length || (port !== undefined && !/^\d+$/.test(port))) {
      throw new Error("Usage: minicode web [port] [--auth <entry>]")
    }
    if (port !== undefined && Number(port) > 65535) throw new Error("Web port must be between 0 and 65535.")
    process.env.MINICODE_REPO_ROOT = path.resolve(options.repoRoot || process.env.MINICODE_REPO_ROOT || process.cwd())
    process.env.MINICODE_WEB_PORT = port ?? process.env.MINICODE_WEB_PORT ?? "0"
    await ensureAuthConfigured()
    await import("./server/index.js")
  } catch (error) {
    console.error(`Minicode web: ${error.message}`)
    process.exitCode = 1
  }
} else if (options.positional[0] === "worker") {
  try {
    await runAgentPoolWorkerCli(options.positional.slice(1), options.repoRoot)
  } catch (error) {
    console.error(`AgentPool worker: ${error.message}`)
    process.exitCode = 1
  }
} else {

/* ----------------------------------------------------------------- agent */

await ensureAuthConfigured()

const cwd = path.resolve(options.repoRoot || process.env.MINICODE_REPO_ROOT || process.cwd())

// The same session class the web portal drives, so the CLI and the browser
// share one agent implementation.
const session = new AgentSession({ id: "cli", cwd })

session.on("output", ({ stream, data }) => {
  // AgentSession emits terminal-style CRLF for xterm.js; normalise for a TTY.
  const text = data.replace(/\r\n/g, "\n")
  if (stream === "stderr") process.stderr.write(text)
  else process.stdout.write(text)
})

function runTurn(prompt) {
  return new Promise((resolve) => {
    session.once("done", resolve)
    session.write(prompt)
  })
}

async function runNoTools(prompt) {
  const config = await resolveModelConfig()
  console.log(await callModelOnce(config, [{ role: "user", content: prompt }]))
}

async function runRepl() {
  let config
  try {
    config = await resolveModelConfig()
    session.config = config
  } catch (error) {
    console.error(`${C.red}${error.message}${C.reset}`)
    process.exit(1)
  }

  console.log(`${C.green}minicode${C.reset} ${C.dim}${config.deployment || "API key"} · ${config.model} · ${config.user || "API key"}${C.reset}`)
  console.log(`${C.dim}repo: ${cwd}${C.reset}`)
  console.log(`${C.dim}type 'exit' to quit, '/clear' to reset the conversation${C.reset}\n`)

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${C.green}minicode${C.reset} ${C.dim}${path.basename(cwd)}${C.reset}> `,
    historySize: 200,
  })

  rl.on("SIGINT", () => {
    if (session.busy) {
      session.interrupt()
      return
    }
    rl.close()
  })

  rl.prompt()

  for await (const line of rl) {
    const value = line.trim()

    if (!value) {
      rl.prompt()
      continue
    }
    if (EXIT_COMMANDS.has(value.toLowerCase())) break

    if (value === "/clear") {
      session.messages.length = 0
      console.log(`${C.dim}conversation cleared${C.reset}`)
      rl.prompt()
      continue
    }
    if (value === "cls" || value === "clear") {
      // Clear the screen and forget the conversation so the model context and
      // the terminal scrollback both stay bounded.
      session.messages.length = 0
      process.stdout.write("\u001b[2J\u001b[3J\u001b[H")
      rl.prompt()
      continue
    }
    if (value === "/cwd") {
      console.log(`${C.dim}${cwd}${C.reset}`)
      rl.prompt()
      continue
    }
    if (value === "/model") {
      const active = session.config || config
      console.log(`${C.dim}${active.deployment || "API key"} · ${active.model} · ${active.user || "API key"}${C.reset}`)
      rl.prompt()
      continue
    }

    rl.pause()
    await runTurn(value)
    rl.resume()
    rl.prompt()
  }

  rl.close()
  session.dispose()
  console.log(`${C.dim}bye${C.reset}`)
}

const oneShot = options.positional.join(" ").trim()

if (oneShot) {
  if (options.noTools) await runNoTools(oneShot)
  else {
    await runTurn(oneShot)
    session.dispose()
  }
} else {
  await runRepl()
}
}
