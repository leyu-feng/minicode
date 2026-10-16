# minicode

We want to create a coding agent that uses Node.js only, and not any native components.

## Goals

- **Pure Node.js** — the entire agent runs on Node.js with no native addons or bindings.
- **No native components** — no C/C++ add-ons, no platform-specific binaries, no compiled dependencies.
- **Portable** — runs anywhere Node.js runs, with zero build steps for native modules.

## Why

Avoiding native components keeps the agent easy to install, simple to distribute, and consistent across platforms.

## Run Clippy on Windows

See [Clippy differences from Paperclip](clippy/CLIPPY.md) for the fork's
AgentPool integration, Azure authentication, and image-publishing choices.

Run `.\clippy.ps1` or `bootstrap\clippy.cmd`. The launcher uses the pnpm version
pinned in `clippy\package.json`. npm resolves or fetches that version using the
configured registry and authentication; Node then runs pnpm directly, without a
long-lived `npm.cmd` wrapper around the server.

## Build and publish Clippy to Azure Container Registry

Install Docker Desktop with its Linux engine running, Git (including `tar`),
and Azure CLI. Sign in with `az login`; your account needs push access to the
existing registry. From this repository:

```powershell
.\publish-clippy.ps1 -RegistryName myregistry -Subscription my-subscription
# Build without signing in to Azure or uploading:
.\publish-clippy.ps1 -BuildOnly
```

The script builds locally for `linux/amd64` using `clippy\Dockerfile`'s
`production` target, logs Docker in through Azure CLI, pushes both the versioned
image and `latest`, and prints both tags plus their immutable registry digest.
`-ImageName` defaults to `clippy`; `-Tag` defaults to a timestamp plus source
commit. Passing `-Tag latest` still retains that timestamped rollback tag.
Publishing does not restart running containers; reprovision them or deploy the
printed digest to pick up the new image. `-Subscription` is
optional and does not change Azure CLI's default subscription.

Only committed files under `clippy` enter the build context. Commit application
changes before running; modified or untracked files there cause an error.
The Dockerfile itself is taken from the current checkout, so recipe changes
can be tested before committing. The script uses npm's user npmrc by default
(`npm config get userconfig`); use `-NpmConfigPath C:\path\to\.npmrc` to select
another file. The internal mirror does not require a separate authentication step.
BuildKit mounts it as a secret only while installing packages, including the
project-pinned pnpm bootstrap. Its registry/auth configuration is never copied
into an image layer or passed as a build argument. npm logs/cache stay in
BuildKit cache mounts, and generated pnpm metadata has mirror locations removed
before it enters the runtime image. Package versions and integrity hashes are
retained. Native build configuration snapshots are removed; compiled addons
remain available. Local environment files,
Git metadata and installed dependencies are not copied from the devbox.
The first build includes the existing image's
native runner and agent CLI toolchains and can take substantial time and disk
space. The published image excludes Pi and Cursor from the bundled remote
provider pack; other bundled providers remain included. This does not remove
Clippy's Pi/Cursor adapter code or UI options. This script does not provision
Azure resources or deploy the image.

For your Azure container service, configure these **at runtime**, not as build
arguments:

- Set `DATABASE_URL` to the external PostgreSQL connection string, with TLS
  configured for your database. Do not leave it unset: that selects embedded
  PostgreSQL. Use `DATABASE_MIGRATION_URL` if migrations need a separate connection.
  Passwordless Azure PostgreSQL URLs automatically use Microsoft Entra tokens
  and certificate-verified TLS. For a user-assigned managed identity, set
  `AZURE_CLIENT_ID` to its client ID and attach the identity to the container app.
  See [Azure PostgreSQL authentication](clippy/doc/DATABASE.md#azure-postgresql-with-microsoft-entra-authentication).
- Mount the Azure file share at `/paperclip` (`PAPERCLIP_HOME`). It persists
  uploaded files, local secret encryption keys, configuration and logs. Ensure
  the runtime user (UID/GID `1000` by default) can write to it; SMB mounts may
  require mount-side ownership options rather than Unix `chown`.
- Route traffic to port `3100`; set `PAPERCLIP_PUBLIC_URL` to the external HTTPS
  URL. Supply stable `BETTER_AUTH_SECRET` and
  `PAPERCLIP_TOOL_ACTION_SIGNING_SECRET` through your Azure service's secret
  configuration. The image defaults to authenticated/private mode.

Keep the instance single-replica unless its orchestration is made
multi-replica-safe. AgentPool workers run separately and connect to the deployed
server over HTTPS/WebSocket. See [Docker configuration](clippy/doc/DOCKER.md)
for the existing image's runtime options and bootstrap behavior.

## Worker test repository

The `clippy-worker` submodule provides a source repository for worker tests.
Initialize it with `git submodule update --init clippy-worker`, then pass its
full path explicitly as `--repo-root` to the worker CLI or CMD launcher.
Command-line entry points retain their current-directory behavior; the
submodule is not selected automatically. See
[worker setup and isolated workspaces](minicode/README.md#connect-as-an-agentpool-worker).
