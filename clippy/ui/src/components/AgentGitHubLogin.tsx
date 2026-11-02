import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentPoolsApi } from "../api/agent-pools";
import { formatDateTime } from "../lib/utils";
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
      ? Math.max(1000, (query.state.data.pollAfterSeconds ?? 5) * 1000)
      : query.state.data?.state === "connected" ? 60_000 : false,
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
  const connected = status.data?.state === "connected";
  return <div className="space-y-2 text-sm" aria-label="Agent GitHub sign-in">
    <p>{status.data?.message ?? "Checking this agent's GitHub sign-in..."}</p>
    {error && <p role="alert" className="text-destructive">{error.message}</p>}
    {(connected || status.data?.refreshExpiresAt) && <>
      <dl className="space-y-1">
        <div className="flex flex-wrap gap-2">
          <dt className="text-muted-foreground">GitHub account</dt>
          <dd className="font-mono">{status.data?.account ? `@${status.data.account.login}` : "Not recorded for this sign-in"}</dd>
        </div>
        <div className="flex flex-wrap gap-2">
          <dt className="text-muted-foreground">Signed in</dt>
          <dd className="font-mono">{status.data?.signedInAt
            ? <time dateTime={status.data.signedInAt}>{formatDateTime(status.data.signedInAt)}</time>
            : "Not recorded for this sign-in"}</dd>
        </div>
        <div className="flex flex-wrap gap-2">
          <dt className="text-muted-foreground">Refresh token expires</dt>
          <dd className="font-mono">{status.data?.refreshExpiresAt
            ? <time dateTime={status.data.refreshExpiresAt}>{formatDateTime(status.data.refreshExpiresAt)}</time>
            : "Not recorded for this sign-in"}</dd>
        </div>
      </dl>
      <p className="text-muted-foreground">Access tokens refresh automatically. Refresh-token rotation can extend this deadline. Sign in again if the refresh token expires or GitHub revokes access.</p>
    </>}
    {pending && <>
      <p>Enter <strong className="select-all font-mono">{status.data?.userCode}</strong> at{" "}
        <a className="underline" href="https://github.com/login/device" target="_blank" rel="noopener noreferrer">
          github.com/login/device
        </a>. This page checks for completion automatically.</p>
    </>}
    {!pending && <Button type="button" variant="outline"
      disabled={start.isPending || status.isPending} onClick={() => start.mutate()}>
      {start.isPending ? "Starting sign-in..." : connected || status.data?.state === "expired" ? "Sign in again" : "Sign in with GitHub"}
    </Button>}
  </div>;
}
