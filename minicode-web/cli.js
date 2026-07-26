#!/usr/bin/env node
import path from "node:path"
import readline from "node:readline"
import { AgentSession } from "./server/agent-session.js"

const C = {
  reset: "\u001b[0m",
  dim: "\u001b[90m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m",
  red: "\u001b[31m",
}

const EXIT_COMMANDS = new Set(["exit", "quit", "/exit", "/quit", ":q"])

function parseArgs(argv) {
  const options = { repoRoot: null, prompt: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if ((arg === "--repo-root" || arg === "-repo_root") && argv[i + 1]) {
      options.repoRoot = argv[++i]
    } else if (arg === "--help" || arg === "-h") {
      options.help = true
    } else {
      options.prompt.push(arg)
    }
  }
  return options
}

function usage() {
  console.log(`minicode chat - standalone terminal agent

Usage:
  minicode.ps1 chat                      Interactive REPL
  minicode.ps1 chat "<prompt>"           Run one prompt and exit
  minicode.ps1 chat --repo-root <dir>    Override the working directory

Commands inside the REPL:
  exit, quit, :q     Leave
  /clear             Forget the conversation so far
  /cwd               Show the working directory

Ctrl+C cancels the current turn; Ctrl+C at an empty prompt exits.`)
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  usage()
  process.exit(0)
}

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

async function runOnce(prompt) {
  await runTurn(prompt)
  session.dispose()
  process.exit(0)
}

async function runRepl() {
  console.log(`${C.green}minicode${C.reset} ${C.dim}standalone agent${C.reset}`)
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
    const input = line.trim()

    if (!input) {
      rl.prompt()
      continue
    }

    if (EXIT_COMMANDS.has(input.toLowerCase())) break

    if (input === "/clear") {
      session.messages.length = 0
      console.log(`${C.dim}conversation cleared${C.reset}`)
      rl.prompt()
      continue
    }

    if (input === "/cwd") {
      console.log(`${C.dim}${cwd}${C.reset}`)
      rl.prompt()
      continue
    }

    rl.pause()
    await runTurn(input)
    rl.resume()
    rl.prompt()
  }

  rl.close()
  session.dispose()
  console.log(`${C.dim}bye${C.reset}`)
  process.exit(0)
}

const oneShot = options.prompt.join(" ").trim()
if (oneShot) await runOnce(oneShot)
else await runRepl()
