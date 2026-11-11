import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { RunMessageSummary } from "@paperclipai/shared";
import { heartbeatsApi } from "../../api/heartbeats";
import { MarkdownBody, type MarkdownExternalReferenceMap } from "../MarkdownBody";
import { Button } from "../ui/button";

export interface MessageExpansion {
  open: boolean;
  revision: number;
}

function plainTextParts(text: string): Array<{ text: string; json: boolean }> {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const parts: Array<{ text: string; json: boolean }> = [];
  const unprefix = (line: string) => line.replace(/^\[(?:prep|framework|pi|opencode|copilot|claude|codex)\]\s*/i, "").trim();
  for (let index = 0; index < lines.length; index++) {
    let value = lines[index];
    let json = false;
    const first = unprefix(value);
    if (/^(?:```(?:json)?\s*$|[\[{])/.test(first)) {
      const fenced = first.startsWith("```");
      const candidate: string[] = [];
      let depth = 0;
      let quoted = false;
      let escaped = false;
      let end = index + (fenced ? 1 : 0);
      for (; end < lines.length; end++) {
        const line = unprefix(lines[end]);
        if (fenced && line === "```") break;
        candidate.push(line);
        if (fenced) continue;
        for (const character of line) {
          if (escaped) escaped = false;
          else if (quoted && character === "\\") escaped = true;
          else if (character === '"') quoted = !quoted;
          else if (!quoted && (character === "{" || character === "[")) depth++;
          else if (!quoted && (character === "}" || character === "]")) depth--;
        }
        if (depth <= 0) break;
      }
      if (end < lines.length) {
        try {
          const parsed: unknown = JSON.parse(candidate.join("\n"));
          json = parsed !== null && typeof parsed === "object";
        } catch {
          // Non-JSON prose and incomplete streamed payloads stay visible.
        }
        value = lines.slice(index, end + 1).join("");
        index = end;
      } else {
        value = lines.slice(index).join("");
        index = lines.length;
      }
    }
    const previous = parts.at(-1);
    if (!json && previous && !previous.json) previous.text += value;
    else parts.push({ text: value, json });
  }
  return parts;
}

export function TranscriptText({
  text, label, markdown = false, parts, expansion, className, externalReferences, forceCollapse = false, streaming = false, plain = false,
}: {
  text: string;
  label?: string;
  markdown?: boolean;
  parts?: RunMessageSummary[];
  expansion?: MessageExpansion;
  className?: string;
  externalReferences?: MarkdownExternalReferenceMap;
  forceCollapse?: boolean;
  streaming?: boolean;
  plain?: boolean;
}) {
  const [open, setOpen] = useState(expansion?.open ?? false);
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const cache = useRef(new Map<string, string>());
  const partsKey = JSON.stringify(parts);
  const remote = parts !== undefined;
  const legacyTruncated = !remote && /\[message truncated\]\s*$/.test(text);
  const complete = !remote || Boolean(parts.length && parts.at(-1)?.message.last
    && parts.every((part, index) => part.message.part === index && part.detailRef));
  const collapsible = remote || forceCollapse || text.trim().includes("\n") || text.length > 240;

  useEffect(() => {
    if (expansion) setOpen(expansion.open);
  }, [expansion]);

  useEffect(() => {
    if ((!open && !plain) || !remote) return;
    const request = new AbortController();
    const selected: RunMessageSummary[] = JSON.parse(partsKey!);
    setLoading(true);
    setError(null);
    void (async () => {
      const chunks: string[] = [];
      try {
        for (const part of selected) {
          if (!part.detailRef) throw new Error("Some message content was not retained.");
          const reference = part.detailRef;
          let chunk = cache.current.get(reference.chunkId);
          if (chunk === undefined) {
            chunk = "";
            let offset = 0;
            for (;;) {
              const page = await heartbeatsApi.toolDetail(reference, offset, { signal: request.signal });
              if (request.signal.aborted) return;
              if (page.status !== "available") throw new Error(`Message content is ${page.status}.`);
              if (page.input === undefined) throw new Error("Message content is missing from this detail.");
              chunk += page.input;
              setBody([...chunks, chunk].join(""));
              if (page.nextOffset === undefined) break;
              if (page.nextOffset <= offset) throw new Error("Message pagination did not advance.");
              offset = page.nextOffset;
            }
            cache.current.set(reference.chunkId, chunk);
          }
          chunks.push(chunk);
        }
        setBody(chunks.join(""));
      } catch (failure) {
        if (!request.signal.aborted) setError(failure instanceof Error ? failure.message : "Message could not be loaded.");
      } finally {
        if (!request.signal.aborted) setLoading(false);
      }
    })();
    return () => request.abort();
  }, [open, plain, remote, partsKey, retry]);

  const displayed = remote ? body : legacyTruncated
    ? text.replace(/\n(?:\[[^\]\r\n]+\]\s*)?\[message truncated\]\s*$/, "") : text;
  const visibleParts = useMemo(() => plain ? plainTextParts(displayed) : [], [plain, displayed]);
  const content = plain
    ? visibleParts.map((part, index) => part.json
      ? <TranscriptText key={index} text={part.text} label="JSON" expansion={expansion} forceCollapse className={className} />
      : markdown
        ? <MarkdownBody key={index} className={className} externalReferences={externalReferences}>{part.text}</MarkdownBody>
        : <pre key={index} className={className ?? "overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-foreground/80"}>{part.text}</pre>)
    : markdown
    ? <MarkdownBody className={className} externalReferences={externalReferences}>{displayed}</MarkdownBody>
    : <pre className={className ?? "overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-foreground/80"}>{displayed}</pre>;
  const details = <>
        {loading && <p role="status" className="text-xs text-muted-foreground">Loading full message...</p>}
        {remote && !complete && !error && !loading && <p role="status" className="text-xs text-muted-foreground">
          {streaming ? "Waiting for the rest of the message..." : "Some message content was not retained. Only the available parts are shown."}
        </p>}
        {legacyTruncated && <p className="text-xs text-muted-foreground">Only the captured preview is available for this older message.</p>}
        {error && <div role="alert" className="text-xs text-destructive">{error}
          <Button size="sm" variant="ghost" onClick={() => setRetry(value => value + 1)}>Retry loading message</Button>
        </div>}
        {!plain && <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" disabled={loading || !complete || Boolean(error) || legacyTruncated}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(displayed);
                setCopyStatus("Copied");
              } catch {
                setCopyStatus("Could not copy message.");
              }
            }}>Copy full message</Button>
          {copyStatus && <span role="status" className="text-xs text-muted-foreground">{copyStatus}</span>}
        </div>}
  </>;
  if (plain) return <div className="min-w-0">
    {label && <div className="text-xs font-semibold text-muted-foreground">{label}</div>}
    {content}
    {details}
  </div>;
  if (!collapsible) return content;

  const preview = (text.split(/\r?\n/).find(line => line.trim()) ?? label ?? "Message")
    .replace(/^\[[^\]\r\n]+\]\s*/, "").replace(/^#+\s*/, "").slice(0, 200);
  return (
    <div className="min-w-0">
      <button type="button" className="flex min-h-6 w-full items-center gap-2 text-left text-xs text-muted-foreground hover:text-foreground"
        aria-expanded={open} onClick={() => setOpen(value => !value)}>
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
        {label && <span className="shrink-0 font-semibold">{label}</span>}
        <span className="min-w-0 flex-1 truncate">{preview}</span>
        {!remote && <span className="shrink-0 font-mono">{text.split(/\r?\n/).length} lines</span>}
      </button>
      {open && <div className="space-y-2 pl-5">
        {content}
        {details}
      </div>}
    </div>
  );
}
