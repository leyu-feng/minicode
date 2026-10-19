# Runs, harnesses, and model accounts — agent access

Product map: [Runs, harnesses, and model accounts](../feature-map/runs-adapters.md).

Review date: 2026-10-12. Source commit: `58e16dbddfc9c8d0cf60867f9d9847f0feda055b`.
Native REST transport reconciled in this change; see the
[shared transport contract](README.md#native-rest-transport).

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

Scoped runner-default source review: 2026-10-12 at
`eee0534154eaf5d0d3f2bbc97c1e24d86f34a5a5`, limited to runner discovery,
selected-runtime testing and saved execution/session preservation. The original
baseline source and review depth remain unchanged for unrelated operations.

Scoped native cancellation source review: 2026-10-12 at
`ce23716503a2c9158b5a7ab74ab61571ff4ee7a3`, limited to owned startup and
shutdown/readiness ordering. The original baseline and review depth remain for
unrelated operations; no live provider or agent authorization is claimed.

## `availability`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/adapters`.
- `GET /api/companies/{companyId}/adapters/{type}/models`.

Agent access: `partial` — Agent company-model REST / native `call_api` discovery and
bound runtime context; adapter/account inventories remain board-only.

Policy: Run/cost visibility and agent configuration policy; adapter installation/account
login/session control require board/admin.

Evidence: `source-only` — [implementation](../../server/src/routes/agents.ts#L6608) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Raw instance adapter listing requires board, while company model discovery exists
for eligible agents.

Scoped source-only evidence: [adapter discovery](../../server/src/routes/adapters.ts)
reports supported runners/effective default for the selected company/environment;
[selection policy](../../server/src/services/agent-runner-selection.ts) reads
server-owned immutable sandbox facts without provisioning. New Codex defaults
and explicit overrides follow the [shared runner contract](../../packages/shared/src/agent-runner.ts);
other harness defaults remain unchanged. The board inventory does not grant a
native agent an equivalent discovery binding. See
[probe restrictions](./execution-environments.md#probe) for acquiring qualification.
An absent forced-Kubernetes environment is an unqualified sandbox target, never
a local target. Discovery and automatic creation keep the Legacy path without
provisioning it; explicit Paperclip selection returns qualification guidance.
The existing execution path owns lazy environment creation. Saved runners remain
unchanged. This is source/control evidence, not live Kubernetes qualification.

## `validation`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies/{companyId}/adapters/{type}/test-environment`.

Agent access: `partial` — Permitted agent-creation validation through REST / native
`call_api` / CLI; account login requires its operator.

Policy: Run/cost visibility and agent configuration policy; adapter installation/account
login/session control require board/admin.

Evidence: `source-only` — [implementation](../../server/src/routes/agents.ts#L6608) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Environment test path checks creation/configuration policy; missing provider auth
must use its owner setup flow.

Scoped source review: [test authorization and resolution](../../server/src/routes/agents.ts)
requires same-company `agents:create`, saved-agent update access when supplied,
allowed environment selection, and normal secret/responsible-user checks. An
unchanged saved runner avoids new-creation policy but still receives selected
runtime validation. [Native readiness](../../server/src/services/native-runtime/setup-readiness.ts)
tests native Codex startup/model/account and bounded teardown; an authentication
or Legacy CLI check cannot replace that runtime evidence. Missing dependencies,
credentials, invalid models and incompatible settings fail without silently
changing runners. Account login remains board/owner-bound.

For a linked Codex subscription with server-resolved managed credential provenance,
setup checks the resolved owner and stages a private probe copy before local or
remote isolation. Without a selected API key, an unbound linked `CODEX_HOME` is
rejected with explicit Legacy
or managed-account guidance. Caller configuration cannot supply that provenance. Selected `CODEX_API_KEY` and
`OPENAI_API_KEY` authentication skips unrelated subscription reads and refresh
bindings, matching task materialization. The fake-credential controls verify key
precedence without changing the account source or exposing either credential.
The general native
home materializer retains its no-follow symlink guard. Refresh still targets the
checked account source, and confirmed bounded retirement removes its private
copy. Unconfirmed retirement retains the existing cleanup block and owned state.
Failures before probe handoff remove only the owned temporary preparation root;
local daemon resolution occurs before credential staging. Once a probe is handed
off, unconfirmed retirement still retains its recovery state.
[Existing fake-credential setup controls](../../server/src/services/native-runtime/setup-readiness.test.ts)
exercise linked/regular sources and failure cleanup. This adds no credential-read
API, agent login authority or cross-company account access. Its source-only
evidence does not qualify a live permitted/denied agent operation.

Verification for this scope remains `not-run`: use an admitted agent REST/CLI
validation path, assert missing grants and cross-company targets/accounts are
denied, then prove the useful task/follow-up separately. `hire_agent` inherits its
caller's runtime; do not assume its binding accepts arbitrary runner or account
settings. See [creation access](./agents.md#hire).

## `runs`

Review: `baseline`.

Scoped source-only timing evidence: workspace preparation spans carry only the
existing hashed run ID. Controller startup phase spans carry no custom attributes.
Native controller setup and settlement phases use that same run hash, including
assigned MCP discovery; neither tool definitions nor credentials are recorded.
Both retain operator-controlled tracing; unconfigured clients stay silent.
This adds no agent API, credential access, run-log write, or recovery authority.
See [the tracing contract](../../doc/observability.md#controller-preparation-phases).
Live latency verification remains separate from the existing access baseline.

API: `present` — representative operation IDs:

- `GET /api/heartbeat-runs/{runId}`.
- `GET /api/heartbeat-runs/{runId}/log`.

Agent access: `available` — REST / native call_api / CLI run.

Policy: Run/cost visibility and agent configuration policy; adapter installation/account
login/session control require board/admin.

Evidence: `source-only` — [implementation](../../server/src/routes/agents.ts#L6608) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Provider trace reveals/downloads require instance-admin and cannot be counted as
ordinary run output access.

## `session`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/agents/{id}/runtime-state/reset-session`.
- `GET /api/agents/{id}/task-sessions`.

Agent access: `restricted` — Board session controls; native server-owned session
continuation.

Policy: Run/cost visibility and agent configuration policy; adapter installation/account
login/session control require board/admin.

Evidence: `source-only` — [implementation](../../server/src/routes/agents.ts#L6608) at
the reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: Task-session listing and execution-context reset require board agent
management at their HTTP routes. Native `call_api` preserves these denials; native
continuation remains server-owned.

Scoped source-only evidence: [configuration changes](../../server/src/services/agent-configuration.ts)
and [native execution/recovery](../../server/src/services/native-runtime/native-session-executor.ts)
retain existing execution on unrelated edits and use recorded run configuration
for active/recovered runs. Explicit runner changes use revisions and session
invalidation. Verify saved configuration, current versus historical run identity,
restart and follow-up without granting session-reset authority to an agent.

Scoped source review: 2026-10-13, the recovery correction against
`ea6c8eb5e16d61111968f633a66748b397b64a3e` reuses
[completed onboarding handoff validation](../../server/src/services/chat-completion-delivery.ts)
before applying the issue-terminal backstop. The company, parent origin/status,
assignee, completed child and remaining children must match. Only that backstop
is suppressed for the validated report; process-death and controller/native
ownership checks still apply. No agent gains session or recovery control.
PostgreSQL regressions cover valid native/Legacy callbacks and rejected bindings;
revised live execution and actor authorization remain `not-run`.

Scoped Evidence: `source-only` — the
[native transport](../../packages/paperclip-runner/src/live/runnerd-codex-transport.ts)
joins owned startup before certifying cleanup. Rejected duplicates cannot replace
that owner or mutate recovery state. Unconfirmed preparation or registration
retains recovery state; late registration may release only its own route and
cannot launch after close. Shutdown interrupts readiness without granting
authority over an unauthenticated adopted process.

Scoped Verification: `not-run` — verify allowed/denied access using the actual
actor independently from the credential-free ownership controls. This correction
adds no account-setup, cleanup-override or session-reset authority. The real native
readiness/recovery fixtures and installed provider acceptance remain separate gates.

Scoped shutdown source review: 2026-10-14, against literal
`651a3de64fc943216cc414b64b1443809f9499da`. The suspension barrier bounds remote
state reads by its remaining deadline and rejects late proof. Intentional
[provider ingress shutdown](../../server/src/realtime/runner-prp-outbound.ts)
joins physical socket closure and retires the connection owner before endpoint
release. Unconfirmed termination stays blocked. Existing fake-peer and delayed
read controls are source evidence; this changes no actor, company, account or
session-reset permission. Operation-level verification remains `not-run` and
the failed Test setup does not qualify successful live cleanup.

## `agent-pools`

Review: `baseline`.

API: `present` — GET/POST /api/companies/{companyId}/agent-pools;
GET/POST /api/companies/{companyId}/agent-pools/{poolId}/workers;
DELETE /api/companies/{companyId}/agent-pools/{poolId}/workers/{workerId}.
POST /api/agent-pool/pair consumes a ten-minute, single-use server token and binds
a worker-generated client credential. WebSocket /api/agent-pool/worker requires
that worker's client credential, including in local-trusted mode.
GET /api/agent-pool/skills/{sha256}.zip serves the server's built-in operational
skill snapshot to an authenticated board or company agent, using the run-scoped
bearer credential for workers. It exposes no worker-host paths or configuration.

Agent access: `operator-only` for pool/worker administration; normal agent keys
are denied. Minicode's `worker` CLI is the worker entry point. It receives only
its assigned run context and transient run-scoped tool credentials, not board
authority or the credentials of another pool.
Its actual tools run in a persistent, independent per-agent Git clone on that
worker, initialized from committed source files outside the source checkout.
The source comes from an explicit `--repo-root` or the launcher's working
directory. Worker tests pass the full `clippy-worker` submodule path explicitly.
Server workspace paths remain context metadata, not worker filesystem bindings.
This working-directory separation does not sandbox shell access.
Operational skills are `available` through the authenticated bundle URL and the
worker's `.worker/skills` discovery path; this does not grant pool administration.

With operator-configured GitHub publication, the worker harness registers its
verified receipt using the agent's run-scoped issue work-product/comment APIs.
It checks issue ownership before GitHub access, rejects scoped issue overrides,
and reuses records/comments on sequential retries. General Run Now calls require
an explicit assigned issue UUID. Registration failure preserves the receipt and
fails the run; no board credential, automatic task completion, or merge permission
is granted. Source and fixture controls:
[registration](../../../minicode/server/paperclip-publication.js),
[publisher regressions](../../../minicode/test/github-publisher.test.js),
[worker regressions](../../../minicode/test/agent-pool-worker.test.js).
The core skill is injected and standard task/wake/auth environment is populated
per assignment. Agents use the existing issue comments/update APIs for task-chat
progress and completion under their normal ownership, company and run gates.

Policy: board and company access for management, pool ownership for worker
creation/revocation; company and pool binding for dispatch. Tokens are hashed at
rest, pairing is atomic and one-time, credentials are excluded from inventories
and diagnostics. Existing heartbeat admission, assignment, approval, known-budget
and cancellation gates remain authoritative. Offline/busy pools and process loss
fail visibly with explicit retry; network resumption never replays the task.
Every assignment requires `skill_bundle_v1`. The expected ZIP hash and file
manifest are server-supplied; Minicode rehashes the cached ZIP and freshly
extracts verified files before model execution. Invalid archives, unsafe/linked
or tracked caches, and failed authenticated downloads block the run. The
Git-ignored `.worker` cache is harness-owned by instruction policy, not a
sandbox; `worker_shared` remains exclusively host-owned.

Evidence: `source-only` — [routes](../../server/src/routes/agent-pools.ts),
[credential service](../../server/src/services/agent-pools.ts),
[broker](../../server/src/services/agent-pool-broker.ts),
[worker](../../../minicode/server/agent-pool-worker.js), and
[integration tests](../../server/src/__tests__/agent-pools.test.ts).
Fixture tests cover persistence, denied company/agent management, credential
lifecycle, WebSocket authentication and a real Minicode CLI with a mock model.
The CLI fixture checks that its artifact and model working directory belong to
the agent checkout and leave the source untouched. [Worker tests](../../../minicode/test/agent-pool-worker.test.js)
also cover real shell execution, retained edits, restart, agent separation and
explicit workspace preparation failure.
Focused bundle fixtures additionally cover authenticated/anonymous downloads,
deterministic archive snapshots, reference hashes, first install/cache reuse,
changed or corrupt ZIPs, tampered extracted files, unsafe paths, tracked/linked
caches, extraction limits, download cancellation, and capability negotiation.

Verification: `not-run` for deployed human/agent access. With disposable company
identities, assert allowed board operations, foreign-company and agent-key
denials, single-use/expired pairing, credential revocation, and single-worker
dispatch. Prove a useful provider result separately from connection readiness;
exercise network reconnect, process loss and cancellation without replay.

Gaps: provider usage accounting, workspace synchronization, durable
execution-restart recovery and horizontal broker failover are not supported.
Live provider and deployed reverse-proxy qualification remain separate gates.
