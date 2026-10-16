import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentPoolPairing } from "@paperclipai/shared";
import { agentPoolsApi } from "../api/agent-pools";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { copyTextToClipboard } from "../lib/clipboard";

export function AgentPoolSettings({ companyId }: { companyId: string }) {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [poolId, setPoolId] = useState("");
  const [workerName, setWorkerName] = useState("");
  const [pairing, setPairing] = useState<AgentPoolPairing | null>(null);
  const copy = useMutation({ mutationFn: copyTextToClipboard });
  const key = ["agent-pools", companyId];
  const pools = useQuery({ queryKey: key, queryFn: () => agentPoolsApi.list(companyId) });
  const selected = poolId || pools.data?.find((pool) => pool.name === "default")?.id || "";
  const workers = useQuery({
    queryKey: [...key, selected, "workers"], queryFn: () => agentPoolsApi.workers(companyId, selected),
    enabled: Boolean(selected), refetchInterval: 5000,
  });
  const create = useMutation({
    mutationFn: () => agentPoolsApi.create(companyId, name),
    onSuccess: (pool) => { setName(""); setPoolId(pool.id); void client.invalidateQueries({ queryKey: key }); },
  });
  const pair = useMutation({
    mutationFn: () => agentPoolsApi.pair(companyId, selected, workerName),
    onSuccess: (result) => {
      setPairing(result); setWorkerName(""); copy.reset(); void client.invalidateQueries({ queryKey: key });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => agentPoolsApi.revoke(companyId, selected, id),
    onSuccess: () => { void client.invalidateQueries({ queryKey: key }); },
  });
  const error = pools.error || workers.error || create.error || pair.error || revoke.error || copy.error;
  return (
    <section className="space-y-4">
      <h2 className="text-sm font-semibold">AgentPool workers</h2>
      <p className="text-sm text-muted-foreground">
        Agents select a pool by name. Each connected Minicode worker runs one task at a time on its own machine.
      </p>
      {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
      <div className="flex items-center gap-2">
        <Input aria-label="New pool name" placeholder="new-pool" value={name} onChange={(e) => setName(e.target.value)} />
        <Button disabled={!name || create.isPending} onClick={() => create.mutate()}>Create pool</Button>
      </div>
      <select aria-label="Agent pool" className="rounded-md border border-border bg-background p-2 text-sm"
        value={selected} onChange={(e) => { setPoolId(e.target.value); setPairing(null); }}>
        {pools.data?.map((pool) => <option key={pool.id} value={pool.id}>{pool.name}</option>)}
      </select>
      <div className="flex items-center gap-2">
        <Input aria-label="Worker name" placeholder="Worker name" value={workerName}
          onChange={(e) => setWorkerName(e.target.value)} />
        <Button disabled={!selected || !workerName || pair.isPending} onClick={() => pair.mutate()}>Pair worker</Button>
      </div>
      {pairing && (
        <div className="space-y-2 rounded-md border border-border p-4 text-sm">
          <p>One-time pairing token (expires {new Date(pairing.expiresAt).toLocaleTimeString()}). Keep it private.</p>
          <p>On the worker, set MINICODE_AGENT_POOL_PAIRING_TOKEN to the token below, then run:</p>
          <code className="block break-all">
            minicode worker --server {window.location.origin} --worker-id {pairing.workerId} --repo-root &lt;local-directory&gt;
          </code>
          <Input aria-label="Pairing token" readOnly type="password" value={pairing.serverToken} />
          <Button variant="outline" disabled={copy.isPending} onClick={() => copy.mutate(pairing.serverToken)}>
            {copy.isSuccess ? "Copied token" : "Copy token"}
          </Button>
          <Button variant="outline" onClick={() => setPairing(null)}>Dismiss token</Button>
        </div>
      )}
      {workers.data?.map((worker) => (
        <div key={worker.id} className="flex items-center justify-between gap-2 text-sm">
          <span>{worker.name}: {worker.revoked ? "revoked" : worker.paired ? worker.status : "awaiting pairing"}</span>
          {!worker.revoked && <Button variant="outline" disabled={revoke.isPending}
            onClick={() => revoke.mutate(worker.id)}>Revoke</Button>}
        </div>
      ))}
    </section>
  );
}
