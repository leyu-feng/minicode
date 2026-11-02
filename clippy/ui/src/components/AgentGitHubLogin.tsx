import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentPoolsApi } from "../api/agent-pools";
import { Button } from "./ui/button";

export function AgentGitHubLogin({ companyId, agentId }: { companyId?: string; agentId?: string }) {
  const client = useQueryClient();
  const queryKey = ["agent-github-login", companyId, agentId];
  const status = useQuery({
    queryKey,
    queryFn: () => agentPoolsApi.pollGitHubLogin(companyId!, agentId!),
    enabled: Boolean(companyId && agentId),
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: query => query.state.data?.state === "pending"
      ? Math.max(1000, (query.state.data.pollAfterSeconds ?? 5) * 1000) : false,
  });
  const start = useMutation({
    mutationFn: () => agentPoolsApi.startGitHubLogin(companyId!, agentId!),
    onSuccess: data => { client.setQueryData(queryKey, data); },
  });
  if (!companyId || !agentId) return <p className="text-sm text-muted-foreground">
    Save the agent to start GitHub sign-in. It cannot run until sign-in completes.
  </p>;
  const error = start.error ?? status.error;
  const pending = status.data?.state === "pending";
  return <div className="space-y-2 text-sm" aria-label="Agent GitHub sign-in">
    <p>{status.data?.message ?? "Checking this agent's GitHub sign-in..."}</p>
    {error && <p role="alert" className="text-destructive">{error.message}</p>}
    {pending && <>
      <p>Enter <strong className="select-all font-mono">{status.data?.userCode}</strong> at{" "}
        <a className="underline" href="https://github.com/login/device" target="_blank" rel="noopener noreferrer">
          github.com/login/device
        </a>. This page checks for completion automatically.</p>
    </>}
    {status.data?.state !== "connected" && !pending && <Button type="button" variant="outline"
      disabled={start.isPending || status.isPending} onClick={() => start.mutate()}>
      {start.isPending ? "Starting sign-in..." : "Sign in with GitHub"}
    </Button>}
  </div>;
}
