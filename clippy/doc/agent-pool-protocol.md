# AgentPool worker protocol

AgentPool is a harness-neutral, authenticated JSON WebSocket protocol. Workers
may use Minicode or another agent implementation. Pairing binds a worker to one
company and named pool; the control plane chooses an idle compatible worker.
Workers do not need access to the control plane's filesystem or Git checkout.

The canonical TypeScript schemas and types are exported from
`@paperclipai/shared/agent-pools`. Non-TypeScript workers implement the same JSON
contract. Do not depend on Minicode's internal session or prompt representation.

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
The server snapshots the bundled operational skills, references, scripts, and
license into a deterministic ZIP and sends its SHA-256 and per-file manifest.
Neither the archive nor its manifest includes worker-host shared files,
configuration, credentials, or agent-specific instruction bundles.

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
Paperclip installation target. Other harnesses may select an equivalent safe,
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
