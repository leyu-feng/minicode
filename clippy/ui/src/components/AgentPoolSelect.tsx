import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { agentPoolNameSchema, type AgentPool } from "@paperclipai/shared";
import { agentPoolsApi } from "../api/agent-pools";
import { ApiError } from "../api/client";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { HostedRepositorySelect } from "./HostedRepositorySelect";

type PoolMode = "existing" | "new";

export function useAgentPoolSelection({
  companyId,
  name,
  onNameChange,
  enabled,
  initialMode = null,
}: {
  companyId: string | null;
  name: string;
  onNameChange: (name: string) => void;
  enabled: boolean;
  initialMode?: PoolMode | null;
}) {
  const cache = useQueryClient();
  const [modeChoice, setModeChoice] = useState(initialMode);
  const [primaryRepositoryId, setPrimaryRepositoryId] = useState<string>();
  const [referenceRepositoryIds, setReferenceRepositoryIds] = useState<string[]>([]);
  const resetRepositories = () => { setPrimaryRepositoryId(undefined); setReferenceRepositoryIds([]); };
  const key = ["agent-pools", companyId];
  const pools = useQuery({
    queryKey: key,
    queryFn: () => agentPoolsApi.list(companyId!),
    enabled: Boolean(companyId) && enabled,
    retry: false,
  });
  const existing = pools.data?.find((pool) => pool.name === name.trim());
  const mode = modeChoice ?? (existing ? "existing" : "new");
  const duplicate = mode === "new" && Boolean(existing);
  const validName = agentPoolNameSchema.safeParse(name).success;
  const repositoryConfig: { primaryRepositoryId?: string; referenceRepositoryIds?: string[] } = existing?.type === "hosted"
    ? { ...(primaryRepositoryId ? { primaryRepositoryId } : {}), referenceRepositoryIds } : {};
  return {
    pools, name, mode, modeChoice, duplicate, companyId,
    repositoryConfig,
    setRepositories: (primaryId: string, referenceIds: string[]) => {
      setPrimaryRepositoryId(primaryId); setReferenceRepositoryIds(referenceIds);
    },
    ready: pools.isSuccess && validName && (mode === "existing" ? Boolean(existing) : !duplicate),
    reset: () => { setModeChoice(null); resetRepositories(); },
    changeName: (value: string) => { resetRepositories(); onNameChange(value); },
    select: (value: string) => {
      setModeChoice(value === "__new__" ? "new" : "existing");
      const nextName = value === "__new__" ? "" : value;
      if (nextName !== name.trim()) {
        resetRepositories();
        onNameChange(nextName);
      }
    },
    async ensurePool() {
      if (!companyId || !pools.isSuccess) throw new Error("Load the company pools before creating the agent.");
      if (!validName) throw new Error("Enter a pool name of 1-64 lowercase letters, numbers, underscores or hyphens, starting with a letter or number.");
      if (mode === "existing") {
        if (!existing) throw new Error("Select an existing pool or create a new one.");
        return existing;
      }
      if (duplicate) throw new Error("A pool with that name already exists. Select it to reuse it or choose a unique name.");
      let pool: AgentPool;
      try {
        pool = await agentPoolsApi.create(companyId, name.trim());
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          await cache.invalidateQueries({ queryKey: key });
        }
        throw error;
      }
      cache.setQueryData<AgentPool[]>(key,
        (current = []) => [...current.filter((entry) => entry.id !== pool.id), pool]);
      return pool;
    },
  };
}

export function AgentPoolSelect({
  selection,
  onSubmit,
}: {
  selection: ReturnType<typeof useAgentPoolSelection>;
  onSubmit?: () => void;
}) {
  const { pools, name, mode, duplicate } = selection;
  return (
    <div className="space-y-3">
      {pools.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">Loading pools...</p>
      ) : pools.isError ? (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive">{pools.error.message}</p>
          <Button type="button" variant="outline" onClick={() => void pools.refetch()}>Retry loading pools</Button>
        </div>
      ) : (
        <>
          <label className="block space-y-2 text-sm">
            <span>Agent pool</span>
            <select
              aria-label="Agent pool"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={mode === "new" ? "__new__" : pools.data?.some((pool) => pool.name === name.trim()) ? name.trim() : ""}
              onChange={(event) => selection.select(event.target.value)}
            >
              <option value="" disabled>Select an existing pool</option>
              {pools.data?.map((pool) => <option key={pool.id} value={pool.name}>{pool.name} ({pool.type === "hosted" ? "Hosted" : "Devbox"})</option>)}
              <option value="__new__">Create a new Devbox pool</option>
            </select>
          </label>
          {mode === "new" && (
            <>
              <label className="block space-y-2 text-sm">
                <span>New pool name</span>
                <Input
                  aria-label="Pool name"
                  placeholder="new-pool"
                  value={name}
                  onChange={(event) => selection.changeName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && onSubmit) {
                      event.preventDefault();
                      if (selection.ready) onSubmit();
                    }
                  }}
                />
              </label>
              <p className="text-xs text-muted-foreground">
                New pools are always Devbox. Use a unique name: 1-64 lowercase letters, numbers, underscores or hyphens, starting with a letter or number.
              </p>
              {duplicate && (
                <p role="alert" className="text-sm text-destructive">
                  A pool with that name already exists. Select it above to reuse it or choose a unique name.
                </p>
              )}
            </>
          )}
        </>
      )}
      <p className="text-xs text-muted-foreground">
        No connected worker is required to save this agent. New pools are saved with the agent.
        Devbox pools need a paired Minicode worker. The default Hosted pool uses the built-in agent host, requests capacity and waits up to two minutes
        for a real worker; mock provider counts do not make a worker available.
      </p>
      {mode === "existing" && <HostedRepositorySelect companyId={selection.companyId} poolName={name}
        primaryId={selection.repositoryConfig.primaryRepositoryId} referenceIds={selection.repositoryConfig.referenceRepositoryIds ?? []}
        onChange={selection.setRepositories} />}
    </div>
  );
}
