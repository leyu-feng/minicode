import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import test from "node:test"
import { stringify } from "yaml"
import { loadRepositoryPolicies, parseRepositoryPolicy, repositoryPolicyInstructions } from "../server/repository-policy.js"

const example = await fs.readFile(new URL("./fixtures/repository-policy.agf.yaml", import.meta.url), "utf8")
const execFileAsync = promisify(execFile)

test("repository-policy profile validates structured gates and rejects ambiguous or unsupported settings", () => {
  const parsed = parseRepositoryPolicy(example)
  assert.equal(parsed.execution_policy.config.validation.additional_checks, "forbid")
  for (const change of [
    value => { value.execution_policy.config.validation.additional_cheks = "forbid" },
    value => { value.execution_policy.config.environment.isolate.push("DOTNET_CLI_HOME") },
    value => { value.execution_policy.config.environment.mode = "isolated" },
    value => { value.execution_policy.config.scope = "hosted" },
    value => { value.interface.input.type = "not-a-schema-type" },
    value => { value.execution_policy.config.publication.merge = "automatic" },
    value => { value.execution_policy.config.validation.checks[0].documentation = ["..\\outside.md"] },
    value => { value.execution_policy.config.validation.checks.push(structuredClone(value.execution_policy.config.validation.checks[0])) },
    value => { value.schema_version = "2.0.0" },
  ]) {
    const invalid = structuredClone(parsed)
    change(invalid)
    assert.throws(() => parseRepositoryPolicy(stringify(invalid)), /Invalid repository|duplicate validation/)
  }
  assert.throws(() => parseRepositoryPolicy(example.replace("mode: inherit", "mode: inherit\n      mode: isolated")), /Invalid repository/)
  assert.throws(() => parseRepositoryPolicy("x".repeat(65537)), /64 KiB/)
  assert.throws(() => parseRepositoryPolicy("a: &a [1]\nb: *a"), /alias|Alias/)
})

test("policies come from the configured committed revision, not candidate or uncommitted policy", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "repository-policy-"))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const git = async (cwd, args) => (await execFileAsync("git", args, { cwd, windowsHide: true })).stdout.trim()
  await git(directory, ["init", "--initial-branch=main"])
  await fs.writeFile(path.join(directory, ".agf.yaml"), example)
  await git(directory, ["add", ".agf.yaml"])
  await git(directory, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "Approved policy"])
  const commit = await git(directory, ["rev-parse", "HEAD"])
  await fs.writeFile(path.join(directory, ".agf.yaml"), "not a policy")
  await git(directory, ["add", ".agf.yaml"])
  await git(directory, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "Candidate changes policy"])
  await fs.writeFile(path.join(directory, ".agf.yaml"), "uncommitted replacement")
  const [policy] = await loadRepositoryPolicies({ repositories: [{ name: "example", source: "https://example.test/repo", path: directory, branch: "main", commit }], git })
  assert.equal(policy.commit, commit)
  assert.equal(policy.policy.execution_policy.config.validation.checks[0].id, "integration")
  assert.match(policy.sha256, /^[a-f0-9]{64}$/)
  const instructions = repositoryPolicyInstructions([policy])
  assert.match(instructions, /overrides every AGENTS.md/)
  assert.match(instructions, /never Minicode's built-in safety/)
  assert.match(instructions, /Additional local acceptance checks: forbid/)
  assert.match(instructions, /Only isolate TEMP, TMP, build_outputs, logs/)
  assert.match(instructions, /Pending is not passed/)
  assert.doesNotMatch(instructions, /change-aware buddy|Build-LeafProjects/)
})

test("missing policy is optional but linked, oversized and invalid committed policies fail closed", async () => {
  const repositories = [{ name: "example", path: "fixture", commit: "a".repeat(40) }]
  assert.deepEqual(await loadRepositoryPolicies({ repositories, git: async () => "" }), [])
  await assert.rejects(loadRepositoryPolicies({ repositories, git: async () => `120000 blob ${"b".repeat(40)}\t.agf.yaml` }), /regular file/)
  await assert.rejects(loadRepositoryPolicies({ repositories, git: async (_, args) => args[0] === "ls-tree"
    ? `100644 blob ${"b".repeat(40)}\t.agf.yaml` : "65537" }), /64 KiB/)
  await assert.rejects(loadRepositoryPolicies({ repositories, git: async (_, args) => args[0] === "ls-tree"
    ? `100644 blob ${"b".repeat(40)}\t.agf.yaml` : args[0] === "cat-file" ? "10" : "invalid" }), /Invalid repository/)
})
