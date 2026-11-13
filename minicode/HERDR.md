# Run Minicode in Herdr on Windows

Herdr is a persistent terminal workspace manager. Use it to keep a Minicode
frontend, coordinator, and AgentPool workers visible in one workspace while
letting the coordinator submit prompts to the frontend.

Canonical Herdr documentation is at <https://herdr.dev/tui/docs/>. The commands
below target Windows PowerShell and Herdr's stable channel.

## Prerequisites

Install these for the Windows user that will run the processes:

- PowerShell 7, Git, and Node.js
- GitHub Copilot CLI, signed in, when using the `copilotcli` harness
- Azure CLI, signed in to the intended account, when the coordinator or Clippy
  connection uses Entra authentication
- A Minicode checkout with dependencies restored by running `npm install` in
  its `minicode` directory
- An existing AgentPool worker ID and one-time pairing token for each new worker

Keep pairing tokens and credentials out of repository files, command arguments,
logs, `workers.yml`, and shell history.

## Install and start Herdr

Install Herdr from PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://herdr.dev/install.ps1 | iex"
herdr --version
```

If endpoint security blocks the fileless installer, follow the alternatives at
<https://herdr.dev/tui/docs/install/>. Direct installs use the stable channel and
update with `herdr update`.

Start Herdr from the workspace root:

```powershell
Set-Location D:\Code\odin
herdr
```

The first invocation starts the background server, creates or selects a
workspace, and attaches the client. Closing or detaching the client leaves pane
processes running. Run `herdr` later to reattach. Do not run `herdr` inside an
existing Herdr pane (`HERDR_ENV=1`); nested clients are blocked.

Install lifecycle reporting for the interactive frontend and verify it:

```powershell
herdr integration install copilot
herdr integration status
```

Use the integration matching another frontend if needed. Install only the
integration for an agent actually used on the machine.

## Recommended pane layout

Use one pane for each independently visible process:

| Pane | Process | Purpose |
| --- | --- | --- |
| Frontend | `copilot` | Interactive agent that receives operator or coordinator prompts |
| Worker 1 | direct `minicode worker` command | First AgentPool worker and coordinator-election participant |
| Worker 2 | direct `minicode worker` command | Additional AgentPool worker |
| Optional logs | diagnostic commands | Logs and runtime inspection |

Create panes with the right-click menu. Herdr is mouse-first: click to focus,
drag borders to resize, and right-click panes for split and rename actions. The
default keyboard prefix is `Ctrl+B`; `prefix+v` splits right, `prefix+-` splits
down, `prefix+c` creates a tab, and `prefix+q` detaches.

Start Copilot CLI in the frontend pane from the workspace root:

```powershell
Set-Location D:\Code\odin
copilot
```

Herdr injects `HERDR_ENV`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, and
`HERDR_PANE_ID` into pane processes. Do not set or copy these variables manually.
They bind status and automation to the pane that launched the process.

## Start direct workers with independent status

A direct worker launched in its own Herdr pane can report its display name,
`idle`/`busy` lifecycle, and current tool activity to that pane. Use a distinct
worker identity and pane for each process.

For a worker's first pairing, set the one-time token only in that pane's process
environment, launch the worker, then remove the variable. Tokens are single-use.
The following is a template; substitute the deployment, worker, account, and
workspace values:

```powershell
Set-Location D:\Code\odin
$env:MINICODE_AGENT_POOL_PAIRING_TOKEN = Read-Host -MaskInput 'One-time pairing token'
try {
  node .\minicode\minicode\cli.js worker `
    --server https://clippy.example.test `
    --worker-id <worker-id> `
    --repo-root D:\Code\odin `
    --workspace-mode workspace `
    --worker-name devbox-worker-01 `
    --harness copilotcli `
    --model gpt-5.6-sol `
    --entra-user operator@example.test `
    --clippy-auth D:\Code\odin\minicode\clippy-auth\cli.js
} finally {
  Remove-Item Env:MINICODE_AGENT_POOL_PAIRING_TOKEN -ErrorAction SilentlyContinue
}
```

On later starts, omit the token; Minicode reuses its private local pairing
credential. Use `--copilot-path <absolute-copilot.exe>` only when the native
executable is not discoverable on `PATH`. Do not pass an npm `.cmd` wrapper.

To let this machine participate in the coordinator election, add these options
to at least one direct worker command:

```text
--coordinator-server <engsys-url>
--coordinator-alias devbox
--coordinator-harness copilotcli
--coordinator-azure-config-dir C:\Users\me\.azure
```

All Minicode processes configured for the same EngSys endpoint elect one local
coordinator owner; the others remain standby. Use one stable, unique alias for
the machine. The selected Azure CLI directory must already be signed in. A
coordinator is local operational authority, not permission to push, deploy, or
perform other remote mutations unless an engineer explicitly requests that
exact action.

### Bundled alternative

For simpler lifecycle management, create workspace-root `workers.yml` and run:

```powershell
Set-Location D:\Code\odin
node .\minicode\minicode\cli.js web
```

This starts the web portal, configured workers, and one elected coordinator,
and stops the children when the parent exits. See [Web workers](README.md#web-workers)
for the schema. Put only the *name* of an environment variable in
`pairingTokenEnv`, never the token itself.

Bundled workers share the launcher's pane, so Minicode intentionally disables
per-child Herdr reporting in this mode. Use direct worker commands in separate
panes when independent worker status is the goal. Do not run both layouts for
the same worker IDs.

## Prompt the frontend from the coordinator

List agents and identify the frontend pane:

```powershell
herdr agent list
```

Submit a prompt by pane ID:

```powershell
herdr agent prompt w1:p1 'Inspect the current task and report findings.'
```

To wait for completion:

```powershell
herdr agent prompt w1:p1 'Run the requested check.' --wait --timeout 300000
```

Pane IDs are runtime values; discover them instead of hard-coding IDs in startup
files. Herdr rejects a prompt when the target is blocked. A prompt timeout does
not imply that the underlying agent process was terminated.

## Verify the runtime

Run these from any pane without exposing credentials:

```powershell
herdr status server
herdr status client
herdr pane current
herdr pane list
herdr agent list
herdr integration status
```

Expected results:

- server and client versions are protocol-compatible;
- each direct worker has a different `HERDR_PANE_ID`;
- the frontend appears as an agent and transitions through lifecycle states;
- direct Minicode worker panes show the configured worker name and idle/busy
  activity on Minicode versions that include Herdr worker reporting;
- exactly one local process owns the coordinator connection.

## Operations and troubleshooting

- **Agent missing or wrong state:** run `herdr agent explain <pane-id> --json`,
  then check `herdr integration status`. Reinstall an outdated integration with
  `herdr integration install <agent>`.
- **Worker has no Minicode status:** confirm it was launched directly inside its
  own pane, `HERDR_ENV=1`, `HERDR_PANE_ID` is present, and
  `MINICODE_WORKERS_MODE` is not `1`. Restart an idle worker after updating
  Minicode; never interrupt an active assignment just to refresh visuals.
- **Coordinator is absent:** verify the EngSys URL, alias, Azure CLI account, and
  that at least one configured Minicode process is running. Multiple processes
  are expected to elect one owner rather than create duplicate coordinators.
- **Processes vanished after closing a window:** check `herdr status server` and
  reattach with `herdr`. Pane processes survive client detach, not an explicit
  `herdr server stop`, machine restart, or process exit.
- **Inspect logs:** Herdr's Windows config and logs are under
  `%APPDATA%\herdr`; the active paths are also printed by `herdr --help`.
- **Apply config changes:** edit `%APPDATA%\herdr\config.toml`, then run
  `herdr server reload-config`. Herdr works without a custom config.
- **Update safely:** wait for workers and the coordinator to be idle before
  changing or restarting their runtime. `herdr update` updates direct Herdr
  installs; package-manager installations use their package manager.

Stop the entire Herdr session only when intentionally terminating every managed
pane process:

```powershell
herdr server stop
```
