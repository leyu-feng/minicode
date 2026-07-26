# minicode

We want to create a coding agent that uses Node.js only, and not any native components.

## Goals

- **Pure Node.js** — the entire agent runs on Node.js with no native addons or bindings.
- **No native components** — no C/C++ add-ons, no platform-specific binaries, no compiled dependencies.
- **Portable** — runs anywhere Node.js runs, with zero build steps for native modules.

## Why

Avoiding native components keeps the agent easy to install, simple to distribute, and consistent across platforms.
