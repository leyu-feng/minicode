# minicode

A pure-Node coding agent that runs shell commands, with two front ends:

- a **terminal CLI** (`cli.js`) — REPL, one-shot prompts, and auth;
- a **web portal** (`server/`) — a background Node.js server that serves a
  localhost page with xterm.js split panes.

Both drive the same `AgentSession` class and the same `auth.js`, so there is one
agent implementation and one credential path to maintain. Nothing here needs
native modules (no `node-pty`, no platform binaries).

## Run the terminal agent

```cmd
bootstrap\minicode.cmd                            REM interactive REPL
bootstrap\minicode.cmd "explain minicode.ps1"     REM one prompt, then exit
bootstrap\minicode.cmd --no-tools "what is bun?"  REM no shell commands
```

Or directly:

```powershell
.\minicode.ps1
.\minicode.ps1 "explain minicode.ps1"
.\minicode.ps1 --repo-root C:\some\repo
.\minicode.ps1 --model gpt-5.4 "summarise this repo"
```

Sign in with Azure CLI:

```powershell
az login
.\minicode.ps1 auth login
.\minicode.ps1 auth add my-resource --model gpt-5.6-sol
.\minicode.ps1 auth list
.\minicode.ps1 auth use my-resource
.\minicode.ps1 auth clear
```

Minicode requests an Entra token for Azure Cognitive Services from the active
Azure CLI account. Tokens remain managed by Azure CLI and are never written to
minicode configuration files. On first run, minicode asks for an Azure
deployment name and default model. Named deployments are stored in
`auth.json`; add more with `auth add` and switch with `auth use`.
Use `auth clear` to remove all saved minicode auth options and return to
first-run setup without signing out of Azure CLI.

REPL commands: `exit`/`quit`/`:q` to leave, `/clear` to reset the conversation,
`/cwd` for the working directory, `/model` for the active model. `Ctrl+C`
cancels the current turn; `Ctrl+C` at an empty prompt exits. **Conversation
history persists across prompts**, so follow-ups like "now add a flag to it"
work.

This runs entirely in your terminal — no server is started and no browser is
opened.

## Connect as an AgentPool worker

Clippy keeps every existing adapter and adds **AgentPool** (`agent_pool`). Its
only adapter setting is the company pool name:

```json
{ "name": "default" }
```

In Clippy's **Company settings → AgentPool workers**, select the automatic
`default` pool or create a distinct pool (lowercase letters, numbers, hyphens,
underscores; at most 64 characters). Choose **Pair worker**, give it a display
name, and copy the one-time server token. Each worker needs its own pairing.
Choose AgentPool when hiring an agent and enter that pool's name.
The agent's setup check requires a connected worker in that company's selected
pool; a busy worker still passes setup, but dispatch requires an idle worker.
Model access is checked when a task runs, not by the pool connection check.

Configure Minicode's model/auth on the worker first using the normal `auth`
commands. Command-line entry points retain their current-directory behavior.
For worker testing, use the `clippy-worker` submodule
(`https://github.com/leyu-feng/clippy-worker.git`) as an explicitly selected source
repository. Initialize it from the top-level minicode repository:

```powershell
git submodule update --init clippy-worker
```

Set the pairing token in the worker shell, resolve the submodule's full path,
then pass it to the worker:

```powershell
$env:MINICODE_AGENT_POOL_PAIRING_TOKEN = "<one-time token from Clippy>"
$workerRepo = (Resolve-Path .\clippy-worker).Path
node .\minicode\cli.js worker --server https://clippy.example.com --worker-id <worker-id> --repo-root $workerRepo
```

The same full `--repo-root` path can be passed to `bootstrap\minicode.cmd` or
`minicode.ps1`; `-repo_root` is also supported. The source must be a Git repository
root with at least one commit. Without an explicit source, the worker follows
the launcher's working directory (`MINICODE_REPO_ROOT`) or the current directory,
not the sibling submodule. Existing paired workers remain bound to their saved
source repository; changing it requires a newly paired worker.

HTTP is allowed only for loopback development, for example
`--server http://127.0.0.1:3100`. The server origin must be reachable from the
worker, and its reverse proxy must forward WebSocket upgrades for
`/api/agent-pool/worker`. No inbound port is opened on the worker.

Minicode generates a random client token locally and persists it under
`agent-pool\<worker-id>.json` in its existing configuration directory
(`MINICODE_CONFIG_HOME` overrides it). Clippy stores only credential hashes.
The server token expires after ten minutes and can be consumed once. It is
removed from Minicode's process environment before tools run. Unset it in the
parent shell after pairing; later starts use the same command without a pairing
token. The saved client credential is bound to the server and source repository;
pair a new worker to change either. Protect this file with your user account's
filesystem permissions, especially on Windows.

Multiple workers can join a pool. Each assignment goes to one idle worker, with
a fresh AgentSession and the worker's model configuration. Its actual tool
working directory is a persistent, independent Git clone for that agent, under
`agent-pool\workspaces\<worker-id>\<agent-id>` in Minicode's configuration
directory. Workspaces must be outside the source checkout. The first assignment
clones committed files from the source's current `HEAD`; uncommitted changes,
untracked files and installed dependencies are not copied. Later runs on that
worker retain the agent's edits without resetting or pulling. Different agents
and workers do not share these checkouts. Repositories listed as submodules are
not initialized automatically.

