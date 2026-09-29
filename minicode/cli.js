#!/usr/bin/env node
import path from "node:path"
import readline from "node:readline"
import readlinePromises from "node:readline/promises"
import { AgentSession, callModelOnce } from "./server/agent-session.js"
import {
  DEFAULT_AZURE_MODEL,
  addAzureDeployment,
  authFilePath,
  clearAuth,
  listAuthConfigs,
  loginAzureCli,
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
  minicode auth login            Sign in with Azure CLI
  minicode auth add [deployment] Add an Azure deployment
  minicode auth use <name>       Select the active auth
  minicode auth list             List configured auth options
  minicode auth clear            Clear deployment configuration
  minicode --help

Options:
  --repo-root <dir>       Working directory for shell commands
  --model <name>          Override the model for this run
  --endpoint <url>        Responses endpoint (with 'auth add')

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
    else if ((arg === "--repo-root" || arg === "-repo_root") && argv[i + 1]) options.repoRoot = argv[++i]
    else if (arg === "--model" && argv[i + 1]) options.model = argv[++i]
    else if (arg === "--endpoint" && argv[i + 1]) options.endpoint = argv[++i]
    else options.positional.push(arg)
  }
  return options
}

const options = parseArgs(process.argv.slice(2))

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

/* ------------------------------------------------------------------ auth */

async function runAuth(argv) {
  const action = argv[0] || "list"

  if (action === "login") {
    await ensureAzureDeployment()
    await loginAzureCli()
    console.log(`${C.green}Azure CLI login successful${C.reset}`)
    return 0
  }

  if (action === "add") {
    const deployment = await promptForAzureDeployment(argv[1])
    console.log(`${C.green}Active auth: ${deployment.name} · ${deployment.model}${C.reset}`)
    console.log(`${C.dim}${authFilePath()}${C.reset}`)
    return 0
  }

  if (action === "use") {
    if (!argv[1]) throw new Error("Usage: minicode auth use <name>")
    const deployment = await setActiveAuth(argv[1])
    console.log(`${C.green}Active auth: ${deployment.name} · ${deployment.model}${C.reset}`)
    return 0
  }

  if (action === "ensure") {
    await ensureAzureDeployment()
    return 0
  }

  if (action === "list") {
    const deployments = await listAuthConfigs()
    if (!deployments.length) {
      console.log("No Azure deployments configured.")
      console.log(`${C.dim}run: minicode auth add${C.reset}`)
      return 0
    }
    for (const deployment of deployments) {
      console.log(`${deployment.active ? "*" : " "} ${deployment.name} · ${deployment.model} (${deployment.provider})`)
      if (deployment.endpoint) console.log(`  ${C.dim}${deployment.endpoint}${C.reset}`)
    }
    console.log(`${C.dim}${authFilePath()}${C.reset}`)
    return 0
  }

  if (action === "clear") {
    const removed = await clearAuth()
    console.log(removed ? "Cleared minicode auth configuration." : "Minicode auth configuration is already empty.")
    console.log(`${C.dim}Azure CLI login was not changed.${C.reset}`)
    return 0
  }

  if (action === "logout") {
    console.log("Azure CLI credentials are managed outside minicode. Run: az logout")
    return 0
  }

  console.error(`Unknown auth command: ${action}`)
  usage()
  return 1
}

async function promptForAzureDeployment(initialName) {
  let name = initialName?.trim()
  let model = options.model?.trim()
  const interactive = process.stdin.isTTY && process.stdout.isTTY
  let prompt
  try {
    if ((!name || !model) && interactive) {
      prompt = readlinePromises.createInterface({ input: process.stdin, output: process.stdout })
      if (!name) name = (await prompt.question("Azure deployment name: ")).trim()
      if (!model) {
        model = (await prompt.question(`Model [${DEFAULT_AZURE_MODEL}]: `)).trim() || DEFAULT_AZURE_MODEL
      }
    }
  } finally {
    prompt?.close()
  }
  if (!name) throw new Error("Azure deployment name is required. Run: minicode auth add <name>")
  return addAzureDeployment({
    name,
    model: model || DEFAULT_AZURE_MODEL,
    endpoint: options.endpoint,
  })
}

async function ensureAzureDeployment() {
  if (process.env.OPENCODE_API_KEY || process.env.OPENAI_API_KEY) return
  const deployments = await listAuthConfigs()
  if (deployments.length) return
  console.log(`${C.cyan}First-run Azure setup${C.reset}`)
  await promptForAzureDeployment()
}

const AUTH_COMMANDS = new Set(["auth", "providers"])
if (AUTH_COMMANDS.has(options.positional[0])) {
  process.exit(await runAuth(options.positional.slice(1)))
}

/* ----------------------------------------------------------------- agent */

await ensureAzureDeployment()

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
  const config = await resolveModelConfig().catch(() => null)
  if (!config) {
    console.error(`${C.red}Not signed in.${C.reset} Run: az login`)
    process.exit(1)
  }

  console.log(`${C.green}minicode${C.reset} ${C.dim}${config.deployment} · ${config.model}${C.reset}`)
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
      console.log(`${C.dim}${active.deployment} · ${active.model}${C.reset}`)
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
