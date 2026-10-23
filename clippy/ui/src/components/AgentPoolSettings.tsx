import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentPoolPairing, AgentPool } from "@paperclipai/shared";
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
  const [workerFilter, setWorkerFilter] = useState("active");
  const copy = useMutation({ mutationFn: copyTextToClipboard });
  const key = ["agent-pools", companyId];
  const pools = useQuery({ queryKey: key, queryFn: () => agentPoolsApi.list(companyId) });
  const selected = poolId || pools.data?.find((pool) => pool.name === "default")?.id || "";
  const selectedPool = pools.data?.find((pool) => pool.id === selected);
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
  const visibleWorkers = workers.data?.filter((worker) => {
    if (workerFilter === "all") return true;
    if (workerFilter === "revoked") return worker.revoked;
    if (worker.revoked) return false;
    const active = worker.paired && (worker.status === "idle" || worker.status === "busy");
    return workerFilter === "active" ? active : !active;
  });
  const error = pools.error || workers.error || create.error || pair.error || revoke.error || copy.error;
  return (
    <section className="space-y-4">
      <h2 className="text-sm font-semibold">Agent pools</h2>
      <p className="text-sm text-muted-foreground">
        The default Hosted pool uses the built-in agent host. Create Devbox pools for your own Minicode workers.
        Pool types cannot be changed.
      </p>
      {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
      <div className="flex items-center gap-2">
        <Input aria-label="New pool name" placeholder="new-pool" value={name} onChange={(e) => setName(e.target.value)} />
        <Button disabled={!name || create.isPending} onClick={() => create.mutate()}>Create pool</Button>
      </div>
      <select aria-label="Agent pool" className="rounded-md border border-border bg-background p-2 text-sm"
        value={selected} onChange={(e) => { setPoolId(e.target.value); setPairing(null); }}>
        {pools.data?.map((pool) => <option key={pool.id} value={pool.id}>{pool.name} ({pool.type === "hosted" ? "Hosted" : "Devbox"})</option>)}
      </select>
      {selectedPool?.type === "hosted" && <HostedPoolStatus key={selectedPool.id} companyId={companyId} pool={selectedPool} />}
      {selectedPool?.type === "devbox" && selectedPool.name !== "default" && <>
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
      </>}
      <label className="block space-y-2 text-sm">
        <span>Workers</span>
        <select aria-label="Worker filter" value={workerFilter} onChange={(event) => setWorkerFilter(event.target.value)}
          className="rounded-md border border-border bg-background p-2 text-sm">
          <option value="active">Active workers</option>
          <option value="disconnected">Disconnected workers</option>
          <option value="revoked">Revoked workers</option>
          <option value="all">All workers</option>
        </select>
      </label>
      {workers.isSuccess && visibleWorkers?.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {workerFilter === "active" ? "No active workers connected." : "No workers match this filter."}
        </p>
      )}
      {visibleWorkers?.map((worker) => (
        <div key={worker.id} className="flex items-center justify-between gap-2 text-sm">
          <span>{worker.name}: {worker.revoked ? "revoked" : worker.paired ? worker.status : "awaiting pairing"}</span>
          {!worker.revoked && <Button variant="outline" disabled={revoke.isPending}
            onClick={() => revoke.mutate(worker.id)}>Revoke</Button>}
        </div>
      ))}
    </section>
  );
}

function HostedPoolStatus({ companyId, pool }: {
  companyId: string; pool: AgentPool;
}) {
  const status = useQuery({
    queryKey: ["agent-pools", companyId, pool.id, "status"],
    queryFn: () => agentPoolsApi.status(companyId, pool.id),
    refetchInterval: 10_000, retry: false,
  });
  const repos = useQuery({
    queryKey: ["agent-pools", companyId, pool.id, "repos"],
    queryFn: () => agentPoolsApi.repositories(companyId, pool.id),
    retry: false,
  });
  const error = status.error || repos.error;
  return <div className="space-y-3 rounded-md border border-border p-4">
    <p className="text-sm text-muted-foreground">
      The built-in agent host is connected through deployment environment settings. Capacity is requested automatically as tasks wait.
    </p>
    {error && <div className="space-y-2">
      <p role="alert" className="text-sm text-destructive">{error.message}</p>
      <Button variant="outline" disabled={status.isFetching || repos.isFetching}
        onClick={() => { void status.refetch(); void repos.refetch(); }}>Retry Hosted connection</Button>
    </div>}
    {status.data && <p className="text-sm">
      {status.data.isMock ? "Mock capacity" : "Provider capacity"}: {status.data.activeWorkers} active, {status.data.provisioningWorkers} provisioning.
      {status.data.isMock && " These counts do not represent connected workers or provision compute."}
    </p>}
    {repos.data && <p className="text-sm">Available repositories: {repos.data.map((repo) =>
      `${repo.name} (${repo.branch})${repo.isDefault ? " [default]" : ""}`).join(", ")}. Select a primary and references on each agent.</p>}
  </div>;
}
