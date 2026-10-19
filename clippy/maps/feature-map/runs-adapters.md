---
navigation: {"section":"Agents and reusable capabilities","sectionOrder":30,"order":20}
---

# Runs, harnesses, and model accounts

Operators choose an agent harness and model account, inspect execution history and transcripts, and distinguish a working configuration from a successful task result.

Implementation: [adapter manager](../../ui/src/pages/AdapterManager.tsx), [run host](../../ui/src/pages/AgentDetail.tsx), [configuration](../../ui/src/components/AgentConfigForm.tsx).

Agent access: [companion](../agent-access-map/runs-adapters.md).

## Sub-features

- `availability`: discover installed adapters and available models/accounts.
- `validation`: test an adapter in the selected execution environment and surface authentication failures.
- `runs`: inspect run status, events, output, costs, and the source task.
- `session`: preserve or reset execution context through supported lifecycle actions.
- `agent-pools`: create named worker pools, pair/revoke Minicode workers, and select a pool for an agent.

## How to get to it (user POV)

### `adapter-setup`

Open an agent’s model/adapter configuration or the instance adapter settings page when permitted.

### `run-history`

Open an agent run at `/agents/:agentId/runs/:runId` from the agent or task activity.

For latency diagnosis with an operator OTLP endpoint, search the hashed run ID
without restricting the root span name. Compare workspace preparation with its
`workspace_<step>` intervals. Measure controller readiness separately through
`controller.startup.<phase>`. A recovery pause or deployment drain is not model
execution time. See the [tracing contract](../../doc/observability.md#controller-preparation-phases).
These source-level diagnostics do not establish a live response-time budget.
Inspect `native.controller.<phase>` for backend construction, assigned-tool
discovery and post-turn cleanup. Compare those intervals with the actual model
turn; do not count a nested discovery interval twice.

### `agent-pool-setup`

Open Company settings and its AgentPool workers section. The `default` pool is
automatic; create distinct named pools there, generate one-time pairing tokens
for workers, and inspect or revoke them. Hire an agent with AgentPool and select
the pool name. Follow [worker setup](../../../minicode/README.md#connect-as-an-agentpool-worker)
on the worker machine.

Updated workers download Paperclip's bundled operational and onboarding skills into the assigned
checkout's Git-ignored `.worker/skills`, not the host-owned shared folder. Confirm
the run records a verified ZIP hash before model work, and inspect the next
assignment after editing an extracted reference: it must restore the expected
content or fail explicitly, never run with changed instructions. On Run Now,
the core skill supplies assignment discovery and authenticated task-chat/status
updates; successful console output alone is not task completion.

The ZIP includes `first-task` and every future onboarding `<flow>/skills/<name>/`
tree, including references/scripts but not unrelated templates or personas.
Minicode loads root `AGENTS.md` and discovers `.agents/skills/<name>/SKILL.md`
in both shared and assigned checkouts per assignment. Shared guidance wins
local conflicts; skills select shared > worktree > bundle fallback, including
the injected core skill. Harness and managed-agent instructions remain higher.
Every pool worker can serve every pool agent; different setup requires a
different pool. Default worktree mode uses stable short worker/agent sibling
folders such as `w1a1` and `w1a2`, clean-reset to current committed source `HEAD`
before every new assignment. Legacy `--workspace-mode clone` retains persistent
independent per-agent clones. These filesystem
boundaries are instruction policy, not an OS sandbox.
Default workers monitor disk space every 60 seconds and at assignment setup.
Below 24 GiB, verify idle owned worktrees are evicted in persisted LRU order
toward 36 GiB, with active/source/shared/other-worker/legacy/unmanaged paths
preserved. Reassign an evicted agent and verify the same short slot is recreated.
Insufficient space must fail before model work; idle local results are not
durable artifact storage.

For a disposable assignment, place a same-named skill in both local roots and
confirm the shared path and injected core content. Remove it to select worktree,
then bundle fallback. Change shared `AGENTS.md` between assignments and observe
updated guidance without restarting the worker. Verify `first-task` is available
from the bundle without a shared copy; linked discovery paths must fail.

With harness GitHub publication enabled, the PR receipt is registered as a task
work product and linked in task chat. Inspect the task's existing **Pull requests**
section rather than a separate dashboard. Retrying the original commit refreshes
its saved state without another publication; incomplete Paperclip registration
fails the run and retains the receipt for recovery. Neither publication nor a
merged record automatically completes a task or bypasses approval gates.

## Driving it with Playwright and the Paperclip CLI

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Record adapter, model, account, native/legacy runtime, and environment. Capabilities vary; one harness result is not a matrix-wide qualification.

### `adapter-setup`

Automated: [adapter validation routes](../../server/src/__tests__/agent-adapter-validation-routes.test.ts) and [model refresh](../../server/src/__tests__/adapter-model-refresh-routes.test.ts) cover server behavior.

Manual: Select the intended adapter and account, refresh model choices, and run its environment test. Save, reload, then execute a small task. Repeat with a deliberately unavailable account and verify the failure remains visible.

Choose Codex as the harness; the UI displays its name/icon for both runners.
Advanced identifies the automatic default and offers Paperclip Runner or Legacy.
Only new Codex agents default to the native runner on supported macOS or GNU/Linux
targets; the [shared selection contract](../../packages/shared/src/agent-runner.ts)
and [runtime prerequisites](../../packages/paperclip-runner/README.md) define the
platform/libc boundary. Windows and Alpine/musl remain Legacy; other harness
defaults are unchanged. Disabled adapters, external overrides, and selected-target
qualification also affect availability.
On a fresh forced-Kubernetes instance without an environment row, inspect discovery
and create with automatic selection. Both must retain Legacy without provisioning;
an explicit Paperclip request must give target-qualification guidance. Begin the
ordinary task to exercise the existing lazy environment path. This live journey
remains separate from the resolver's source controls.

For sandbox defaults, follow the [environment probe](./execution-environments.md#environment-settings)
recipe first. Discovery/creation read company-bound immutable-image evidence
without allocating a target. A mutable image or snapshot name does not establish
native compatibility. Then test the actual selected runtime with its selected
account/model: a legacy CLI or authentication probe alone cannot establish native
readiness. Missing dependencies, failed authentication, invalid models and
incompatible custom settings must remain actionable errors without silent runner
switching. Saved unchanged execution can still be tested without applying new
selection policy, but runtime/account validation must still run.

Verify an automatic Codex hire and an explicit Legacy control through a useful
file artifact, follow-up and reload. Preserve Codex reasoning effort and account
isolation; retain explicit Legacy permission choices, including false. Reopen an
existing agent, make an unrelated edit, and confirm both its persisted runner and
next run stay unchanged. Use [hiring/import preservation](./agents.md#hire-agent)
for approval and portability controls.

Test native Codex with a saved subscription whose setup auth file is a managed
link, as well as a regular file and an API-key account. Setup must seed the
isolated probe from the checked account without exposing credentials or changing
its saved runner. With subscription authentication, an unbound configured
`CODEX_HOME` with linked credentials must fail setup with managed-account or explicit Legacy guidance; it must not claim
readiness when task isolation would omit the file. Dangling or incorrectly owned
credentials must also fail clearly. A selected `CODEX_API_KEY` or
`OPENAI_API_KEY` takes precedence over an unrelated subscription file. Test valid,
dangling and invalid subscription links with that selected key; setup must test
the key without reading or refreshing the unrelated account. The private probe copy must be removed after confirmed retirement following success,
failure or cancellation. Unconfirmed shutdown remains a cleanup failure.
Exercise an unavailable local daemon and a preparation failure before probe
handoff. No owned temporary credential copy may remain, and original account
files must be unchanged. A probe whose shutdown is unconfirmed must retain its
recovery state; do not treat it as a preparation-only failure.
Existing setup controls use fake credentials; real account execution remains
a separate acceptance requirement.

### `run-history`

Automated: [live run routes](../../server/src/__tests__/agent-live-run-routes.test.ts) and [run event sequencing](../../server/src/__tests__/heartbeat-run-event-sequencing.test.ts) cover run data contracts.

Manual: Start a disposable task, open its running transcript, and follow it to a terminal outcome. Reload and compare task/run IDs, status, output, and cost. Verify a failed run remains distinguishable from a completed run with useful output.

An explicit runner change starts a configuration revision and invalidates the
eligible session. Active runs, restart recovery and historical transcript parsing
retain their recorded execution configuration; do not infer their runner from a
later edit to the agent. Account/harness branding and execution identity are
different observations, both required in the evidence.

For an onboarding child-completion callback, verify actual session/turn events
and the source-correlated reply. A `succeeded` row alone is insufficient: the
literal `ea6c8eb5e16d61111968f633a66748b397b64a3e` managed attempt was marked
successful during startup without a provider turn. The recovery correction
preserves the existing validated Done-parent handoff; process-death and ownership
checks remain active. Its PostgreSQL controls are separate from the required
revised-source live onboarding and follow-up proof.

## Gotchas

For AgentPool, pair two disposable Minicode workers with committed source Git
repositories. Pass the full `clippy-worker` submodule path as `--repo-root` to
the worker CLI or CMD launcher; entry points retain their current-directory
behavior rather than selecting this submodule automatically.
Assign a task and verify that exactly one worker writes its useful
output in its worker/agent checkout, not the source repository, and
Clippy records the result and actual worker workspace path. Source dirty files
must not be copied. In default worktree mode run the same agent again, including
after a worker restart, to verify its short path is stable but tracked edits,
local checkout commits and untracked/ignored leftovers are reset before the next
assignment. Confirm current committed source updates arrive, source/shared
files remain unchanged, and another agent gets another short checkout on the
same worker. Legacy clones must retain their edits. Upload/publish results
before another assignment resets the worktree.
Disconnect only the network during a live run and
verify the same execution resumes without replay. Restart a worker/server or
exceed the 60-second lease: verify visible failure and no automatic retry. Revoke
the worker and verify its credential can no longer connect. An offline or fully
busy pool must fail visibly. The focused broker, persistence, CLI and component
tests are automated fixture evidence; they do not qualify a deployed provider.
Files remain worker-local and model usage is not reported.

- Model accounts are managed in Apps and inline agent account controls.
  `/company/settings/connections` configures decision/fast-response models,
  not the general model-account library.

- The run log is instance database data; it is not the opt-out first-party Telemetry system or operator-configured OpenTelemetry tracing.
- Authentication/model discovery does not establish tool, image, steering, or resumption capability parity.
- Use [recovery](./recovery.md) for interrupted runs and [execution environments](./execution-environments.md) for local/SSH/sandbox differences.

Native setup retirement joins owned startup before cleanup can be confirmed.
[Transport ownership controls](../../packages/paperclip-runner/src/live/runnerd-codex-transport.test.ts)
hold preparation or registration without launching a provider, then check bounded
close, rejected duplicate requests, no later launch and retention of unconfirmed
state. Readiness observes shutdown; resumed startup cannot reactivate ingress
after close. These are lifecycle controls, separate from installed provider proof.
The real daemon readiness and recovery controls require their existing native
fixtures in hosted CI; passing credential-free controls does not qualify them.

For remote setup shutdown, verify that each durable-state read respects the
remaining suspension deadline. A late result cannot establish suspension or
queue a replacement command after that deadline. An intentional ingress close
must observe physical socket closure before retiring its connection owner and
releasing the endpoint; an unresponsive peer must not extend the setup budget.
The existing transport and ingress suites exercise these conditions without a
provider. Repeat the actual managed setup and useful task journey separately;
the literal `651a3de64fc943216cc414b64b1443809f9499da` Test attempt failed
cleanup before hire and retains its unconfirmed recovery state.
