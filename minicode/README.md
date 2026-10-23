# minicode

A pure-Node coding agent that runs shell commands, with two front ends:

- a **terminal CLI** (`cli.js`) — REPL, one-shot prompts, and auth;
- a **web portal** (`server/`) — a background Node.js server that serves a
  localhost page with xterm.js split panes.

Both drive the same `AgentSession` class and the same `auth.js`, so there is one
agent implementation and one credential path to maintain. Nothing here needs
native modules (no `node-pty`, no platform binaries).

On Windows, install **PowerShell 7** and ensure `pwsh.exe` is available on
`PATH`. Agent commands and web terminal shells run directly in PowerShell 7,
not Windows PowerShell 5.1; there is no automatic fallback. The agent's shell
guidance matches that runtime, so commands do not need a nested PowerShell
wrapper. On other platforms, command execution continues to use Bash.

## Managed Hosted runtime

The AgentPool provider launches `hosted-worker` only as a child of its credential-owning
parent process. Its private JSONL stdin/stdout channel supplies pairing, state, Easy Auth,
trusted repository restoration and transient model/git credentials. It is not a
standalone interactive worker command and does not persist an auth file.
Diagnostics go to stderr. The regular `worker` CLI remains unchanged.

Package the contained Node application and production dependencies as the
provider's tool-store format, from the repository root:

```powershell
dotnet pack minicode\tool\Minicode.Contained.csproj -c Release -o artifacts
```

The `Minicode.Contained` .NET 8 tool requires Node 22 or later on PATH in the
provider image. Publish the resulting package through the provider's tool
container workflow before enabling Hosted jobs; building it does not publish or
deploy anything. Hosted workers use 1/2 GiB minimum/target free-space thresholds,
instead of the regular worker's 24/36 GiB defaults.

With a shared-fleet bootstrap, one parent maintains up to 32 unique pool
connections. Provider admission and broker execution grouping prevent concurrent
assignments on one physical container. The winning assignment detaches the other
bindings; the provider owns idle capacity targets and organization concurrency limits.
Stable worker slot IDs rotate credentials by generation when reused.

Completion waits for the broker's retirement receipt before asking the provider parent to
fetch/reset/clean all owned repositories and remove old task state. No replacement
binding becomes ready until that cleanup succeeds. A cleanup failure stops the
container. This cleanup is not an OS sandbox.

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

For Azure profiles, Minicode requests an Entra token for Azure Cognitive Services from the active
Azure CLI account. Tokens remain managed by Azure CLI and are never written to
minicode configuration files. On first run, minicode asks for an Azure
deployment name and default model. Named deployments are stored in
`auth.json`; add more with `auth add` and switch with `auth use`.
Use `auth clear` to remove all saved minicode auth options and return to
first-run setup without signing out of Azure CLI.

### GitHub Copilot

Use **`--copilot`** on the command line. The saved entry is named **`@copilot`**:

```powershell
.\minicode.ps1 auth add --copilot
.\minicode.ps1 auth add --copilot --model gpt-5.4
.\minicode.ps1 auth use --copilot
.\minicode.ps1 --copilot "explain this repo"
.\minicode.ps1 web --copilot
```

The interactive `auth add` prompt also accepts `@copilot`. The `--copilot`
flag avoids PowerShell's splatting syntax; the quoted name remains supported
with `auth add '@copilot'`, `auth use '@copilot'`, and `--auth '@copilot'`.
Do not combine `--copilot` with a different auth name or `--auth` entry.
Minicode prints GitHub's device sign-in URL and code, verifies the GitHub
account, then lists its enabled, picker-visible models supported by this agent.
Select a model by number or exact ID; there is no hardcoded Copilot model or
automatic first-model selection. The chosen model is saved with `@copilot`.
Pass `--model <id>` to skip the picker (required without an interactive terminal);
the model is still checked against the account's catalog. `auth login` retains
the entry's previously selected model.
A failed sign-in or access check leaves existing auth configuration unchanged.
Failed auth and model HTTP requests report the endpoint, provider error details
(when supplied), and available request IDs. Credentials are redacted; request
headers and prompt bodies are not logged.
Copilot models must expose Responses or Chat Completions; models exposing only
the Anthropic Messages API are not supported by this agent.

