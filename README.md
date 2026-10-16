# minicode

We want to create a coding agent that uses Node.js only, and not any native components.

## Goals

- **Pure Node.js** — the entire agent runs on Node.js with no native addons or bindings.
- **No native components** — no C/C++ add-ons, no platform-specific binaries, no compiled dependencies.
- **Portable** — runs anywhere Node.js runs, with zero build steps for native modules.

## Why

Avoiding native components keeps the agent easy to install, simple to distribute, and consistent across platforms.

## Run Clippy on Windows

Run `.\clippy.ps1` or `bootstrap\clippy.cmd`. The launcher uses the pnpm version
pinned in `clippy\package.json`. npm resolves or fetches that version using the
configured registry and authentication; Node then runs pnpm directly, without a
long-lived `npm.cmd` wrapper around the server.

## Worker test repository

The `clippy-worker` submodule provides a source repository for worker tests.
Initialize it with `git submodule update --init clippy-worker`, then pass its
full path explicitly as `--repo-root` to the worker CLI or CMD launcher.
Command-line entry points retain their current-directory behavior; the
submodule is not selected automatically. See
[worker setup and isolated workspaces](minicode/README.md#connect-as-an-agentpool-worker).
