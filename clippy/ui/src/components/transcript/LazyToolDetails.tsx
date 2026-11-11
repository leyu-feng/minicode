import { useEffect, useState } from "react";
import { runToolDetailRefSchema, type RunToolDetailPage, type RunToolDetailRef } from "@paperclipai/shared";
import { heartbeatsApi } from "../../api/heartbeats";
import { Button } from "../ui/button";

function ToolDetailPart({ reference, preview = false }: { reference: RunToolDetailRef; preview?: boolean }) {
  const [page, setPage] = useState<RunToolDetailPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [controller, setController] = useState<AbortController | null>(null);

  async function load(offset: number, signal: AbortSignal) {
    setLoading(true);
    setError(null);
    try {
      const next = await heartbeatsApi.toolDetail(reference, offset, { signal });
      if (signal.aborted) return;
      setPage(previous => offset === 0 || !previous ? next : {
        ...next,
        input: (previous.input ?? "") + (next.input ?? ""),
        output: (previous.output ?? "") + (next.output ?? ""),
        error: (previous.error ?? "") + (next.error ?? ""),
      });
    } catch (failure) {
      if (!signal.aborted) setError(failure instanceof Error ? failure.message : "Tool details could not be loaded.");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    const request = new AbortController();
    setController(request);
    setPage(null);
    void load(0, request.signal);
    return () => request.abort();
  }, [reference.runId, reference.chunkId]);

  return (
    <div className="space-y-2">
      {page?.status === "available" && <>
        {page.cwd && <div className="font-mono text-xs text-muted-foreground">{page.cwd}</div>}
        {(["input", "output", "error"] as const).map(field => (!preview || field === "input") && page[field] !== undefined && (
          <div key={field}>
            <div className="text-xs font-semibold text-muted-foreground">{field === "input" ? "Input" : field === "output" ? "Output" : "Error"}</div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-foreground">{page[field] || "<empty>"}</pre>
          </div>
        ))}
        {page.truncated && <p className="text-xs text-muted-foreground">Tool details were truncated at the capture limit.</p>}
      </>}
      {page?.status === "expired" && <p className="text-xs text-muted-foreground">Tool details have expired.</p>}
      {page?.status === "unavailable" && <p className="text-xs text-muted-foreground">Tool details are unavailable.</p>}
      {loading && <p role="status" className="text-xs text-muted-foreground">Loading tool details...</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {preview && page?.nextOffset !== undefined && <p className="text-xs">Expand the tool to read the remaining details.</p>}
      {!loading && controller && (error || !preview && page?.nextOffset !== undefined) && (
        <Button variant="ghost" size="sm" onClick={() => void load(page?.nextOffset ?? 0, controller.signal)}>
          {error ? "Retry loading details" : "Load more"}
        </Button>
      )}
    </div>
  );
}

export function LazyToolDetails({ input, preview = false }: { input: Record<string, unknown>; preview?: boolean }) {
  const references = (preview ? [input.startDetailRef ?? input.endDetailRef] : [input.startDetailRef, input.endDetailRef])
    .map(value => runToolDetailRefSchema.safeParse(value))
    .flatMap(result => result.success ? [result.data] : []);
  return (
    <div className="space-y-3">
      {(input.detailsUnavailable || references.length === 0) && (
        <p className="text-xs text-muted-foreground">Some tool details were not retained or could not be uploaded.</p>
      )}
      {references.map(reference => <ToolDetailPart key={reference.chunkId} reference={reference} preview={preview} />)}
      {!preview && input.endDetailRef === undefined && <p className="text-xs text-muted-foreground">Waiting for result...</p>}
    </div>
  );
}
