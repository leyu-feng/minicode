#!/usr/bin/env node
import path from "node:path"
import readline from "node:readline"
import { AgentSession, callModelOnce } from "./server/agent-session.js"
import { authFilePath, listProviders, loginGithubCopilot, logoutProvider, resolveModelConfig } from "./server/auth.js"

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
  minicode auth login            Sign in to GitHub Copilot (device code)
  minicode auth list             Show saved credentials
  minicode auth logout [provider]
  minicode --help

Options:
  --repo-root <dir>       Working directory for shell commands
  --model <name>          Override the model for this run
  --enterprise-url <url>  GitHub Enterprise host (with 'auth login')

REPL commands:
  exit, quit, :q     Leave
  cls, clear         Clear the screen and forget the conversation
  /clear             Forget the conversation so far
  /cwd               Show the working directory
  /model             Show the active model

Ctrl+C cancels the current turn; Ctrl+C at an empty prompt exits.

Environment:
  OPENCODE_API_KEY, OPENCODE_BASE_URL, OPENCODE_MODEL (default claude-opus-4.8)
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
    else if (arg === "--provider" && argv[i + 1]) options.provider = argv[++i]
    else if (arg === "--enterprise-url" && argv[i + 1]) options.enterpriseUrl = argv[++i]
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
    const result = await loginGithubCopilot({
      provider: options.provider,
      enterpriseUrl: options.enterpriseUrl,
      onPrompt: ({ verificationUri, userCode }) => {
        console.log(`Go to:      ${C.cyan}${verificationUri}${C.reset}`)
        console.log(`Enter code: ${C.cyan}${userCode}${C.reset}`)
        console.log(`${C.dim}waiting for authorization…${C.reset}`)
      },
    })
    console.log(`${C.green}Login successful for ${result.provider}${C.reset}`)
    console.log(`${C.dim}saved to ${result.path}${C.reset}`)
    return 0
  }

  if (action === "list") {
    const providers = await listProviders()
    if (!providers.length) {
      console.log("No saved provider credentials.")
      console.log(`${C.dim}run: minicode auth login${C.reset}`)
      return 0
    }
    for (const { provider, type } of providers) console.log(`${provider} (${type})`)
    console.log(`${C.dim}${authFilePath()}${C.reset}`)
    return 0
  }

  if (action === "logout") {
    const provider = argv[1] || "github-copilot"
    const removed = await logoutProvider(provider)
    console.log(removed ? `Logged out ${provider}` : `No saved credential for ${provider}.`)
    return 0
  }

  console.error(`Unknown auth command: ${action}`)
  usage()
  return 1
}

const AUTH_COMMANDS = new Set(["auth", "providers"])
if (AUTH_COMMANDS.has(options.positional[0])) {
  process.exit(await runAuth(options.positional.slice(1)))
}

/* ----------------------------------------------------------------- agent */

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
    console.error(`${C.red}Not signed in.${C.reset} Run: minicode auth login`)
    process.exit(1)
  }

  console.log(`${C.green}minicode${C.reset} ${C.dim}${config.model}${C.reset}`)
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
      console.log(`${C.dim}${session.config?.model || config.model}${C.reset}`)
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
  else await runTurn(oneShot)
  session.dispose()
  process.exit(0)
}

await runRepl()
process.exit(0)