Copilot compatibility headers use version `0.26.7`, plugin
`copilot-chat/0.26.7`, user agent `GitHubCopilotChat/0.26.7`, and API version
`2025-04-01`. When maintaining these settings, check
[`ericc-ch/copilot-api`'s API configuration](https://github.com/ericc-ch/copilot-api/blob/master/src/lib/api-config.ts)
for updates. This is a version-header reference, not an automatic dependency.
GitHub REST requests separately use their supported `2022-11-28` API
version; the Copilot API version is not valid for that endpoint.
Requests also carry the VS Code integration headers; the editor compatibility
version is pinned to upstream's `1.104.3` fallback rather than fetched from a
third-party package registry.

Unlike Azure profiles, Copilot stores its GitHub OAuth credential in Minicode's
`auth.json`. Protect this file with your user account's filesystem permissions.
Following upstream's login flow, Minicode exchanges this credential at GitHub's
`/copilot_internal/v2/token` endpoint for a short-lived Copilot API token. Model
discovery and inference use that API token, cached only in memory and renewed
on demand before its expiry or advertised refresh interval.
It does not read or change Copilot CLI, Azure CLI, or other applications' logins.
`auth login` repeats device sign-in for the selected Copilot entry when needed;
runtime requests never start interactive login. `auth clear` removes the saved
credential but does not revoke the GitHub OAuth grant; revoke it separately in
GitHub Settings > Applications if required.

Azure entries remain available through `auth use <deployment>`. The CLI and
web toolbar display **`@copilot` · model · GitHub-login`@github.com`** without
exposing credentials. `--copilot` selects it only for that process (except
`auth add` and `auth use`, which save the active selection);
changing the saved active entry does not switch already-running workers
launched with an explicit `--auth <entry>`.

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

For Azure profiles, Minicode stores only the deployment, endpoint, model, credential provider, UPN,
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
a fresh AgentSession and the worker's model configuration. Every worker in a
pool must be able to serve every agent connected to that pool. Use different
pools when worker setup differs; workers are not pinned to particular agents.

`--workspace-mode worktree` is the default. The worker creates an isolated Git
worktree beside `--repo-root` for each worker/agent pair. `--worker-name` is its
short prefix, or `w-<first 12 worker-id characters>` if omitted. An `a<slot>`
suffix identifies that worker's agent; final folder names use at most 24 safe
filename characters, so leave room for the suffix. For example:

```powershell
node .\minicode\cli.js worker --server http://localhost:3100 --worker-id <id> --repo-root C:\repos\my-project\main --workspace-mode worktree --worker-name w1
```

The assigned tool directories are `C:\repos\my-project\w1a1`, `w1a2`, etc.; another
worker uses `w2a1`, `w2a2`, etc. Slots are allocated as each worker first sees an
agent and remain stable across restarts; `a1` is not a global agent number.
Each worktree uses its own same-named local branch (`w1a1`, `w1a2`, etc.), never
the shared source branch. Those branch names are harness-owned; do not rename,
delete, or use them in another checkout. Existing detached worker worktrees are
migrated on their next assignment; conflicting pre-existing branches are refused.
The worker/agent registry is kept in the common Git administrative directory,
with ownership metadata in each worktree's Git directory, not tracked files.
Unmanaged directories and another worker's worktrees are never adopted or reset.
Existing old `w1`-style directories are left untouched, not migrated.

Before **every new assignment**, Minicode fetches the primary repository's assigned
remote branch and hard-resets the selected worktree's **own local branch** to that
commit, then removes
untracked and ignored files with `git clean -ffdx`. This includes installed
dependencies and the `.worker` skill cache, which is downloaded and verified
again. The source checkout's branch, HEAD, and dirty files, other workers' branches,
and `worker_shared` are untouched; only shared Git objects and harness fetch refs
are updated. A network reconnect does not reset or replay an active
assignment. Save durable results through artifact/task APIs or the enabled
publication tool before finishing; local changes do not survive reassignment.
Minicode also checks free space on the worktree volume when connected, every
60 seconds, and before/after assignment checkout preparation. Below **24 GiB**
it evicts this worker's **idle** owned worktrees in least-recently-used order,
trying to recover to **36 GiB**. Override these defaults with
`--min-free-gib <GiB>` and `--target-free-gib <GiB>` (target must exceed minimum).
Last-use timestamps and agent slots survive restarts; evicted slots are
recreated at the same short path on demand. Cleanup continues toward the target
once triggered, but model work is allowed if at least the minimum is available.
Disk measurement or cleanup errors are reported; insufficient space fails the
assignment before model work, not by falling back to source or a different disk.
Periodic checks log pressure, recovery, and actual evictions without repeating
unchanged healthy status.

LRU eviction uses Git's worktree removal only after validating the exact
worker/server/source/agent binding and checking source/shared boundaries again.
It also deletes that checkout's disposable harness-owned branch, but not branches
created for task results.
The active assignment remains protected until completion is acknowledged, even
if disk space stays low. Another worker's checkouts, old `w1`-style folders,
legacy clones, unmanaged directories, source/common Git storage, and
`worker_shared` are never cleanup targets. Idle local results may be evicted
without waiting for another assignment: upload/publish durable results first.
Worktrees share Git objects, refs, repository configuration, and local exclusions
with the source; they are not independent clones. Do not remove the source's
common Git storage while a worker depends on it.

`--workspace-mode clone` retains the old behavior: a persistent independent clone
per agent under `agent-pool\workspaces\<worker-id>\<agent-id>` in Minicode's
configuration directory. Use this flag when restarting older workers to keep
using their existing checkouts; changing modes does **not** migrate edits.
This mode can serve different agents without sharing their checkouts and does
not accept `--worker-name`.

Both modes start each assignment at the assigned remote branch's latest fetched
commit; uncommitted source changes, untracked files and installed dependencies
are not copied. Clone mode also hard-resets tracked edits and local commits when
an assigned remote is configured, then runs `git clean -xdf` to remove untracked
and ignored files.
For a local-only primary source with no remotes, the previous behavior is retained:
worktree mode uses committed source `HEAD`, while clone mode retains later edits.
Remote refresh is unavailable for that primary until it has a configured remote.
Repositories listed as submodules are not initialized automatically.

Use `--repo-root "main@D:\Code\my-project\main"` to explicitly assign the primary
remote branch, or omit `main@` to capture the source branch's configured upstream
at worker startup (otherwise its current branch on `origin`). The assigned remote
is the source branch's upstream remote, or `origin` when no upstream is configured.
A detached source with a remote requires an explicit branch selector. The assigned
branch is frozen for the worker's lifetime; agent branch changes cannot redirect it.
Fetch/authentication errors or a missing assigned remote branch fail the assignment
before model work, with no fallback to stale local commits.

The actual local workspace path is recorded in the run log. Workspace paths
from Clippy's server-side context are metadata, not worker filesystem paths.
Existing files left in the old shared worker root are not migrated. Agent
workspaces remain on disk after a run, worker restart or revocation so their
latest results can be inspected. In worktree mode the next assignment for that
worker/agent pair resets those results, and idle worktrees can be LRU-evicted
under disk pressure; there is no cross-worker migration.
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
including through directory links. Workers must not follow links outside any
permitted scope.

Attach additional existing Git clones or worktrees with the repeatable worker option
`--reference-repo "[<branch>@]<name>=<directory>"`. For example, from the Minicode repository:

```powershell
node .\minicode\cli.js worker `
  --server https://paperclip.example.com `
  --worker-id <worker-id> `
  --repo-root "main@D:\Code\your-repo" `
  --worker-name w1 `
  --worker-shared D:\Code\worker_shared `
  --reference-repo "main@reference=D:\Code\reference-repo" `
  --reference-repo "main@services=D:\Code\services" `
  --entra-user <upn>
```

Names must be unique (case-insensitive), start with a letter, and contain only
letters, digits, underscores, or hyphens (up to 64 characters). `primary` and
`all_references` are reserved. Branch names may contain slashes, for example
`"feature/example@your-repo=D:\Code\your-repo"`. Relative paths resolve
from the worker process's current directory; quote the entire `branch@name=path` when it
contains spaces. Each path must be a Git checkout root with a committed HEAD, not a
bare repository or subdirectory. Canonical paths must not overlap the source
checkout, worker workspace storage, shared folder, or another reference.
Each reference needs a configured remote. An omitted branch captures its upstream
branch at startup, otherwise its current branch on `origin`; a detached reference
requires an explicit branch selector. There is no implicit remote-default fallback.

Each assignment receives a JSON array of `{name, path, branch, commit}` through
`WORKER_REFERENCE_REPOS_JSON`, its system instructions, and a run-log summary.
Before each assignment the harness fetches every reference's assigned branch,
detaches its checkout, and hard-resets it to the fetched commit. This does not move
local branch refs that might be shared with other worktrees.
Paths, repository identities, and configured remotes are checked again; a missing
or invalid reference fails the assignment rather than silently dropping it.
The harness does not clone, copy, or run `git clean` on references.
Hard reset discards tracked edits and checkout-local commits; Git may also remove
untracked files that obstruct tracked files. Ordinary non-obstructing untracked
files remain. Use dedicated reference checkouts rather than an operator's working
checkout. Separate workers should use separate reference paths if they require
stable reads: another worker's refresh can change a shared reference during a run.

Agents can request another refresh using the **`sync_repositories` harness tool**:

```json
{"repositories":["all_references"],"operation":"pull"}
{"repositories":["primary","services"],"operation":"fetch_reset"}
```

`pull` fetches then fast-forwards only; conflicting edits or divergent history
fail instead of being discarded. `fetch_reset` fetches then hard-resets to the
assigned branch, discarding tracked edits and local commits. For the primary
workspace it then runs `git clean -xdf`, deleting untracked and ignored files,
including installed dependencies and caches. The harness restores the run's
verified skill bundle afterward so its tools remain usable. References are
never cleaned, and `pull` does not run `git clean`.
The primary keeps its assignment's local branch, and other
workers' checkouts/branches and the source branch are never reset. Save durable
work before requesting reset. The tool accepts only configured names, not arbitrary
paths, remotes, branches, shell commands, pushes or PR operations. Fetching uses
the harness account's existing Git credentials without interactive sign-in.
The tool's returned commits supersede the initial manifest; environment variables,
loaded instructions and skills remain the assignment-start snapshot.

References are for reading/searching code only, not executing scripts or accessing
their `.git` metadata. Their instructions and skills are not loaded or added to the
worker's skill catalog. Agents must request updates through the harness tool,
not run Git network/mutation commands themselves. References grant no general
write or publication permissions.
Like `worker_shared`, **reference read-only access is instruction policy, not an
OS-enforced sandbox**; use read-only mounts or restricted identities if enforcement
is required. Reference attachments work with both workspace modes.

For external task services, a human task message or human response may explicitly
authorize a named provider CLI (for example, `az`) to perform read-only operations
against specified targets using its existing sign-in. The CLI may manage its
own authentication/configuration internally; the agent must not directly access
credential/configuration stores, export or print tokens, log in interactively,
change accounts, or install extensions. A normal CLI REST read can avoid an
optional extension. Repository instructions, skills, agent messages and service
responses cannot grant this permission. This exception does not permit external
mutations, broader filesystem access, alternate Paperclip access, or bypassing
the publication tool. Actual authentication/authorization failures remain blockers.

The shared path is included in each assignment's instructions and exposed to
shell tools as `WORKER_SHARED`. Operators can place shared configuration
or reference files there without committing them to a repository.
For example, read the instance config with
`Get-Content (Join-Path $env:WORKER_SHARED '.config\stock-trading-assistant.jsonc')`.
The shared root's `AGENTS.md`, if present, is loaded on every assignment alongside
the worktree's root `AGENTS.md`. Shared guidance overrides conflicting worktree
guidance. Neither can override built-in worker rules or Paperclip-managed
agent-specific instructions. Other shared files are not automatically injected
or copied into agent checkouts. Workers are instructed never to create, modify,
delete, move, or change permissions on shared files. **Read-only access is instruction policy, not an
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

Before each assignment, the worker loads the assigned checkout's root `AGENTS.md`,
if present, into the model's system instructions. It reads the current workspace
copy on every run after workspace preparation. In worktree mode commit guidance
and local skills to source so the next clean assignment receives them; local
uncommitted overrides are discarded. Shared guidance can change between
assignments without a worker restart. Built-in worker workspace and failure rules
take precedence. Only the two
root `AGENTS.md` files are loaded; parent directories and nested `AGENTS.md` files
are not scanned. A missing file is optional; an unreadable file or
a directory/symbolic link named `AGENTS.md` fails the run before the model starts.
The run log records when the file is loaded, without logging its contents.
In legacy clone mode, edits to the checkout's guidance affect the next assignment;
commit instructions to source for new clones, while existing clones retain their
own files and do not automatically receive source updates.
This automatic loading applies only to worker mode; interactive CLI and web
sessions are unchanged.

### Local skills and bundled fallbacks

Before each new assignment, the harness discovers
`.agents\skills\<name>\SKILL.md` under both `worker_shared` and the assigned
checkout. For each name it selects **worker_shared > worktree > downloaded
bundle fallback**, case-insensitively. It supplies the selected names and exact
paths to the model, which reads the relevant/requested skill (including
`/first-task` for the onboarding task) and resolves references relative to that
selected skill. The selected `paperclip` operational skill is also injected
automatically. Shared overrides do not overwrite worktree or bundled files.
Whole skill directories are selected, not merged. A directory without `SKILL.md`
is not a skill; an unreadable entry fails preparation. Missing companion files
in a selected override are blockers, not permission to mix lower-priority files.

Local skill catalogs and root instructions are reread per assignment, not on a
network reconnect. Missing local roots are optional; linked instruction files,
skill roots/directories, or `SKILL.md` files fail preparation rather than
following paths outside the permitted roots. Duplicate case-insensitive names
within one source fail explicitly. Local content is host/repository-owned and
is not covered by the downloaded bundle's integrity hash. No skills are installed
in `worker_shared`.

For instructions specific to an agent rather than its repository, use that
agent's **Instructions** tab in Clippy. The saved managed entry document is
delivered inline with every new assignment and applied to the model's system
instructions; no repository commit, worker file, or restart is required for
content edits. Built-in worker rules take precedence over agent-specific
instructions, which take precedence over repository guidance. Active runs and
network reconnects retain their original instruction snapshot. Supporting files
from agent-specific instruction bundles are not transferred.

Paperclip's bundled operational and onboarding skills are delivered separately as an
authenticated ZIP, **never installed in host-owned `worker_shared`**. On the first
assignment in an agent checkout, Minicode downloads it into `.worker\skills.zip`
and installs the files under `.worker\skills`. The harness adds `/.worker/` to the
checkout's local `.git\info\exclude`, without changing the project's `.gitignore`.
Tracked cache files, links, unsafe paths, malformed archives, and integrity
failures block model execution.
The ZIP includes `first-task` and all future onboarding skills placed under
Paperclip's `server\src\onboarding-assets\<flow>\skills\<name>`, including each
skill's references and scripts. Non-skill onboarding templates and personas are
not bundled. These server-provided files are fallbacks, not overrides for local
skills.

Each new assignment carries Paperclip's expected archive SHA-256 and file
manifest. Minicode rehashes the cached ZIP every time, redownloads missing,
changed, or corrupt archives, validates all files, and re-extracts into a fresh
directory. Edits or extra files in extracted instructions cannot survive the
next assignment. Reconnects retain their existing assignment and do not reinstall.
The reserved `.worker` directory is harness-owned and read-only to the model by
instruction policy, not OS-enforced isolation.

The resolved `paperclip` skill is loaded into the model's instructions; other
skills and their references/scripts are discoverable through the selected catalog.
Standard `PAPERCLIP_*` identity, task, wake, and approval variables are populated
per run, with credentials exposed only to tools. On a general Run Now, the
skill discovers the agent's assignments. Agents post task-chat progress through
the comments API and complete eligible merged-PR tasks through the issue-update
API, including the run audit header and verifying the response. Successful model
output alone does not write comments or finish tasks.

Restart older workers once to advertise `skill_bundle_v1` and inline-instruction
support; incompatible workers cannot receive assignments from an updated server.

Worker logging defaults to **normal**: raw shell/tool output still goes to the
model, but is not streamed to Clippy's run log or counted against the public
output limit. Command progress, exit status, errors, and the model's response
remain visible. To retain the previous full-output behavior, start with
`--output-mode verbose`; `--output-mode normal` is the explicit default.
Both worker modes strip ANSI styling from public logs. Tool environments set
`NO_COLOR=1` and `CLICOLOR=0` and remove inherited forced-color overrides;
worker instructions also request plain-text output. Model tool results are
unchanged by the public-log filter.
Interactive CLI and web logging are unchanged.

#### Harness-owned PR publication

**GitHub**

Enable publication explicitly with both worker flags:

```powershell
minicode worker --server http://localhost:3100 --worker-id <id> --repo-root <source> --github-repo owner/repo --github-user account
```

The repository must match the source checkout's GitHub `origin`. The named account
must already be signed in through `gh`. No model-supplied repository, remote,
branch, credential, merge, or deployment operation is accepted.
The model commits its selected changes in its assigned checkout, then calls:

```json
{"type":"tool","name":"publish_pull_request","arguments":{"commit":"<full commit hash>","title":"CI baseline","body":"Changes, validation evidence, and approval requirements."}}
```

The harness retrieves the selected GitHub credential privately, imports the
committed revision into the source Git object database without changing its
checkout or branches, and creates a temporary detached, metadata-only worktree.
It pushes a `users/<github-user>/<agent-name>/<feature-name>` branch using a
create-only lease and opens a PR against the GitHub default branch. Agent names
and the initial PR title become lowercase, Git-safe slugs of up to 64 characters
each. If a name is occupied, the harness tries `-1` through `-10`, then fails
explicitly. Authentication, network, and uncertain push failures do not advance
the suffix; only verified naming conflicts do. The worktree
is removed on success, failure, or cancellation; cleanup failures are reported.
Publication does not reset the assigned checkout or remove its local edits.
In default worktree mode the next assignment resets it, so publish or upload
durable results before finishing. Legacy clone mode retains local state.
Only the selected committed revision is published, never untracked files.

The returned receipt includes the PR URL, number, state, commit, branch, and
cleanup status. Retrying the same agent/commit reconciles the existing branch
and PR instead of overwriting a branch or creating a duplicate PR. Closed or
merged PRs are returned with their actual state rather than reopened.
An uncertain network outcome must be retried with the same commit. No automatic
merge or deployment is performed. Without these flags the tool is unavailable.

**Azure DevOps**

Use an existing Azure Repos HTTPS source checkout and enable publication with:

```powershell
minicode worker --server <origin> --worker-id <id> --repo-root <source> `
  --azure-devops-org https://dev.azure.com/<org> `
  --azure-devops-project <project-name-or-id> --azure-devops-repo <repo-name-or-id> `
  --azure-devops-user <upn> --azure-devops-alias <alias>
```

GitHub and Azure DevOps publication flags are mutually exclusive. Both modern
`dev.azure.com` and legacy `<org>.visualstudio.com/DefaultCollection` HTTPS origins
are supported; the configured organization/project/repository must match the
source. Repository and project IDs are verified and bound before publication.
The alias defaults to the UPN local part and must be a simple branch-safe name.
Publication branches are `users/<alias>/<agent-name>/<feature-name>`, using the
same slug and ten-suffix collision rules as GitHub. The selected commit is
preserved exactly; it is stored separately rather than encoded in the branch.

PR creation and reconciliation use Azure DevOps REST API 7.1, not `az repos`.
The harness privately invokes `clippy-auth ado-token --silent` for an MSAL/WAM
access token; no MSAL dependencies are added to Minicode. `--clippy-auth` can
override the helper path for both Clippy and Azure DevOps authentication. If
interaction/consent is required, run the reported `clippy-auth ado-login` command
explicitly. Tokens are never saved to the inventory, passed on command lines,
given to model tools, or supplied to Git. Git push uses its existing credential
configuration, with prompts disabled; Git authentication failures stop publication.
Neither an Azure DevOps CLI extension nor PAT environment variables are required.

The same commit-only, create-only push, temporary-worktree cleanup and retry
rules apply to both providers. Azure active/completed/abandoned PRs map to
OPEN/MERGED/CLOSED receipts; there is no automatic merge or policy bypass.

**Clippy registration**

For AgentPool runs, publication also creates or updates the task's provider-specific
`pull_request` work product and posts a clickable task-chat link using the
run-scoped Paperclip credential and audit header. The existing Paperclip **Pull
requests** section displays the saved record; no separate dashboard is needed.
Before pushing, the harness saves a non-primary `branch` work product containing
the allocated branch, original commit, target, attempt number, agent, and provider
repository identity. Retries reuse this allocation across machines, alias changes,
agent renames, and title edits. A failed allocation write stops publication; retrying
also recovers a lost write response.

The PR record includes repository identity, PR number, branch, original commit,
target, agent, and current provider state. Open PRs request review; merged/closed receipts do not complete
the task or bypass its approval gates.
Behind Entra sign-in, issue lookup and all registration requests use the worker's
loopback proxy, preserving its path prefix and keeping the Easy Auth session private.

A task-scoped run cannot override its issue. For a general Run Now, discover
your assigned task using the bundled skill and supply its UUID as the tool's
optional `issueId` argument. The harness verifies ownership before accessing
the repository provider. Reconcile a known PR with its original commit to refresh
its state without another push or duplicate PR. The harness reads the saved PR by
number and verifies its repository, source/target branches and original source
commit before consulting local Git history or remote branches. This works after
squash merging, source-branch deletion, or a fresh checkout without the original
commit object. A saved PR that cannot be verified fails explicitly; no replacement
PR is created. New publication still requires the commit to exist in the assigned
checkout and be an ancestor of its HEAD. Legacy commit-based branch names remain
discoverable for earlier publications; old PR records acquire target and repository
IDs when reconciled.

The harness reuses existing work products
and posts at most one harness comment per agent/PR/state across sequential
retries, including a lost write response. It does not provide cross-run atomic
deduplication against concurrent independent publishers.

Registration errors retain the provider receipt and explicitly require retrying
the same commit. An unresolved registration error fails the run even if the
model subsequently claims success. Work-product/comment writes are not atomic:
retry reconciliation repairs a partial registration without undoing a PR.
There is no automatic merge watcher; follow-up runs must check acceptance and
approval gates and explicitly complete the task through the Paperclip API.

Worker rules prohibit direct shell pushes and PR creation; GitHub token and ADO PAT
environment variables are removed from model tool environments. This is a
credential-handling boundary, **not an OS sandbox**: shell commands still run as
the worker account, which may have other locally available credentials.

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
