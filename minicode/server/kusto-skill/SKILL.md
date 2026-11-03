---
name: kusto
description: Query a remote Kusto cluster directly using a token supplied by the worker host managed identity.
---

# Kusto

Use for an authorized task requiring Kusto access. This platform-provided
skill gets a Kusto token from the assignment-scoped worker host API and uses it to
query Kusto directly. It does not use personal MCP credentials or Azure CLI.

Take the cluster URI and database from the authorized task or operator-supplied
configuration. No cluster, database, table or service is preconfigured.

Save KQL in a file inside a writable assigned repository, then run the
`query.ps1` helper beside this SKILL.md:

```powershell
pwsh -NoProfile -File '<skill-directory>/query.ps1' -ClusterUri '<https-cluster-origin>' -Database '<database>' -QueryFile '<workspace-query-file>'
```

The helper obtains a fresh token as needed for each invocation, holds it only in
process memory, and sends the query directly to the supplied cluster. For schema
discovery use `<table> | getschema` on a task-specified table; inspect the actual
schema before writing aggregations.
Apply explicit time filters, aggregate before returning data, and project only
the columns needed. Results are limited to 1,000 rows and 1 MiB.

The token API accepts POST `{}` at
`WORKER_KUSTO_TOKEN_URL`, authenticated with the bearer capability in
`WORKER_KUSTO_TOKEN_CAPABILITY`. Its response contains `accessToken`, `tokenType`,
and `expiresOn`. It requests the public Azure Kusto service audience, not a
specific cluster or database. Custom helpers may consume this
response in memory for authorized Kusto reads; never print it.

Never put tokens or capability values in prompts, command arguments, output,
files, task comments, or commits. Do not dump the environment. The API expires
with the assignment; an issued Entra token has its own expiration and is not
revoked by task completion. Its permissions are those of the worker identity,
not per-agent or per-task ADX permissions. Access to each remote cluster is
determined by that cluster's permissions for the identity. Sovereign clouds with
different service audiences are not selected automatically.

On token failure or Kusto 401/403, report the sanitized status and request the
required worker identity database permission. Do not install tools, change identities or
try alternate authentication. Treat partial failures, truncation and warnings
as incomplete evidence, never as a complete top-N result.
