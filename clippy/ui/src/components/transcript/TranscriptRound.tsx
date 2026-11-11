import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronRight, CircleAlert, LoaderCircle, Minus } from "lucide-react";
import { runRoundSummarySchema } from "@paperclipai/shared";
import { formatDurationMs } from "../../lib/utils";

export interface RoundBlock {
  type: "round";
  ts: string;
  startTs: string;
  endTs?: string;
  executionId: string;
  harness: string;
  round?: number;
  status: "running" | "completed" | "failed" | "cancelled" | "unknown";
  lines: string[];
}

export function parseRoundLine(text: string) {
  const candidate = text.replace(/^\[[^\]\r\n]+\]\s*/, "").trim();
  if (candidate.startsWith('{"type":"clippy.round"')) {
    try {
      const parsed = runRoundSummarySchema.safeParse(JSON.parse(candidate));
      return parsed.success ? parsed.data : null;
    } catch { return null; }
  }
  const round = text.trim().match(/^(>>|<<)\s+\[([^\]]+)\]\s+Round (\d+) (start|end)(?:\s*\|\s*(.+))?$/);
  if (round) return {
    executionId: "legacy", harness: round[2], round: Number(round[3]),
    action: round[4] === "start" ? "round_start" as const : "round_end" as const,
    summary: text,
    status: /failed|timed out/.test(round[5] ?? "") ? "failed" as const
      : /cancelled/.test(round[5] ?? "") ? "cancelled" as const : "completed" as const,
  };
  const request = text.trim().match(/^\[([^\]]+)\]\s+# Model request \d+: .+$/);
  return request ? { executionId: "legacy", harness: request[1], action: "model_request" as const, summary: text } : null;
}

export function TranscriptRound({ block }: { block: RoundBlock }) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (block.status !== "running") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [block.status]);
  const failed = block.status === "failed";
  const status = block.status === "running" ? "Running"
    : block.status === "completed" ? "Completed" : failed ? "Failed"
      : block.status === "cancelled" ? "Cancelled" : "Status unknown";
  const Icon = block.status === "running" ? LoaderCircle : failed ? CircleAlert
    : block.status === "completed" ? Check : Minus;
  const elapsed = Math.max(0, (block.endTs ? Date.parse(block.endTs) : now) - Date.parse(block.startTs));
  return (
    <div className={failed ? "text-destructive" : "text-muted-foreground"}>
      <button type="button" className="flex min-h-5 w-full items-center gap-1 text-left text-xs"
        aria-expanded={failed || open} onClick={() => setOpen(value => !value)}>
        <span className="h-px flex-1 bg-border" />
        <Icon className={block.status === "running" ? "h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" : "h-3.5 w-3.5 shrink-0"} />
        <span>{block.round ? `Round ${block.round}` : "Model request"} · {block.harness} · {status}</span>
        {(block.status === "running" || block.endTs) && <span className="font-mono">{formatDurationMs(elapsed)}</span>}
        <span className="h-px flex-1 bg-border" />
        {failed || open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
      </button>
      {(failed || open) && <pre className="overflow-x-auto whitespace-pre-wrap break-words pl-5 font-mono text-xs">{block.lines.join("\n")}</pre>}
    </div>
  );
}
