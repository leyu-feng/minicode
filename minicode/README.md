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

### Sign in as a specific user

Use Azure CLI with a separate identity cache for each requested UPN/tenant:

```powershell
.\minicode.ps1 auth add my-resource --model gpt-5.6-sol --entra-user alice@contoso.com
.\minicode.ps1 auth login
.\minicode.ps1 auth list
```

`--entra-user` is a UPN, not an object ID. Add `--tenant <tenant-id-or-domain>`
when selecting a particular tenant (for example, for a guest account).
Adding this profile runs `az login`. Select the requested account in the sign-in
dialog; Minicode verifies the account, tenant, and model-resource token before
saving the profile. A different account or failed login does not replace the saved
profile. Azure CLI must be installed, and the account must have model-resource
permissions. This does not use a username/password login.

Minicode stores only the deployment, endpoint, model, credential provider, UPN,
tenant, and Azure CLI cache directory in `auth.json`, **not access or refresh
tokens**. Each identity uses its own `AZURE_CONFIG_DIR` under Minicode's
`azure-cli` configuration directory. Only the child Azure CLI process receives
this setting: your normal Azure CLI cache and active account are unchanged.
Different deployments/Minicode processes can therefore use different identities
at the same time. Running plain `az login` outside Minicode does not sign into
these isolated caches.

Agent-run shell commands and their child processes inherit the session's
`AZURE_CONFIG_DIR`, so commands such as `az account list` use the same identity
as the session's model requests. The model profile is pinned when the session
first resolves it (at startup for the CLI REPL, or on the first prompt otherwise).
Changing `auth use` affects new sessions, not an already-bound session, even
after clearing its conversation. The outer terminal's environment is unchanged.
This is environment inheritance, not a security boundary: commands can override it.
Standalone web shell and Pi panes retain their existing environments.

Runtime token requests use the saved cache and tenant, verify the selected account,
and renew silently through `az account get-access-token`. Each newly acquired token
is decoded to check its username (`preferred_username`, `upn`, or `unique_name`)
and tenant (`tid`) against the saved profile before it is cached or used.
Missing, unreadable, or mismatched claims fail explicitly. These are identity
consistency checks, not local signature validation; Azure validates the token
and permissions when the model API receives it. If interaction is
required, run `minicode auth login` with that deployment active. Runtime requests
never open a sign-in dialog. `auth clear` removes Minicode profiles but does not
delete Azure CLI caches or sign accounts out.

Without `--entra-user`, existing Azure CLI behavior is unchanged and uses your
normal active account. Model authentication has no `clippy-auth` or MSAL dependency.
Old `clippy-auth` model profiles must be re-added with
`auth add <deployment> --entra-user <upn>` (and `--model`, `--endpoint`, or
`--tenant` as needed); they never silently fall back to another identity.
The worker's separate Easy Auth session still uses `clippy-auth`, and its
`--clippy-auth <path-to-cli.js>` override remains available.

Both the CLI (including `/model` and `auth list`) and the web toolbar show
**deployment · model · UPN** for identity-bound profiles. Unbound Azure CLI
profiles use the literal display name **`login@az.cli`**, rather than attempting
to identify Azure CLI's current account.

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

Worker system instructions restrict writes to the assigned agent workspace.
Reads and searches are allowed in that workspace and one **read-only shared
folder**, defaulting to `worker_shared` beside the canonical source repository
root. For example, `D:\Code\workspace\your-repo` uses
`D:\Code\workspace\worker_shared`. Override it with `--worker-shared <directory>`.
Relative overrides resolve from the worker process's current directory.
Minicode creates an empty folder if missing; its parent must already exist.
The shared folder must not overlap the source checkout or agent workspace storage,
including through directory links. Workers must not follow links outside either
permitted scope.

The shared path is included in each assignment's instructions and exposed to
shell tools as `WORKER_SHARED`. Operators can place shared configuration,
reference files, or skills there without committing them to a repository.
For example, read the instance config with
`Get-Content (Join-Path $env:WORKER_SHARED '.config\stock-trading-assistant.jsonc')`.
Shared files are not automatically loaded as instructions or copied into agent
clones. Workers are instructed never to create, modify, delete, move, or change
permissions on shared files. **Read-only access is instruction policy, not an
OS permission or sandbox**; the worker account still has its normal privileges.
No Windows ACLs or operator write permissions are changed. Use a restricted
identity or sandbox if writes must be prevented independently of the model.

Missing skills/instructions, missing server credentials/endpoints, connection
failures, and authentication/authorization failures must be reported as blockers,
not worked around by scanning personal folders, other repositories, ports, or
server implementations. An already-working authorized reporting channel may be
used; otherwise the worker returns the blocker in its run result. A final action
with an `error` marks the run failed. These are model instructions, not OS-enforced
filesystem isolation; use a sandbox or restricted account for that guarantee.
Restart running workers to load instruction changes.

Before each assignment, the worker loads the assigned clone's root `AGENTS.md`,
if present, into the model's system instructions. It reads the current workspace
copy on every run, so edits apply to the next assignment without restarting the
worker. Built-in worker workspace and failure rules take precedence. Only that
root file is loaded; parent directories, nested `AGENTS.md` files, and skill
directories are not scanned. A missing file is optional; an unreadable file or
a directory/symbolic link named `AGENTS.md` fails the run before the model starts.
The run log records when the file is loaded, without logging its contents.
Commit instructions to the source repository for new clones; existing clones
retain their own files and do not automatically receive source updates.
This automatic loading applies only to worker mode; interactive CLI and web
sessions are unchanged.

For instructions specific to an agent rather than its repository, use that
agent's **Instructions** tab in Clippy. The saved managed entry document is
delivered inline with every new assignment and applied to the model's system
instructions; no repository commit, worker file, or restart is required for
content edits. Built-in worker rules take precedence over agent-specific
instructions, which take precedence over repository guidance. Active runs and
network reconnects retain their original instruction snapshot. Supporting bundle
files are not transferred. Restart older workers once to load inline-instruction
support; incompatible workers cannot receive assignments requiring it.

Worker logging defaults to **normal**: raw shell/tool output still goes to the
model, but is not streamed to Clippy's run log or counted against the public
output limit. Command progress, exit status, errors, and the model's response
remain visible. To retain the previous full-output behavior, start with
`--output-mode verbose`; `--output-mode normal` is the explicit default.
Interactive CLI and web logging are unchanged.

Other worker implementations can use the same versioned, capability-negotiated
[AgentPool protocol](../clippy/doc/agent-pool-protocol.md), without depending on
Minicode internals.

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
.\minicode.ps1 web 7317 --auth my-resource
```

`--auth <entry>` selects a saved entry from `auth list` for this web process,
without changing the shared active entry in `auth.json`. Separate web instances
can select different entries and identities. The selection survives portal
restarts and applies to the toolbar, new agent sessions, model tokens, and
agent-run Azure CLI commands. Unknown entries fail at startup instead of falling
back to the active entry. The flag also works with the terminal agent.
An explicit selection takes precedence over API-key provider environment variables;
existing endpoint and model overrides still apply.

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
