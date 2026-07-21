# minicode

Pure Node.js coding TUI using Ink + child_process (no native addons).

## Run

```powershell
cd C:\Code\WeWork\minicode
npm start
```

Or from repo root:

```powershell
.\minicode.ps1 tui
```

## Controls

- Type prompt and press `Enter`
- Type `exit` or `/exit` to quit
- `Ctrl+C` to quit

## Auth

It uses:

1. `OPENCODE_API_KEY` / `OPENAI_API_KEY` if already set, else
2. Saved GitHub Copilot OAuth from `auth.json` (from `.\minicode.ps1 auth login --provider github-copilot`)
