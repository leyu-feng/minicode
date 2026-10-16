# Clippy differences from Paperclip

Clippy is this repository's fork of
[Paperclip](https://github.com/paperclipai/paperclip), integrated with Minicode.
It retains Paperclip's control plane, UI, adapters, and package names. The
upstream [README](README.md) and [documentation](doc/) still describe those
shared features. This file records the fork-specific additions and deployment
choices, rather than duplicating the upstream documentation.

## AgentPool and Minicode workers

Clippy adds the `agent_pool` adapter alongside the existing adapters. A company
can pair Minicode workers, organize them into named pools, and assign an agent
to a pool. Workers connect outbound over HTTPS/WebSocket, so the Clippy server
does not need inbound access to the worker machine.

Each agent gets a persistent, independent Git clone on its assigned worker.
The initial clone contains committed source only; uncommitted changes,
untracked files, installed dependencies, and initialized submodules are not
copied. Later runs retain that agent's changes without resetting or pulling.
Workspaces are not synchronized back to the server or between workers.

Workers execute with their local account's privileges; they are not sandboxes.
Live executions can reconnect briefly after a network interruption, but process
restart recovery and horizontal broker failover are not supported. Worker
model usage/cost is not reported to Paperclip. Keep a deployed Clippy instance
single-replica while workers and dispatch depend on that process.

See [worker setup and limitations](../minicode/README.md#connect-as-an-agentpool-worker)
for pairing, authentication, workspace locations, and reconnect behavior.

## Azure PostgreSQL with Microsoft Entra authentication

Unlike the original password-only connection path, Clippy automatically uses
Entra tokens when a PostgreSQL URL has no password and its hostname ends in
`.postgres.database.azure.com`. No additional opt-in is required. Local,
embedded, and explicit-password connections retain their existing behavior.

Configure the connection and identity through Azure Container App **runtime
environment variables**, not source files or Docker build arguments:

```text
DATABASE_URL=postgres://app-identity@my-server.postgres.database.azure.com:5432/paperclip?sslmode=verify-full
AZURE_CLIENT_ID=<user-assigned-managed-identity-client-id>
```

Attach the managed identity to the container app and provision its PostgreSQL
role with the permissions needed for application queries and migrations.
`DATABASE_MIGRATION_URL` can specify a separate migration connection.
The passwordless URL and identity client ID are configuration, not credentials.
Actual application secrets should use the container service's secret references.

The shared database helper uses `DefaultAzureCredential`, explicitly selects
the user-assigned identity through `AZURE_CLIENT_ID`, and also supports a
developer's `az login`. A shared credential instance caches tokens; each new
database connection obtains its password through a token callback. Token
expiration does not require a refresh timer or closing established connections.

The behavior covers the main pool, startup/migration utilities, and all
JavaScript backup/restore connections. `pg_dump` and `psql` receive tokens only
through their child-process `PGPASSWORD`, never in connection URLs or command
arguments. Azure token connections enforce certificate-verified TLS, including
when the supplied URL only requests `sslmode=require`.

See [database configuration](doc/DATABASE.md#azure-postgresql-with-microsoft-entra-authentication)
for certificate trust and PostgreSQL CLI version requirements.

## Local image publishing and image hygiene

The repository-level [publish-clippy.ps1](../publish-clippy.ps1) builds the
Linux `amd64` production image locally and uploads it to an existing Azure
Container Registry. Each publication pushes a versioned rollback tag and
`latest`, verifies that both resolve to the same digest, and prints both tags
plus the immutable deployment reference.

Publishing does not provision Azure resources, deploy the image, or restart
running replicas. Reprovision the instance or deploy the printed digest to
adopt a new image; changing `latest` alone does not replace running containers.

The publisher exports committed Clippy source rather than copying the devbox
checkout. Local environment files, Git metadata, and installed dependencies do
not enter the build context. npm configuration is mounted as a temporary
BuildKit secret. npm logs/cache remain in cache mounts, and package metadata
and native build configuration snapshots are sanitized to keep internal feed
locations and build-environment metadata out of published image layers.
The committed lockfile also omits registry-specific tarball URLs. Dependency
updates must preserve package versions and integrity hashes without checking
internal feed locations into source.

The publisher excludes Pi and Cursor from the image's bundled remote provider
pack. Their adapters and UI options remain available; this is an image-packaging
choice, not removal of those providers from Clippy.

See [build and publish instructions](../README.md#build-and-publish-clippy-to-azure-container-registry)
for the command, source-cleanliness requirements, and runtime configuration.

## Windows launch and runtime layout

The repository adds `clippy.ps1` and `bootstrap\clippy.cmd` for Windows launch,
using the project's pinned pnpm version, and includes Windows workspace-build
compatibility changes.

For the container deployment, persist `PAPERCLIP_HOME=/paperclip`, route traffic
to port `3100`, and set `PAPERCLIP_PUBLIC_URL` to the instance's HTTPS URL.
Keep stable `BETTER_AUTH_SECRET` and `PAPERCLIP_TOOL_ACTION_SIGNING_SECRET`
values in runtime secret configuration. The image defaults to
authenticated/private mode. These existing Paperclip runtime conventions are
preserved, not new Clippy-only environment variable names.

Minicode's pure-Node goal does not mean the full Clippy distribution has no
native components: the Paperclip-based image retains its existing native
dependencies and agent toolchains.