The actual local workspace path is recorded in the run log. Workspace paths
from Clippy's server-side context are metadata, not worker filesystem paths.
Existing files left in the old shared worker root are not migrated. Agent
workspaces remain on disk after a run, worker restart or revocation so their
results can be inspected; no automatic cleanup or cross-worker migration occurs.
Workspace preparation failures fail the run without falling back to the source
checkout. These are trusted coding agents, **not sandboxes**: assignments can execute shell
commands with the worker account's privileges. Run-scoped Paperclip credentials
are delivered to that session's tool environment, not its model prompt.
The model receives only allowlisted task, wake, handoff and workspace context;
runtime configuration is excluded even when nested in the server context.

An offline or fully busy pool fails the run visibly rather than waiting forever.
An interrupted network connection can resume the **same live execution** for up
to 60 seconds while both processes survive. Sequenced logs and results are
acknowledged; the assignment prompt is never replayed. Process restarts, an
expired reconnect lease, or revocation fail affected work and require an explicit
retry. Stop/ Ctrl+C cancels the active operation; server cancellation waits for
the worker's operation to unwind before accepting its result. Output is limited
to 2 MiB per run and task frames to 256 KiB; overflow fails explicitly.

Worker-side file changes stay on the worker; this transport does not synchronize
workspaces. Provider usage/cost is not reported by this worker. Existing known
budget/admission gates still apply, but they cannot cap unreported model spend.
Revoke a worker in company settings to invalidate its credential and disconnect
it. Automatic execution-restart recovery and horizontal broker failover are not
supported; all workers and runs for an instance must reach the same Clippy process.

## Run the web portal

From any git repository:

```cmd
bootstrap\minicode.cmd web
```

Or directly:

```powershell
.\minicode.ps1 web            # random free port
.\minicode.ps1 web 7317       # fixed port
```

The server listens on `127.0.0.1` only and opens your default browser.

## Panes

| Pane kind | Behaviour |
| --- | --- |
| `agent` | Conversational minicode agent. Each prompt runs a tool loop that executes shell commands in the repo and streams the output. Conversation history is kept per pane. |
| `shell` | A long-lived PowerShell (or `bash`) process. Working directory, variables, and environment persist between commands. |

Toolbar actions: new agent/shell pane, split the focused pane right or down,
and close the focused pane. Panes can be nested arbitrarily.

Terminal keys: `Enter` submits, `Shift+Enter` inserts a newline in a prompt,
`Backspace` edits, `Up`/`Down` walk history, `Ctrl+C` clears the line (and
cancels an in-flight agent turn). Typing `exit`
(or `quit`) closes the pane and disposes its backend session; a pane also closes
automatically if its backend process ends. Closing the last pane leaves an empty
workspace — reopen one from the toolbar.

Function keys and browser shortcuts are deliberately **not** captured by the
terminal, so `F11` (fullscreen), `F12` (devtools), `Ctrl+Shift+I`, `Ctrl+R`,
zoom and tab shortcuts keep working normally in Edge/Chrome.

## Sessions survive a reload

Sessions are owned by the **server**, not by the browser tab. Each session keeps
a replay buffer of its transcript, so reloading the page (the toolbar `⟳ refresh`
button, `F5`, or `Ctrl+R`) reattaches to the still-running shells and agents —
working directory, shell variables, and agent conversation history are all kept.

The split layout, pane kinds, and per-pane command history are stored in
`localStorage`, so the workspace comes back looking the same.

Sessions end only when you close the pane (`exit`, or the `close` button), when
the server stops, or after `MINICODE_WEB_IDLE_MS` (default 30 min) with no
browser attached.

## Environment

| Variable | Purpose |
| --- | --- |
| `MINICODE_REPO_ROOT` | Working directory for all sessions (defaults to `process.cwd()`). |
| `MINICODE_WEB_PORT` | Listen port (`0`/unset picks a free port). |
| `MINICODE_WEB_OPEN` | Set to `0` to skip launching the browser. |
| `MINICODE_WEB_IDLE_MS` | Dispose detached sessions after this long with no client (default 30 min). |
| `AZURE_OPENAI_DEPLOYMENT` | Override the active named deployment from `auth.json`. |
| `AZURE_OPENAI_ENDPOINT` | Override the active deployment's Responses API endpoint. |
| `AZURE_OPENAI_MODEL` / `OPENCODE_MODEL` | Override the active deployment's model. |
| `OPENCODE_API_KEY` / `OPENCODE_BASE_URL` | Use an API-key-based OpenAI-compatible provider instead of Azure Entra. |
| `MINICODE_AGENT_POOL_PAIRING_TOKEN` | One-time AgentPool pairing token; omit after the initial pairing. |

## Limitation

There is no PTY, so sessions are line based. Full-screen/curses applications
(`vim`, `htop`, `git` pagers) will not render — use non-interactive flags such
as `git --no-pager`.

## Legacy entry point

Superseded, kept only as an escape hatch:

| Command | What it runs |
| --- | --- |
| `.\minicode.ps1 raw ...` | The original opencode Node fallback agent, which has no conversation memory. |
