import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentPoolPairing, AgentPool, HostedWorkerConfig } from "@paperclipai/shared";
import { hostedWorkerConfigSchema, hostedWorkerDemandSchema } from "@paperclipai/shared";
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
  const selectedPool = pools.data?.find((pool) => pool.id === selected);
  const defaults = useQuery({ queryKey: [...key, "hosted-defaults"], queryFn: () => agentPoolsApi.defaults(companyId) });
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
  const error = pools.error || defaults.error || workers.error || create.error || pair.error || revoke.error || copy.error;
  return (
    <section className="space-y-4">
      <h2 className="text-sm font-semibold">Agent pools</h2>
      <p className="text-sm text-muted-foreground">
        Freelance pools use your own Minicode workers. Hosted pools use a managed-identity-authenticated provider.
      </p>
      {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
      <div className="flex items-center gap-2">
        <Input aria-label="New pool name" placeholder="new-pool" value={name} onChange={(e) => setName(e.target.value)} />
        <Button disabled={!name || create.isPending} onClick={() => create.mutate()}>Create pool</Button>
      </div>
      <select aria-label="Agent pool" className="rounded-md border border-border bg-background p-2 text-sm"
        value={selected} onChange={(e) => { setPoolId(e.target.value); setPairing(null); }}>
        {pools.data?.map((pool) => <option key={pool.id} value={pool.id}>{pool.name} ({pool.type === "hosted" ? "Hosted" : "Freelance"})</option>)}
      </select>
      {selectedPool && defaults.isSuccess && <PoolProviderSettings
        key={`${selectedPool.id}:${selectedPool.type}:${selectedPool.hostedPoolId ?? ""}`}
        companyId={companyId} pool={selectedPool} defaults={defaults.data}
        onChanged={() => { setPairing(null); void client.invalidateQueries({ queryKey: key }); }}
      />}
      {selectedPool?.type !== "hosted" && <>
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

function PoolProviderSettings({ companyId, pool, defaults, onChanged }: {
  companyId: string; pool: AgentPool; defaults: HostedWorkerConfig | null; onChanged: () => void;
}) {
  const [type, setType] = useState<"freelance" | "hosted">(pool.type ?? "freelance");
  const [apiUrl, setApiUrl] = useState(pool.hostedApiUrl ?? defaults?.apiUrl ?? "");
  const [audience, setAudience] = useState(pool.hostedAudience ?? defaults?.audience ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const [itemsWaiting, setItemsWaiting] = useState("0");
  const status = useQuery({
    queryKey: ["agent-pools", companyId, pool.id, "status"],
    queryFn: () => agentPoolsApi.status(companyId, pool.id),
    enabled: pool.type === "hosted", refetchInterval: 10_000, retry: false,
  });
  const repos = useQuery({
    queryKey: ["agent-pools", companyId, pool.id, "repos"],
    queryFn: () => agentPoolsApi.repositories(companyId, pool.id),
    enabled: pool.type === "hosted", retry: false,
  });
  const save = useMutation({
    mutationFn: () => agentPoolsApi.update(companyId, pool.id, type === "hosted"
      ? { type, clearPairings: true, config: { apiUrl, audience } } : { type, clearPairings: true }),
    onSettled: () => { setConfirmed(false); onChanged(); },
  });
  const report = useMutation({
    mutationFn: () => agentPoolsApi.report(companyId, pool.id, Number(itemsWaiting)),
    onSuccess: () => { void status.refetch(); },
  });
  const error = save.error || status.error || repos.error || report.error;
  const validConfig = type !== "hosted" || hostedWorkerConfigSchema.safeParse({ apiUrl, audience }).success;
  return <div className="space-y-3 rounded-md border border-border p-4">
    <label className="block space-y-2 text-sm">
      <span>Pool type</span>
      <select aria-label="Pool type" value={type} onChange={(event) => setType(event.target.value === "hosted" ? "hosted" : "freelance")}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
        <option value="freelance">Freelance</option><option value="hosted">Hosted</option>
      </select>
    </label>
    {type === "hosted" && <>
      <label className="block space-y-2 text-sm"><span>Provider API URL</span>
        <Input aria-label="Provider API URL" value={apiUrl} placeholder="https://engsys.example/v1/hosted-worker"
          onChange={(event) => setApiUrl(event.target.value)} /></label>
      <label className="block space-y-2 text-sm"><span>Provider token audience</span>
        <Input aria-label="Provider token audience" value={audience} placeholder="api://provider"
          onChange={(event) => setAudience(event.target.value)} /></label>
      <p className="text-xs text-muted-foreground">Clippy uses its managed identity. Saving creates or reconnects the provider pool and tests status and repositories.</p>
    </>}
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
      Clear all existing worker pairings and disconnect running workers.
    </label>
    <div className="flex items-center justify-between gap-2">
      <Button variant="outline" onClick={() => {
        setType(pool.type ?? "freelance"); setApiUrl(pool.hostedApiUrl ?? defaults?.apiUrl ?? "");
        setAudience(pool.hostedAudience ?? defaults?.audience ?? ""); setConfirmed(false);
      }}>Cancel</Button>
      <Button disabled={!confirmed || !validConfig || save.isPending} onClick={() => save.mutate()}>
        {type === "hosted" ? "Save and test Hosted pool" : "Save Freelance pool"}
      </Button>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
    {pool.type === "hosted" && <>
      <p className="text-xs text-muted-foreground">Provider pool: {pool.hostedPoolId ?? "Not provisioned; save to retry"}</p>
      {status.data && <p className="text-sm">
        {status.data.isMock ? "Mock capacity" : "Provider capacity"}: {status.data.activeWorkers} active, {status.data.provisioningWorkers} provisioning.
        {status.data.isMock && " These counts do not represent connected workers or provision compute."}
      </p>}
      {repos.data && <p className="text-sm">Available repositories: {repos.data.map((repo) =>
        `${repo.name} (${repo.branch})${repo.isDefault ? " [default]" : ""}`).join(", ")}. Select a primary and references on each agent.</p>}
      <div className="flex items-center gap-2">
        <Input aria-label="Tasks waiting" type="number" min="0" step="1" value={itemsWaiting}
          onChange={(event) => setItemsWaiting(event.target.value)} />
        <Button variant="outline" disabled={itemsWaiting.trim() === "" || report.isPending
          || !hostedWorkerDemandSchema.safeParse({ itemsWaiting: Number(itemsWaiting) }).success}
          onClick={() => report.mutate()}>Report backlog</Button>
      </div>
    </>}
  </div>;
}
