import { useQuery } from "@tanstack/react-query";
import { agentPoolsApi } from "../api/agent-pools";

export function HostedRepositorySelect({ companyId, poolName, primaryId, referenceIds, onChange }: {
  companyId: string | null;
  poolName: string;
  primaryId?: string;
  referenceIds: string[];
  onChange: (primaryId: string, referenceIds: string[]) => void;
}) {
  const pools = useQuery({
    queryKey: ["agent-pools", companyId], queryFn: () => agentPoolsApi.list(companyId!),
    enabled: Boolean(companyId), refetchOnMount: false,
  });
  const pool = pools.data?.find((entry) => entry.name === poolName.trim());
  const repos = useQuery({
    queryKey: ["agent-pools", companyId, pool?.id, "repos"],
    queryFn: () => agentPoolsApi.repositories(companyId!, pool!.id), enabled: pool?.type === "hosted", retry: false,
  });
  if (pools.error) return <p role="alert" className="text-sm text-destructive">{pools.error.message}</p>;
  if (pool?.type !== "hosted") return null;
  if (repos.isPending) return <p role="status" className="text-sm text-muted-foreground">Loading hosted repositories...</p>;
  if (repos.error) return <p role="alert" className="text-sm text-destructive">{repos.error.message}</p>;
  if (repos.data.every(repo => repo.workspaceMode === "all_repositories")) return <div className="space-y-2 text-sm">
    <p>Hosted assignments start above all configured repositories. No primary repository selection is needed.</p>
    <p>{repos.data.map(repo => `${repo.name} (${repo.branch}, ${repo.readOnly ? "read-only" : "writable"})`).join("; ")}</p>
    <p className="text-muted-foreground">AgentAcademy is available as worker_shared. Operators manage this shared catalog in Engsys.</p>
  </div>;
  const selected = primaryId ?? repos.data.find((repo) => repo.isDefault)?.id ?? "";
  const invalid = !repos.data.some((repo) => repo.id === selected)
    || referenceIds.some((id) => id === selected || !repos.data.some((repo) => repo.id === id));
  return <div className="space-y-3">
    <label className="block space-y-2 text-sm"><span>Primary repository</span>
      <select aria-label="Primary repository" value={selected}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        onChange={(event) => onChange(event.target.value, referenceIds.filter((id) => id !== event.target.value))}>
        {repos.data.map((repo) => <option key={repo.id} value={repo.id}>
          {repo.name} ({repo.branch}){repo.isDefault ? " - default" : ""}
        </option>)}
      </select>
    </label>
    <fieldset className="space-y-2"><legend className="text-sm">Read-only reference repositories</legend>
      {repos.data.filter((repo) => repo.id !== selected).map((repo) =>
        <label key={repo.id} className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={referenceIds.includes(repo.id)} onChange={(event) =>
            onChange(selected, event.target.checked ? [...referenceIds, repo.id] : referenceIds.filter((id) => id !== repo.id))} />
          {repo.name} ({repo.branch})
        </label>)}
    </fieldset>
    {invalid && <p role="alert" className="text-sm text-destructive">The saved repositories are no longer available. Choose repositories from this catalog.</p>}
  </div>;
}
