import { useQuery } from "@tanstack/react-query";
import { agentPoolsApi } from "../api/agent-pools";

export function HostedHarnessSelect({ companyId, poolName, value, onChange }: {
  companyId: string | null; poolName: string; value: string; onChange: (value: string) => void;
}) {
  const pools = useQuery({
    queryKey: ["agent-pools", companyId], queryFn: () => agentPoolsApi.list(companyId!),
    enabled: Boolean(companyId), refetchOnMount: false,
  });
  const pool = pools.data?.find(entry => entry.name === poolName.trim());
  const harnesses = useQuery({
    queryKey: ["agent-pools", companyId, pool?.id, "harnesses"],
    queryFn: () => agentPoolsApi.harnesses(companyId!, pool!.id),
    enabled: pool?.type === "hosted", retry: false,
  });
  if (pools.error) return <p role="alert" className="text-sm text-destructive">{pools.error.message}</p>;
  if (pool?.type !== "hosted") return null;
  if (harnesses.isPending) return <p role="status" className="text-sm text-muted-foreground">Loading hosted harnesses...</p>;
  if (harnesses.error) return <p role="alert" className="text-sm text-destructive">{harnesses.error.message}</p>;
  const available = harnesses.data.some(entry => entry.id === value);
  return <label className="block space-y-2 text-sm">
    <span>Harness</span>
    <select aria-label="Harness" value={value} onChange={event => onChange(event.target.value)}
      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
      {!available && <option value={value} disabled>{value} (unavailable)</option>}
      {harnesses.data.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
    </select>
    {!available && <span role="alert" className="text-destructive">The saved harness is no longer available. Choose one from the provider catalog.</span>}
  </label>;
}
