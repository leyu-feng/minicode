# AgentPool worker protocol

AgentPool is a harness-neutral, authenticated JSON WebSocket protocol. Workers
may use Minicode or another agent implementation. Pairing binds a worker to one
company and named pool; the control plane chooses an idle compatible worker.
Workers do not need access to the control plane's filesystem or Git checkout.
Workers in a pool must be interchangeable across all agents assigned to it;
different worker setups belong in different pools, not per-agent worker pins.

Minicode's default worktree mode isolates each worker/agent pair in a short
sibling checkout, for example `w1a1`, `w1a2`, and `w2a1`. Agent slots are
worker-local and stable across restarts. Before every new assignment it detaches
and hard-resets that pair's worktree to the source checkout's current committed
`HEAD`, then removes untracked/ignored files. It preserves source and host-owned
shared files; a network reconnect never resets the active execution.
Workspace preparation failures stop the run before model work.
Minicode monitors free space every 60 seconds and during assignment preparation.
Below 24 GiB it evicts only that worker's idle, validated owned worktrees in
persisted LRU order toward 36 GiB. Active assignments, other workers, source Git
storage, host-owned shared files, legacy clones and unmanaged folders are
protected. Slot mappings remain after eviction. Insufficient space or failed
measurement/cleanup stops new model work explicitly; publish/upload durable
results before completion because idle checkout files are disposable.
Legacy `--workspace-mode clone` retains persistent independent per-agent clones.

The canonical TypeScript schemas and types are exported from
`@paperclipai/shared/agent-pools`. Non-TypeScript workers implement the same JSON
contract. Do not depend on Minicode's internal session or prompt representation.

Workers send WebSocket pings every 15 seconds and accept either pings or pongs as
liveness, closing after 45 seconds without either. Client-initiated probes keep
proxy hops alive even when server-initiated control frames are not forwarded.

## Devbox and Hosted pools

Every newly created company has a `default` Hosted pool. All additional pools
are Devbox (`devbox`) pools for operator-paired Minicode workers. Pool types
cannot be changed through the API or UI, and additional Hosted providers cannot
be configured. Only non-default Devbox pools support manual pairing.
Legacy stored `freelance` values are presented as `devbox` without rewriting
records. Existing default pools are left untouched for manual conversion; no
automatic conversion or data migration runs.

The default pool uses the built-in agent host, an external service connected
only through deployment environment variables and authenticated exclusively
with Clippy's managed identity. Configure
`PAPERCLIP_HOSTED_WORKER_URL` (HTTPS, ending in `/v1/hosted-worker`) and
`PAPERCLIP_HOSTED_WORKER_AUDIENCE`. `AZURE_CLIENT_ID` selects a user-assigned
managed identity. Missing settings leave a new default Hosted and unprovisioned;
status and execution report a visible configuration error rather than falling
back to Devbox or user credentials. Stored per-pool URL/audience values do not
override the deployment connection.

Settings / Agent Pools, immediately after Members, shows observed Hosted capacity and available repositories,
not editable types, provider URLs, audiences or manual backlog controls. The
external host's `poolId` is persisted separately from the local pool ID and
reused for subsequent calls. Failed provisioning stays visible and is retried
on the next status/repository request. Company deletion deletes provisioned
host pools; a newly created default with no host configuration or registration
does not block company deletion. Previously configured pending pools still
require the deployment connection so cleanup cannot silently abandon them.

The worker inventory defaults to active workers: paired, non-revoked workers
with an idle or busy connection. Its filter can show disconnected workers
(including reconnecting and awaiting-pairing workers), revoked workers, or all
workers. Filtering changes only the view, not registrations or credentials.
The portal's Revoke action and company-scoped worker DELETE endpoint apply only
to Devbox workers. Hosted registrations are managed by the built-in host through
its authenticated provider lifecycle, not manually revoked from company settings.
Demand and deletion requests allow up to 90 seconds for provider reconciliation;
reads and pool registration retain a 10-second limit. Caller cancellation still
applies to every request.
Provider retirement callbacks do not wait for the pool's provisioning lock.

