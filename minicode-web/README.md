# minicode-web

The minicode agent core, plus two front ends:

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

Sign in once with GitHub Copilot:

```powershell
.\minicode.ps1 auth login
.\minicode.ps1 auth list
.\minicode.ps1 auth logout
```

REPL commands: `exit`/`quit`/`:q` to leave, `/clear` to reset the conversation,
`/cwd` for the working directory, `/model` for the active model. `Ctrl+C`
cancels the current turn; `Ctrl+C` at an empty prompt exits. **Conversation
history persists across prompts**, so follow-ups like "now add a flag to it"
work.

This runs entirely in your terminal — no server is started and no browser is
opened.

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

Terminal keys: `Enter` submits, `Backspace` edits, `Up`/`Down` walk history,
`Ctrl+C` clears the line (and cancels an in-flight agent turn). Typing `exit`
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
| `OPENCODE_API_KEY` / `OPENCODE_BASE_URL` / `OPENCODE_MODEL` | Model overrides; otherwise the saved GitHub Copilot credential in `auth.json` is used. |

## Limitation

There is no PTY, so sessions are line based. Full-screen/curses applications
(`vim`, `htop`, `git` pagers) will not render — use non-interactive flags such
as `git --no-pager`.

## Legacy entry point

Superseded, kept only as an escape hatch:

| Command | What it runs |
| --- | --- |
| `.\minicode.ps1 raw ...` | The original opencode Node fallback agent, which has no conversation memory. |
