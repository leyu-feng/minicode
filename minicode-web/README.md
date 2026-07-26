# minicode-web

A local web portal that gives minicode a multi-pane terminal experience in the
browser, with no native modules (no `node-pty`, no platform binaries).

A background Node.js process serves the page, owns every session, and proxies
stdin/stdout/stderr over a WebSocket.

## Run

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
`Ctrl+C` clears the line (and cancels an in-flight agent turn).

Function keys and browser shortcuts are deliberately **not** captured by the
terminal, so `F11` (fullscreen), `F12` (devtools), `Ctrl+Shift+I`, `Ctrl+R`,
zoom and tab shortcuts keep working normally in Edge/Chrome.

## Environment

| Variable | Purpose |
| --- | --- |
| `MINICODE_REPO_ROOT` | Working directory for all sessions (defaults to `process.cwd()`). |
| `MINICODE_WEB_PORT` | Listen port (`0`/unset picks a free port). |
| `MINICODE_WEB_OPEN` | Set to `0` to skip launching the browser. |
| `OPENCODE_API_KEY` / `OPENCODE_BASE_URL` / `OPENCODE_MODEL` | Model overrides; otherwise the saved GitHub Copilot credential in `auth.json` is used. |

## Limitation

There is no PTY, so sessions are line based. Full-screen/curses applications
(`vim`, `htop`, `git` pagers) will not render — use non-interactive flags such
as `git --no-pager`.