The managed-identity-authenticated provider contract is:

| Method | Path | Body / response |
| --- | --- | --- |
| POST | `/v1/hosted-worker` | `{ "companyId": "<uuid>", "name": "default" }`; 201 with `poolId`, `companyId`, `name` |
| GET | `/v1/hosted-worker/{poolId}` | 200 with persisted pool and observed counts |
| POST | `/v1/hosted-worker/{poolId}` | `{ "itemsWaiting": 4 }`; 202 |
| DELETE | `/v1/hosted-worker/{poolId}` | 204, idempotent |
| GET | `/v1/hosted-worker/{poolId}/status` | `{ "activeWorkers": 1, "provisioningWorkers": 0, "isMock": false }` |
| GET | `/v1/hosted-worker/{poolId}/repos` | Repository array: `id`, `name`, `branch`, `isDefault` |

The AgentPool provider owns worker state and storage. Create is idempotent for
the caller identity, company and pool name. Active counts require recent worker
heartbeats; provisioning counts require actual unexpired reservations. Demand
replaces the backlog snapshot; repeated demand is not additive. The provider
enforces its configured caller identity grants; pool IDs cannot cross callers.
Storage technology, capacity targets, execution lifetimes, reconciliation
schedules and repository catalog sources are provider implementation details.

Legacy v1 catalogs require unique repository IDs and exactly one default. Every repository
can be primary. Hosted agent configuration saves `primaryRepositoryId` and
distinct `referenceRepositoryIds`; omitting primary chooses the provider default.
Assignments include optional `repositories: { primary, references }`, containing
the selected repositories' `id`, `name` and `branch`. Only workers advertising
`hosted_repositories_v1` may receive these assignments. References are read-only
code context, not operational instruction authority.

Hosted runs request capacity using the current waiting-run count and wait at
most two minutes for an actual idle, compatible worker connection. Admission,
cancellation and timeout update the backlog. Provider counts never authorize
dispatch. No compatible worker produces a visible, retriable bootstrap failure.
The trusted provider parent validates every selected ID, name and branch against
the trusted provider catalog and restores repository snapshots. Before model
execution, Minicode fetches the exact branches, prepares an owned primary
worktree and resolves reference context. Only this configured harness advertises
`hosted_repositories_v1`; ordinary workers retain their existing setup.

Hosted workers persist `busy` before repository preparation and `idle` after
the broker acknowledges the final result. Busy updates provider capacity demand.
Assignment and idle limits survive reconnects; the provider configures these
limits and execution retirement policy. Worker heartbeats,
reservation proofs, start recovery and deletion tombstones are provider-owned.

Managed pairing uses POST/PUT/DELETE `/api/agent-pool/hosted/workers`, not public
pairing tokens. `PAPERCLIP_ENTRA_HOSTED_WORKERS` configures the tenant, application
audience and exact provider client/principal/API URL/audience grants. Only Entra
application tokens with `AdoPipelines` and that exact provider identity qualify;
the company, Hosted pool type, name and external provider pool ID must match
the database. Existing credentials cannot be taken over or resurrected.
The parent exchanges Entra authentication for an Easy Auth session, preserving
run-scoped Authorization headers. This deployment path requires public
Paperclip/Easy Auth; private-only deployments leave Hosted disabled.

Graceful retirement requires `retiring_ready_v1` in the server's welcome
capabilities. After the result ACK, a retiring worker sends
`{"type":"ready","retiring":true}`. The broker settles the result without
readmitting the worker and returns `{"type":"retired"}`. Only then does the
worker close and report stopped; a missing receipt fails explicitly. Normal
workers continue sending ordinary `ready` messages.

### Persistent Hosted slots and all-repository workspaces

