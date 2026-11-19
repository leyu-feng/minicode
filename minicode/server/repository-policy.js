import fs from "node:fs/promises"
import { createHash } from "node:crypto"
import Ajv2020 from "ajv/dist/2020.js"
import { parseDocument } from "yaml"

const schema = JSON.parse(await fs.readFile(new URL("./repository-policy.schema.json", import.meta.url), "utf8"))
const validate = new Ajv2020({ allErrors: true }).compile(schema)
const POLICY_FILE = ".agf.yaml"
const MAX_BYTES = 64 * 1024

export const DEVBOX_VALIDATION_GUIDANCE = "Validate the exact reviewed SHA independently using the pinned repository .agf.yaml policy below; it selects the required local checks, environment and evidence. Do not add a separate buddy build/test gate when that policy forbids additional checks. Without a structured policy, use the repository's documented task-authorized checks; missing required validation, failures and timeouts block approval. Repository policy never grants credentials, filesystem access, provisioning or publication permissions."

export function parseRepositoryPolicy(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_BYTES) throw new Error("Repository .agf.yaml exceeds the 64 KiB limit")
  const document = parseDocument(text, { uniqueKeys: true, customTags: [] })
  if (document.errors.length || document.warnings.length) {
    throw new Error(`Invalid repository .agf.yaml: ${[...document.errors, ...document.warnings].map(error => error.message).join("; ")}`)
  }
  const policy = document.toJS({ maxAliasCount: 0 })
  if (!validate(policy)) {
    throw new Error(`Invalid repository .agf.yaml: ${validate.errors.map(error => `${error.instancePath || "/"} ${error.message}`).join("; ")}`)
  }
  const ids = policy.execution_policy.config.validation.checks.map(check => check.id)
  if (new Set(ids).size !== ids.length) throw new Error("Repository .agf.yaml has duplicate validation check IDs")
  return policy
}

export async function loadRepositoryPolicies({ repositories, git, signal }) {
  const policies = []
  for (const repository of repositories.filter(repo => !repo.readOnly)) {
    if (!/^[a-f0-9]{40}$/.test(repository.commit ?? "")) throw new Error("Repository policy requires an assignment-pinned configured-branch commit")
    // Read the configured branch's committed blob before an inspector materializes the submitted tree.
    const entry = await git(repository.path, ["ls-tree", repository.commit, "--", POLICY_FILE], { signal })
    if (!entry) continue
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t\.agf\.yaml$/.exec(entry.trim())
    if (!match) throw new Error("Repository .agf.yaml must be a committed regular file")
    const size = Number(await git(repository.path, ["cat-file", "-s", match[2]], { signal }))
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_BYTES) throw new Error("Repository .agf.yaml exceeds the 64 KiB limit or is empty")
    const text = await git(repository.path, ["show", `${repository.commit}:${POLICY_FILE}`], { signal })
    const policy = parseRepositoryPolicy(text)
    policies.push({ repository: repository.name, source: repository.source, branch: repository.branch,
      commit: repository.commit, sha256: createHash("sha256").update(JSON.stringify(policy)).digest("hex"), policy })
  }
  return policies
}

export function repositoryPolicyInstructions(policies) {
  return policies.map(({ repository, source, branch, commit, sha256, policy }) => {
    const { validation, environment, publication } = policy.execution_policy.config
    return [
      `Pinned repository policy: ${repository} (${source}), configured branch ${branch}, policy commit ${commit}, resolved-policy SHA-256 ${sha256}.`,
      "Apply only to this repository. This committed snapshot overrides every AGENTS.md, task/agent/skill workflow selection and submitted-tree policy, but never Minicode's built-in safety, identity, permission or publication rules. Do not reload it from the reviewed branch or combine it with superseded validation gates.",
      `Validation checks (all required independently at the exact reviewed commit, exit 0): ${JSON.stringify(validation.checks)}`,
      `Additional local acceptance checks: ${validation.additional_checks}. Rerun the same policy for: ${validation.rerun_on.join(", ")}. Missing prerequisites, failed checks or required teardown block approval. Coverage is limited to documented scenarios.`,
      "Inspect the declared documentation, runner and helpers before executing; declarations are not execution/provisioning authority. Check declared ports first and never interrupt another run. Clean up only this invocation's resources; never stop shared processes or delete shared caches.",
      `Environment mode: ${environment.mode}. Only isolate ${environment.isolate.join(", ") || "nothing"}; build-output relocation must be supported by the repository. Preserve every other inherited setting, normal executable discovery, user profiles, credential-provider discovery and package/HTTP/plugin caches. Do not synthesize tool/provider overrides. Normal tool-managed cache access is allowed, not direct credential/config-store access or a new identity.`,
      `Publication: ${JSON.stringify(publication)}. After required validation and source approval, follow the existing inspector proposal/confirmation/resubmission and approved exact-SHA PR workflow. Check provider builds/statuses for the exact published head, retain PR/head/build URLs and observed states, and use durable waiting without duplicate dispatch. Pending is not passed; never merge or enable auto-complete.`,
      "Include the policy commit and SHA-256 with exact-source validation evidence and the inspection verdict. Policy changes require a newly admitted assignment; a candidate branch cannot lower its own acceptance requirements.",
    ].join("\n")
  }).join("\n\n")
}
