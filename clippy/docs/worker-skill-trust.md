# Worker skill trust

Workers discover skills in both `.agents/skills/<name>/SKILL.md` and `.github/skills/<name>/SKILL.md`. Operator-selected `--worker-shared` skills are trusted by default. Workspace, repository, reference and downloaded bundle skills are unavailable unless the operator explicitly approves their source, exact skill name and complete directory digest. Duplicate names across the two discovery folders in one source fail closed (case-insensitive). Shared skills override approved repository skills, then approved worktree skills, then approved bundle skills. Duplicate approved repository names are qualified as `Repository/skill`.

## Operator approvals (paired/local workers)

Supply `--skill-approvals <absolute-file>` when starting the worker. The manifest is loaded at startup; changes require a controlled restart. Never take this option or manifest contents from task data, agent messages or repository instructions.

Manifest format:

    {
      "version": 1,
      "approvals": [
        {
          "source": "worktree:C:\\Code\\project",
          "name": "review",
          "sha256": "<64 lowercase hexadecimal characters>"
        }
      ]
    }

The placeholder is not a valid digest. Obtain the real digest from the reviewed directory, including every helper and reference:

    node minicode/server/skill-approvals.js digest C:\Code\project\.github\skills\review

Commands above are relative to the Minicode repository root. Review the entire skill before granting approval. Digests include file paths, contents, directory names and executable mode bits, not just SKILL.md; links and unusual file types are rejected. Any change requires a new digest and operator review. Existing digests from an older digest implementation must be regenerated.

Exact source strings (absolute paths use native separators, normalized with Node path.resolve; spelling/case must match the configured source):

- `worktree:<absolute original source repository path>`: the original worker source, not the generated agent worktree.
- `repository:<configured name>:<absolute checkout path>`.
- `reference:<configured name>:<absolute reference checkout path>`.
- `bundle:<archive SHA-256>`: the verified lowercase archive hash advertised in worker logs.

Names match the on-disk unqualified skill name exactly. One manifest entry per source/name is allowed. Repository names containing colons are not supported in approval sources. Missing, malformed or invalid manifests fail startup rather than enabling skills.

Store the manifest outside every worker source repository, workspace root, shared repository and reference repository. Canonical path containment is checked, but filesystem ownership/ACLs are not automatically enforced. The operator must protect the file AND its parent directories from agent/task-controlled writes and replacement using Windows ACLs or appropriate Unix ownership and permissions. Also protect worker_shared from task-controlled edits. Merely placing a manifest outside the workspace is not an OS security boundary.

## Paperclip bundles

ZIP integrity verification is not operator approval. Downloaded Paperclip instructions are not injected unless approved or replaced by a trusted shared Paperclip skill. Workers explicitly report when the operational bundle is unavailable. To approve it, inspect the verified extracted `.worker/skills/paperclip` directory and all helpers, obtain its directory digest with the command above, and add an entry with name `paperclip` and source `bundle:<verified archive hash>`. Approve each additional bundle skill separately. Do not silently whitelist future archive versions. Alternatively, provision a reviewed Paperclip skill in protected worker_shared. Do not let the agent copy a bundle there to grant itself trust.

## Execution and authorization

Catalog-listed trusted/approved skills may run their documented helpers and silently use existing authentication for authorized tasks, without directly inspecting or exposing credentials. Trust does not authorize external mutations, publication, deployments, switching accounts, interactive sign-in, installing dependencies or bypassing access controls. Existing publication-tool and task-authorization rules still apply. Report sanitized authentication/authorization failures; do not attempt alternate identities or leak tokens, caches or secret-store capabilities.

This is instruction policy, not a sandbox. Hashing is not an atomic execution snapshot, and mutable files introduce time-of-check/time-of-use risks. The agent must stop using any skill whose contents change after catalog resolution and request renewed approval. Arbitrary commands with process/filesystem access can bypass instruction boundaries; use OS isolation and protected mounts/ACLs if enforcement is required.

## Hosted limitations

Hosted local approval files are explicitly disabled. No trusted-provider approval transport is implemented yet; Hosted therefore supports only trusted supervisory worker_shared skills, not approvals for other sources. Do not claim Hosted bundle/repository approval support. Hosted skills cannot expand identity access: user sign-ins, authentication caches and alternate provider authentication remain prohibited. Use supplied run credentials and harness-managed identity capabilities. A provider-specific managed identity restriction takes precedence over general helper permission.

## Rollout

Regression tests use simulated sessions; they do not prove actual agent helper invocation. Before production rollout, arrange an authorized end-to-end assignment that invokes the relevant trusted skill and confirms sanitized results. Do not restart busy workers. Restarting loses process-only secret-store contents, so the operator may need to authorize and seed authentication again. Never print or persist credentials to preserve them across restart.