The provider registers a bounded catalog of durable worker identities per company using
POST `/api/agent-pool/hosted/slots` with company/pool identifiers and
`slots: [{workerId, name}]`. Registration is idempotent and does not reset
credentials or explicit revocations. A partial unique database index permits
only one Hosted pool per company; additional Devbox pools remain independent.
Slot IDs and names must be unique; names and catalog size (1-1000) are provider-configured.
These are logical slots, not running containers.

POST worker activation includes `executionId`, `generation`, and a monotonically
increasing `activationVersion`. A later activation rotates credentials; stale
activations cannot overwrite it. PUT deactivates only the matching execution and
generation, clearing the active credential without setting `revokedAt`.
The broker disconnects without recording a revocation. DELETE remains explicit
revocation and cannot be undone by slot registration or reactivation. Historical
routine-revocation rows remain audit records; the new slot namespace does not
reuse their IDs.

A v2 provider catalog tags every row with `workspaceMode: "all_repositories"`
and `readOnly`. Exactly one read-only repository must have `supervisory: true`;
its name and branch are provider-configured, and its checkout becomes `worker_shared`.
Clippy ignores/removes old primary/reference selections and sends the whole
catalog as `repositories: {mode: "all_repositories", repositories: [...]}`.
Only workers advertising `hosted_workspace_v2` can receive it; v1 and Devbox
behavior remain unchanged.

The trusted parent prepares every checkout below a non-Git parent, restores
verified daily Git bundles when available, then fetches every configured branch's
latest ref before model execution. The model starts at that common parent.
`worker_shared` guidance and same-named skills override all repository guidance;
other read-only repositories are reference material, not instruction sources.
Duplicate writable repository skills are repository-qualified.
Read-only access is instruction policy, not OS isolation.

The Hosted harness exposes one repository-selecting `publish_pull_request` tool.
Each writable repository publishes/registers its own PR; the model has no remote
write credential. Publication requires an admitted active run and current
writable catalog entry. Retry/reconcile uses the same repository and local
commit, including after local cleanup. Repositories with a designated publisher
may only be published through that publisher; the trusted parent enforces this policy.
Prepared writable descriptors include provider publication metadata for repository
identity, PR URL and branch templates, rather than assuming a Git hosting service.
See the [provider integration contract](../../minicode/README.md#provider-integration-contract).

## Connection and assignment

Connect to `/api/agent-pool/worker?workerId=<paired-worker-id>` with the paired
client credential in the Authorization bearer header. Send a hello:

```json
{
  "type": "hello",
  "protocolVersion": 1,
  "instanceId": "a-fresh-uuid-for-this-worker-process",
  "runId": null,
  "capabilities": ["inline_instructions_v1", "skill_bundle_v1"]
}
```

The server responds with `welcome`, `protocolVersion`, `serverInstanceId`,
`runId`, `ack`, and `completed`. Send `{"type":"ready"}` when idle. One task is
assigned at a time:

```json
{
  "type": "task",
  "protocolVersion": 1,
  "runId": "run-id",
  "agent": { "id": "agent-id", "name": "Founding Engineer", "companyId": "company-id" },
  "instructions": {
    "version": 1,
    "format": "markdown",
    "content": "Keep reports concise and include actionable blockers.",
    "revisionId": "opaque-saved-content-revision",
    "contentSha256": "<64-lowercase-hex-digits-hashing-the-UTF-8-content>"
  },
  "skills": {
    "version": 1,
    "sha256": "<SHA-256-of-the-exact-ZIP-bytes>",
    "url": "/api/agent-pool/skills/<same-SHA-256>.zip",
    "files": [
      { "path": "paperclip/SKILL.md", "sha256": "<SHA-256-of-file-bytes>" }
    ]
  },
  "context": {},
  "continuation": null,
  "runtimeTools": null,
  "authToken": null
}
```

`context` contains the assignment/wake context. `continuation` is the existing
execution-continuation envelope. `runtimeTools` and `authToken` are optional
run-scoped credentials/tool access, not model instructions. Pass credentials to
authorized tools, never to model prompts or logs.

## Inline instructions

The server resolves the assigned company's agent's current managed entry
document during run preparation. `instructions` is `null` if no document exists;
missing storage is optional, but invalid or unreadable configured content fails
the run. External host-path bundles are not supported for AgentPool.

`inline_instructions_v1` promises that the worker will validate the instruction
version, Markdown format, and UTF-8 SHA-256 before starting model/tool work, and
apply the exact content as agent-level instructions throughout the assignment.
Malformed/unsupported instructions must produce a failed result, never be
ignored. Adapters may translate the envelope to their own system/developer
instruction mechanism; it is not a Minicode-specific prompt.

Built-in harness safety and execution rules remain authoritative. Agent-specific
instructions override conflicting repository guidance; task/continuation text
does not replace them. Do not interpret instruction text as an authorization
grant. No host path, automatic filesystem read, or worker-side file creation is
part of this delivery mechanism. Only the entry document is delivered, not
supporting agent-specific bundle files or attachments. Built-in operational
skills use the separate delivery mechanism below.

The envelope is a per-assignment snapshot. Editing the saved document affects the
next assignment, not an active execution or a reconnect. A reconnect never
replays a task or reloads its instructions. Revision IDs are opaque; hashes cover
the exact content without newline or Unicode normalization. Log content-free
metadata if needed, not instruction bodies.

## Operational skill bundles

`skill_bundle_v1` is required for every new assignment from an updated server.
The server snapshots the bundled operational and onboarding skills, references, scripts, and
license into a deterministic ZIP and sends its SHA-256 and per-file manifest.
Neither the archive nor its manifest includes worker-host shared files,
configuration, credentials, or agent-specific instruction bundles.
Every `server/src/onboarding-assets/<flow>/skills/<name>/` tree is included in the
same top-level skill namespace, including `first-task`; future onboarding skills
follow that convention automatically. Non-skill templates/personas are excluded.
Case-insensitive skill-name collisions fail bundle creation.

Fetch the relative URL against the reachable Paperclip API origin using the
assignment's run-scoped bearer credential; never forward credentials to redirects
or another origin. The endpoint requires an authenticated board or company agent.
It serves only server-created immutable snapshots, not arbitrary host paths.
Uncached/expired hashes return 404 rather than a different bundle. The server
retains the latest 16 unique snapshots in memory; a server restart already
requires retrying an interrupted assignment under the reconnect contract.

Before **every new assignment**, verify the cached archive against the expected
SHA-256 and all extracted contents against the manifest, or freshly re-extract the
verified archive. Repair missing/corrupt/stale caches from the authenticated URL.
If download, integrity, or extraction fails, fail the run before model/tool work.
Reject unsafe paths, duplicate/case-colliding names, links in the cache, and
tracked cache contents. Bounds are 4 MiB ZIP, 8 MiB extracted, 256 files.
Reconnect never replays the assignment or reloads its skill snapshot.

Minicode stores these files in each agent checkout's `.worker/skills.zip` and
`.worker/skills`, excluded through local `.git/info/exclude`. This cache is
harness-managed; `worker_shared` remains entirely host-owned and is never a
Paperclip installation target. Default worktree clean-reset removes this cache,
so it is downloaded and verified again for the next assignment; legacy clones
can reuse verified caches. Minicode rereads root `AGENTS.md` and discovers
`.agents/skills/<name>/SKILL.md` in both the shared root and assigned checkout on
every new assignment. Shared guidance overrides worktree guidance; same-named
skills resolve **worker_shared > worktree > bundle fallback**. The selected core
`paperclip` skill is injected, and other selected skill paths are supplied for
task-driven reading, without merging or overwriting skill directories. These
local instructions and skills remain below harness safety rules and managed
agent-specific instructions. Links in local instruction/skill discovery paths
fail preparation; local guidance is not covered by the ZIP's hash.
Other harnesses may select an equivalent safe,
Git-ignored runtime directory. Make the core skill and its companion files
discoverable and provide the skill's standard run-scoped `PAPERCLIP_*` environment.
Skills do not grant new permissions. Task progress/completion uses the existing
comments/issue APIs, not interpretation of a successful run or final prose.

## Output, completion, and cancellation

Send events with strictly increasing `seq` values starting at 1:

```json
{"type":"log","runId":"run-id","seq":1,"stream":"stdout","data":"Meaningful progress\n"}
{"type":"result","runId":"run-id","seq":2,"exitCode":0}
```

Logs allow `stdout` or `stderr` and at most 16,384 characters per event. A failed
result uses a nonzero exit code and optional sanitized `error` (up to 2,000
characters). The server acknowledges events with `ack`, `runId`, `seq`, and
`completed`. Retain unacknowledged events and the final result until acknowledged.
Send `ready` only after completion is acknowledged and tool work has stopped.
The broker settles the assignment only after this final `ready`, and records a
server-owned stop receipt bound to the run, company, worker process and result
sequence. A result without `ready`, a lost process, an expired reconnect lease,
or unacknowledged cancellation is not evidence of a stopped assignment.

For Devbox pools, if no idle compatible worker is available, the broker fails the run with
`agent_pool_worker_unavailable` and records bootstrap evidence that no assignment
was dispatched. This remains a failed, explicitly retriable run, not an
unknown-action reconciliation hold, even after repeated availability failures.
Connect an eligible worker and retry to start a fresh assignment. A failure
after dispatch does not receive this no-dispatch evidence. Hosted pools first
perform the bounded capacity-request/wait flow described above.

When human input is needed, save the question, progress and durable artifacts
through the task APIs, leave the task waiting/blocked, and finish the assignment
normally without an error. Do not hold the worker or poll for an answer.
A saved human answer or explicit retry starts a fresh assignment for the same
agent on any available worker, with the original task, conversation, human
responses and recorded completed actions. Never replay prior tool calls or
infer the outcome of an uncertain mutation. Actual execution/publication failures
remain failures; a new user turn can retire their execution hold only after the
broker's stop receipt and normal authority, decision and cleanup gates pass.

Raw tool output is model input, not a required public log event. Workers may
offer normal/verbose logging; normal should retain meaningful progress,
errors/status, and the agent's summary without streaming raw tool results.
Minicode defaults to normal, with `--output-mode verbose` restoring raw output.
This changes logging only, not the results supplied to the model.

A `cancel` message names the active `runId`. Interrupt and settle all active
operations before reporting completion. Do not acknowledge cancellation while
tools remain running.

## Reconnect, bounds, and compatibility

On a network drop, reconnect within 60 seconds with the same process
`instanceId` and active `runId`. Confirm the same `serverInstanceId` and execution
in `welcome`, then replay only events above the acknowledged sequence. Lost
processes, lost server state, revoked credentials, or expired reconnect leases
require an explicit retry; never adopt or replay an old task.

Frames are limited to 256 KiB of serialized UTF-8 JSON, including instructions,
task context, and credentials. Total public run output is limited to 2 MiB.
Oversized assignments fail before dispatch; instructions are never silently
truncated. Keep instruction entry documents concise.

Unversioned legacy hellos mean protocol 1 with no capabilities. Updated servers
skip workers without `skill_bundle_v1`; tasks with instructions additionally
require the explicit inline capability. If none is compatible the run fails
with an upgrade/connect instruction. New Minicode workers still accept legacy
tasks from older servers with no inline instructions or skill metadata, but those
servers do not provide managed operational skills or integrity validation.
Unknown capabilities and additive optional fields may be ignored; unsupported
protocol or instruction versions must be rejected. Breaking task semantics
require a new protocol version; new optional features require a new capability
before the server can depend on them.
