import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TranscriptEntry } from "../../adapters";
import { runMessageSummarySchema, type RunMessageSummary, type ToolRunDecision } from "@paperclipai/shared";
import { MarkdownBody, type MarkdownExternalReferenceMap } from "../MarkdownBody";
import { cn, formatDurationMs, formatTokens } from "../../lib/utils";
import { runningLabelText } from "../../lib/status-colors";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  GitCompare,
  LoaderCircle,
  TerminalSquare,
  User,
} from "lucide-react";
import { toolTaxonomy } from "../task-chat/tool-taxonomy";
import { LazyToolDetails } from "./LazyToolDetails";
import { TranscriptText, type MessageExpansion } from "./TranscriptText";
import { parseAssignmentLine, parseRoundLine, TranscriptRound, type AssignmentBlock, type RoundBlock } from "./TranscriptRound";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";

/** Family glyph for a tool block/row; the taxonomy falls back to Wrench. */
function ToolFamilyIcon({ name, className }: { name: string; className?: string }) {
  const Icon = toolTaxonomy(name).icon;
  return <Icon className={className} />;
}

export type TranscriptMode = "nice" | "raw";
export type TranscriptDensity = "comfortable" | "compact";

const RAW_VIRTUALIZATION_THRESHOLD = 300;
const RAW_OVERSCAN_ROWS = 40;
const RAW_ESTIMATED_ROW_HEIGHT = 36;
const RAW_INITIAL_ROWS = 180;

interface RunTranscriptViewProps {
  entries: TranscriptEntry[];
  toolDecisions?: readonly ToolRunDecision[];
  mode?: TranscriptMode;
  density?: TranscriptDensity;
  limit?: number;
  streaming?: boolean;
  collapseStdout?: boolean;
  emptyMessage?: string;
  className?: string;
  thinkingClassName?: string;
  externalReferences?: MarkdownExternalReferenceMap;
}

type TranscriptBlock =
  | RoundBlock
  | AssignmentBlock
  | {
      type: "message_detail";
      ts: string;
      id: string;
      summary: string;
      label: string;
      parts: RunMessageSummary[];
    }
  | {
      type: "message";
      role: "assistant" | "user";
      ts: string;
      // Timestamp of the first entry that opened this block. `ts` tracks the
      // latest merged delta and mutates every chunk; `startTs` stays fixed so
      // the React key is stable and the streaming block does not remount (and
      // restart its fade) on each delta.
      startTs: string;
      text: string;
      streaming: boolean;
    }
  | {
      type: "thinking";
      ts: string;
      startTs: string;
      text: string;
      streaming: boolean;
    }
  | {
      type: "tool";
      ts: string;
      endTs?: string;
      name: string;
      toolUseId?: string;
      invocationId?: string;
      actionRequestId?: string;
      input: unknown;
      result?: string;
      isError?: boolean;
      status: "running" | "completed" | "error";
    }
  | {
      type: "activity";
      ts: string;
      startTs: string;
      activityId?: string;
      name: string;
      status: "running" | "completed";
    }
  | {
      type: "command_group";
      ts: string;
      endTs?: string;
      items: Array<{
        ts: string;
        endTs?: string;
        name: string;
        toolUseId?: string;
        invocationId?: string;
        actionRequestId?: string;
        input: unknown;
        result?: string;
        isError?: boolean;
        status: "running" | "completed" | "error";
      }>;
    }
  | {
      type: "tool_group";
      ts: string;
      endTs?: string;
      items: Array<{
        ts: string;
        endTs?: string;
        name: string;
        toolUseId?: string;
        invocationId?: string;
        actionRequestId?: string;
        input: unknown;
        result?: string;
        isError?: boolean;
        status: "running" | "completed" | "error";
      }>;
    }
  | {
      type: "stderr_group";
      ts: string;
      endTs?: string;
      lines: Array<{ ts: string; text: string }>;
    }
  | {
      type: "system_group";
      ts: string;
      endTs?: string;
      lines: Array<{ ts: string; text: string }>;
    }
  | {
      type: "stdout";
      ts: string;
      startTs: string;
      text: string;
    }
  | {
      type: "event";
      ts: string;
      label: string;
      tone: "info" | "warn" | "error" | "neutral";
      text: string;
      detail?: string;
    }
  | {
      type: "provider_activity";
      ts: string;
      family: Extract<TranscriptEntry, { kind: "provider_activity" }>["family"];
      eventType: string;
      status: Extract<TranscriptEntry, { kind: "provider_activity" }>["status"];
      title: string;
      summary: string;
      payload: Record<string, unknown>;
    }
  | {
      type: "diff_group";
      ts: string;
      endTs?: string;
      filePath?: string;
      hunks: Array<{
        changeType: "add" | "remove" | "context" | "hunk" | "file_header" | "truncation";
        text: string;
      }>;
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

function humanizeLabel(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function stripWrappedShell(command: string): string {
  const trimmed = compactWhitespace(command);
  const shellWrapped = trimmed.match(/^(?:(?:\/bin\/)?(?:zsh|bash|sh)|cmd(?:\.exe)?(?:\s+\/d)?(?:\s+\/s)?(?:\s+\/c)?)\s+(?:-lc|\/c)\s+(.+)$/i);
  const inner = shellWrapped?.[1] ?? trimmed;
  const quoted = inner.match(/^(['"])([\s\S]*)\1$/);
  return compactWhitespace(quoted?.[2] ?? inner);
}

function formatUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatToolPayload(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return formatUnknown(value);
}

function extractToolUseId(input: unknown): string | undefined {
  const record = asRecord(input);
  if (!record) return undefined;
  const candidates = [
    record.toolUseId,
    record.tool_use_id,
    record.callId,
    record.call_id,
    record.id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }
  return undefined;
}

function summarizeRecord(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return truncate(compactWhitespace(value), 120);
    }
  }
  return null;
}

/** Merge a streamed tool_call status update into the input captured so far. */
function mergeToolInput(previous: unknown, incoming: unknown): unknown {
  if (incoming === null || incoming === undefined) return previous;
  if (typeof incoming === "string") {
    return incoming.trim().length > 0 ? incoming : previous;
  }
  const previousRecord = asRecord(previous);
  const incomingRecord = asRecord(incoming);
  if (incomingRecord) {
    if (Object.keys(incomingRecord).length === 0) return previous;
    return previousRecord ? { ...previousRecord, ...incomingRecord } : incoming;
  }
  return incoming;
}

function summarizeToolInput(name: string, input: unknown, density: TranscriptDensity): string {
  const compactMax = density === "compact" ? 72 : 120;
  if (typeof input === "string") {
    const normalized = isCommandTool(name, input) ? stripWrappedShell(input) : compactWhitespace(input);
    return truncate(normalized, compactMax);
  }
  const record = asRecord(input);
  if (!record) {
    const serialized = compactWhitespace(formatUnknown(input));
    return serialized ? truncate(serialized, compactMax) : `Inspect ${name} input`;
  }

  const command = typeof record.command === "string"
    ? record.command
    : typeof record.cmd === "string"
      ? record.cmd
      : null;
  if (command && isCommandTool(name, record)) {
    return truncate(stripWrappedShell(command), compactMax);
  }

  const direct =
    summarizeRecord(record, ["command", "cmd", "path", "filePath", "file_path", "query", "url", "prompt", "message"])
    ?? summarizeRecord(record, ["pattern", "name", "title", "target", "tool", "text"])
    ?? null;
  if (direct) return truncate(direct, compactMax);

  if (Array.isArray(record.paths) && record.paths.length > 0) {
    const first = record.paths.find((value): value is string => typeof value === "string" && value.trim().length > 0);
    if (first) {
      return truncate(`${record.paths.length} paths, starting with ${first}`, compactMax);
    }
  }

  const keys = Object.keys(record);
  if (keys.length === 0) return `No ${name} input`;
  if (keys.length === 1) return truncate(`${keys[0]} payload`, compactMax);
  return truncate(`${keys.length} fields: ${keys.slice(0, 3).join(", ")}`, compactMax);
}

function parseStructuredToolResult(result: string | undefined) {
  if (!result) return null;
  const lines = result.split(/\r?\n/);
  const metadata = new Map<string, string>();
  let bodyStartIndex = lines.findIndex((line) => line.trim() === "");
  if (bodyStartIndex === -1) bodyStartIndex = lines.length;

  for (let index = 0; index < bodyStartIndex; index += 1) {
    const match = lines[index]?.match(/^([a-z_]+):\s*(.+)$/i);
    if (match) {
      metadata.set(match[1].toLowerCase(), compactWhitespace(match[2]));
    }
  }

  const body = lines.slice(Math.min(bodyStartIndex + 1, lines.length))
    .map((line) => compactWhitespace(line))
    .filter(Boolean)
    .join("\n");

  return {
    command: metadata.get("command") ?? null,
    status: metadata.get("status") ?? null,
    exitCode: metadata.get("exit_code") ?? null,
    body,
  };
}

function isCommandTool(name: string, input: unknown): boolean {
  if (asRecord(input)?.clippyTool) return false;
  if (name === "command_execution" || name === "shell" || name === "shellToolCall" || name === "bash") {
    return true;
  }
  if (typeof input === "string") {
    return /\b(?:bash|zsh|sh|cmd|powershell)\b/i.test(input);
  }
  const record = asRecord(input);
  return Boolean(record && (typeof record.command === "string" || typeof record.cmd === "string"));
}

function isPreparationText(text: string): boolean {
  return /(?:^|\n)(?:(?:>>|<<)\s+)?\[(?:prep|framework)\]|# assignment input/i.test(text);
}

function summarizeToolResult(result: string | undefined, isError: boolean | undefined, density: TranscriptDensity): string {
  if (!result) return isError ? "Tool failed" : "Waiting for result";
  const structured = parseStructuredToolResult(result);
  if (structured) {
    if (structured.body) {
      return truncate(structured.body.split("\n")[0] ?? structured.body, density === "compact" ? 84 : 140);
    }
    if (structured.status === "completed") return "Completed";
    if (structured.status === "failed" || structured.status === "error") {
      return structured.exitCode ? `Failed with exit code ${structured.exitCode}` : "Failed";
    }
  }
  const lines = result
    .split(/\r?\n/)
    .map((line) => compactWhitespace(line))
    .filter(Boolean);
  const firstLine = lines[0] ?? result;
  return truncate(firstLine, density === "compact" ? 84 : 140);
}

type ToolDecisionRefs = {
  toolUseId?: string;
  invocationId?: string;
  actionRequestId?: string;
};

type ToolDecisionMaps = {
  byInvocationId: Map<string, ToolRunDecision>;
  byActionRequestId: Map<string, ToolRunDecision>;
};

function buildToolDecisionMaps(decisions: readonly ToolRunDecision[] | undefined): ToolDecisionMaps {
  const byInvocationId = new Map<string, ToolRunDecision>();
  const byActionRequestId = new Map<string, ToolRunDecision>();
  for (const decision of decisions ?? []) {
    byInvocationId.set(decision.invocation.id, decision);
    if (decision.actionRequest?.id) {
      byActionRequestId.set(decision.actionRequest.id, decision);
    }
    if (decision.latestAuditEvent?.actionRequestId) {
      byActionRequestId.set(decision.latestAuditEvent.actionRequestId, decision);
    }
  }
  return { byInvocationId, byActionRequestId };
}

function findToolDecision(maps: ToolDecisionMaps, refs: ToolDecisionRefs): ToolRunDecision | null {
  if (refs.invocationId) {
    const decision = maps.byInvocationId.get(refs.invocationId);
    if (decision) return decision;
  }
  if (refs.actionRequestId) {
    const decision = maps.byActionRequestId.get(refs.actionRequestId);
    if (decision) return decision;
  }
  if (refs.toolUseId) {
    return maps.byInvocationId.get(refs.toolUseId) ?? maps.byActionRequestId.get(refs.toolUseId) ?? null;
  }
  return null;
}

function summarizeToolDecision(decision: ToolRunDecision | null): { label: string; className: string; detail?: string } | null {
  if (!decision) return null;
  if (decision.pendingAction) {
    return {
      label: "Needs approval",
      className: "text-amber-700 dark:text-amber-300",
      detail: `Action request ${decision.pendingAction.actionRequestId.slice(0, 8)}`,
    };
  }
  if (decision.denialReason || decision.invocation.status === "denied" || decision.outcome === "denied") {
    return {
      label: "Denied",
      className: "text-red-700 dark:text-red-300",
      detail: decision.denialReason ?? decision.reasonCode ?? undefined,
    };
  }
  if (decision.invocation.status === "failed" || decision.invocation.status === "timed_out" || decision.outcome === "failure" || decision.outcome === "timeout") {
    return {
      label: decision.invocation.status === "timed_out" || decision.outcome === "timeout" ? "Timed out" : "Failed",
      className: "text-red-700 dark:text-red-300",
      detail: decision.denialReason ?? decision.reasonCode ?? undefined,
    };
  }
  if (decision.actionRequest?.status === "approved") {
    return { label: "Approved", className: "text-emerald-700 dark:text-emerald-300" };
  }
  if (decision.actionRequest?.status === "executed") {
    return { label: "Executed", className: "text-emerald-700 dark:text-emerald-300" };
  }
  if (decision.decision === "allow" || decision.invocation.status === "authorized" || decision.invocation.status === "executing" || decision.invocation.status === "succeeded") {
    return { label: "Allowed", className: "text-emerald-700 dark:text-emerald-300" };
  }
  if (decision.decision === "require_approval" || decision.invocation.approvalState === "pending") {
    return { label: "Needs approval", className: "text-amber-700 dark:text-amber-300" };
  }
  return {
    label: humanizeLabel(decision.invocation.status),
    className: "text-foreground/70",
    detail: decision.reasonCode ?? undefined,
  };
}

function parseSystemActivity(text: string): { activityId?: string; name: string; status: "running" | "completed" } | null {
  const match = text.match(/^item (started|completed):\s*([a-z0-9_-]+)(?:\s+\(id=([^)]+)\))?$/i);
  if (!match) return null;
  return {
    status: match[1].toLowerCase() === "started" ? "running" : "completed",
    name: humanizeLabel(match[2] ?? "Activity"),
    activityId: match[3] || undefined,
  };
}

function shouldHideNiceModeStderr(text: string): boolean {
  const normalized = compactWhitespace(text).toLowerCase();
  return normalized.startsWith("[paperclip] skipping saved session resume");
}

function groupCommandBlocks(blocks: TranscriptBlock[]): TranscriptBlock[] {
  const grouped: TranscriptBlock[] = [];
  let pending: Array<Extract<TranscriptBlock, { type: "command_group" }>["items"][number]> = [];
  let groupTs: string | null = null;
  let groupEndTs: string | undefined;

  const flush = () => {
    if (pending.length === 0 || !groupTs) return;
    grouped.push({
      type: "command_group",
      ts: groupTs,
      endTs: groupEndTs,
      items: pending,
    });
    pending = [];
    groupTs = null;
    groupEndTs = undefined;
  };

  for (const block of blocks) {
    if (block.type === "tool" && isCommandTool(block.name, block.input)) {
      if (!groupTs) {
        groupTs = block.ts;
      }
      groupEndTs = block.endTs ?? block.ts;
      pending.push({
        ts: block.ts,
        endTs: block.endTs,
        name: block.name,
        toolUseId: block.toolUseId,
        invocationId: block.invocationId,
        actionRequestId: block.actionRequestId,
        input: block.input,
        result: block.result,
        isError: block.isError,
        status: block.status,
      });
      continue;
    }

    flush();
    grouped.push(block);
  }

  flush();
  return grouped;
}

/** Group consecutive non-command tool blocks into a single tool_group accordion. */
function groupToolBlocks(blocks: TranscriptBlock[]): TranscriptBlock[] {
  const grouped: TranscriptBlock[] = [];
  let pending: Array<Extract<TranscriptBlock, { type: "tool_group" }>["items"][number]> = [];
  let groupTs: string | null = null;
  let groupEndTs: string | undefined;

  const flush = () => {
    if (pending.length === 0 || !groupTs) return;
    grouped.push({
      type: "tool_group",
      ts: groupTs,
      endTs: groupEndTs,
      items: pending,
    });
    pending = [];
    groupTs = null;
    groupEndTs = undefined;
  };

  for (const block of blocks) {
    if (block.type === "tool" && !isCommandTool(block.name, block.input) && !asRecord(block.input)?.clippyTool) {
      if (!groupTs) groupTs = block.ts;
      groupEndTs = block.endTs ?? block.ts;
      pending.push({
        ts: block.ts,
        endTs: block.endTs,
        name: block.name,
        toolUseId: block.toolUseId,
        invocationId: block.invocationId,
        actionRequestId: block.actionRequestId,
        input: block.input,
        result: block.result,
        isError: block.isError,
        status: block.status,
      });
      continue;
    }
    flush();
    grouped.push(block);
  }
  flush();
  return grouped;
}

export function normalizeTranscript(entries: TranscriptEntry[], streaming: boolean): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  const pendingToolBlocks = new Map<string, Extract<TranscriptBlock, { type: "tool" }>>();
  const pendingActivityBlocks = new Map<string, Extract<TranscriptBlock, { type: "activity" }>>();
  const rounds = new Map<string, RoundBlock>();
  const messages = new Map<string, Extract<TranscriptBlock, { type: "message_detail" }>>();

  for (const entry of entries) {
    const previous = blocks[blocks.length - 1];

    if (entry.kind === "stdout" || entry.kind === "system") {
      const assignment = parseAssignmentLine(entry.text);
      if (assignment) {
        if (assignment.phase === "harness") {
          if (previous?.type === "assignment" && previous.phase === "start" && previous.harness === assignment.harness) {
            previous.lines.push(assignment.summary);
            continue;
          }
        } else {
          if (previous?.type === "assignment" && previous.phase === "end" && assignment.phase === "end"
            && assignment.harness === "framework" && previous.harness !== "framework") {
            previous.lines.push(assignment.summary);
            if (previous.status !== "failed" && (previous.status !== "cancelled" || assignment.status === "failed")) {
              previous.status = assignment.status;
            }
          } else {
            blocks.push({ type: "assignment", ts: entry.ts, phase: assignment.phase,
              harness: assignment.harness, status: assignment.status, lines: [assignment.summary] });
          }
          continue;
        }
      }
      const candidate = entry.text.replace(/^\[[^\]\r\n]+\]\s*/, "").trim();
      if (candidate.startsWith('{"type":"clippy.message"')) {
        let value: unknown;
        try { value = JSON.parse(candidate); } catch { value = null; }
        const parsed = runMessageSummarySchema.safeParse(value);
        if (parsed.success) {
          const part = parsed.data;
          let message = messages.get(part.message.id);
          if (!message) {
            message = { type: "message_detail", id: part.message.id, ts: entry.ts,
              summary: part.summary, label: part.message.label, parts: [] };
            messages.set(part.message.id, message);
            blocks.push(message);
          }
          if (!message.parts.some(item => item.message.part === part.message.part)) {
            message.parts.push(part);
            message.parts.sort((a, b) => a.message.part - b.message.part);
          }
          continue;
        }
      }
      const event = parseRoundLine(entry.text);
      if (event) {
        const key = `${event.executionId}:${event.harness}`;
        let round = rounds.get(key);
        if (event.action === "round_start" || event.action === "model_request") {
          if (!round || round.status !== "running" || event.action === "round_start" && round.round !== undefined) {
            if (round?.status === "running") {
              round.status = "unknown";
              round.endTs = entry.ts;
            }
            round = { type: "round", ts: entry.ts, startTs: entry.ts, executionId: event.executionId,
              harness: event.harness, round: event.round, status: "running", lines: [] };
            rounds.set(key, round);
            blocks.push(round);
          }
          if (event.action === "round_start") round.round = event.round;
        } else if (round && (event.round === undefined || round.round === undefined || round.round === event.round)) {
          round.round ??= event.round;
          round.status = event.status ?? "completed";
          round.endTs = entry.ts;
        } else {
          round = { type: "round", ts: entry.ts, startTs: entry.ts, endTs: entry.ts,
            executionId: event.executionId, harness: event.harness, round: event.round,
            status: event.status ?? "completed", lines: [] };
          blocks.push(round);
        }
        round.lines.push(event.summary);
        continue;
      }
    }

    if (entry.kind === "assistant" || entry.kind === "user") {
      const isStreaming = streaming && entry.kind === "assistant" && entry.delta === true;
      if (previous?.type === "message" && previous.role === entry.kind) {
        previous.text += previous.text.endsWith("\n") || entry.text.startsWith("\n") ? entry.text : `\n${entry.text}`;
        previous.ts = entry.ts;
        previous.streaming = previous.streaming || isStreaming;
      } else {
        blocks.push({
          type: "message",
          role: entry.kind,
          ts: entry.ts,
          startTs: entry.ts,
          text: entry.text,
          streaming: isStreaming,
        });
      }
      continue;
    }

    if (entry.kind === "thinking") {
      const isStreaming = streaming && entry.delta === true;
      if (previous?.type === "thinking") {
        previous.text += previous.text.endsWith("\n") || entry.text.startsWith("\n") ? entry.text : `\n${entry.text}`;
        previous.ts = entry.ts;
        previous.streaming = previous.streaming || isStreaming;
      } else {
        blocks.push({
          type: "thinking",
          ts: entry.ts,
          startTs: entry.ts,
          text: entry.text,
          streaming: isStreaming,
        });
      }
      continue;
    }

    if (entry.kind === "provider_activity") {
      blocks.push({ type: "provider_activity", ts: entry.ts, family: entry.family, eventType: entry.eventType, status: entry.status, title: entry.title, summary: entry.summary, payload: entry.payload });
      continue;
    }

    if (entry.kind === "workspace_change") {
      blocks.push({
        type: "event",
        ts: entry.ts,
        label: entry.complete ? "workspace diff" : "workspace changes",
        tone: "info",
        text: `${entry.totals.files} changed ${entry.totals.files === 1 ? "file" : "files"}`,
        detail: entry.source === "runner_verified" ? "Verified from workspace" : "Reported by harness",
      });
      continue;
    }

    if (entry.kind === "workspace_file_reference") {
      blocks.push({ type: "event", ts: entry.ts, label: "file reference", tone: "info", text: entry.displayName, detail: entry.path });
      continue;
    }

    if (entry.kind === "runtime_request") {
      blocks.push({ type: "event", ts: entry.ts, label: `runtime ${entry.requestType}`, tone: entry.status === "pending" ? "warn" : "info", text: entry.prompt, detail: entry.status });
      continue;
    }

    if (entry.kind === "run_result") {
      blocks.push({ type: "event", ts: entry.ts, label: `result · ${entry.disposition}`, tone: entry.disposition === "blocked" ? "warn" : "info", text: entry.summary });
      continue;
    }

    if (entry.kind === "run_terminal") {
      for (const round of rounds.values()) {
        if (round.status !== "running") continue;
        round.status = entry.runState === "cancelled" ? "cancelled" : entry.runState === "failed" ? "failed" : "unknown";
        round.endTs = entry.ts;
      }
      blocks.push({ type: "event", ts: entry.ts, label: "terminal", tone: entry.runState === "failed" ? "error" : "info", text: `${entry.runState} · ${entry.disposition}`, detail: entry.stopReason });
      continue;
    }

    if (entry.kind === "tool_call") {
      const toolUseId = entry.toolUseId ?? extractToolUseId(entry.input);
      // Streaming runtimes (e.g. ACPX) re-emit the same tool call as its
      // status progresses. Fold updates into the existing running card
      // instead of stacking duplicate "Running" blocks.
      const pending = toolUseId ? pendingToolBlocks.get(toolUseId) : undefined;
      if (pending && pending.status === "running") {
        pending.input = mergeToolInput(pending.input, entry.input);
        continue;
      }
      const toolBlock: Extract<TranscriptBlock, { type: "tool" }> = {
        type: "tool",
        ts: entry.ts,
        name: entry.name,
        toolUseId,
        invocationId: entry.invocationId,
        actionRequestId: entry.actionRequestId,
        input: entry.input,
        status: "running",
      };
      blocks.push(toolBlock);
      if (toolBlock.toolUseId) {
        pendingToolBlocks.set(toolBlock.toolUseId, toolBlock);
      }
      continue;
    }

    if (entry.kind === "tool_result") {
      const matched =
        pendingToolBlocks.get(entry.toolUseId)
        ?? [...blocks].reverse().find((block): block is Extract<TranscriptBlock, { type: "tool" }> => block.type === "tool" && block.status === "running");

      if (matched) {
        matched.result = entry.content;
        matched.isError = entry.isError;
        matched.status = entry.isError ? "error" : "completed";
        matched.endTs = entry.ts;
        pendingToolBlocks.delete(entry.toolUseId);
      } else {
        blocks.push({
          type: "tool",
          ts: entry.ts,
          endTs: entry.ts,
          name: entry.toolName ?? "tool",
          toolUseId: entry.toolUseId,
          input: null,
          result: entry.content,
          isError: entry.isError,
          status: entry.isError ? "error" : "completed",
        });
      }
      continue;
    }

    if (entry.kind === "init") {
      blocks.push({
        type: "event",
        ts: entry.ts,
        label: "init",
        tone: "info",
        text: `model ${entry.model}${entry.sessionId ? ` • session ${entry.sessionId}` : ""}`,
      });
      continue;
    }

    if (entry.kind === "result") {
      blocks.push({
        type: "event",
        ts: entry.ts,
        label: "result",
        tone: entry.isError ? "error" : "info",
        text: entry.text.trim() || entry.errors[0] || (entry.isError ? "Run failed" : "Completed"),
        detail:
          !entry.isError && entry.text.trim().length > 0
            ? `${formatTokens(entry.inputTokens)} / ${formatTokens(entry.outputTokens)} / $${entry.costUsd.toFixed(6)}`
            : undefined,
      });
      continue;
    }

    if (entry.kind === "stderr") {
      if (shouldHideNiceModeStderr(entry.text)) {
        continue;
      }
      // Batch consecutive stderr entries into a single group
      const prev = blocks[blocks.length - 1];
      if (prev && prev.type === "stderr_group") {
        prev.lines.push({ ts: entry.ts, text: entry.text });
        prev.endTs = entry.ts;
      } else {
        blocks.push({
          type: "stderr_group",
          ts: entry.ts,
          endTs: entry.ts,
          lines: [{ ts: entry.ts, text: entry.text }],
        });
      }
      continue;
    }

    if (entry.kind === "system") {
      if (compactWhitespace(entry.text).toLowerCase() === "turn started") {
        continue;
      }
      if (isPreparationText(entry.text)) {
        blocks.push({ type: "stdout", ts: entry.ts, startTs: entry.ts, text: entry.text });
        continue;
      }
      const activity = parseSystemActivity(entry.text);
      if (activity) {
        const existing = activity.activityId ? pendingActivityBlocks.get(activity.activityId) : undefined;
        if (existing) {
          existing.status = activity.status;
          existing.ts = entry.ts;
          if (activity.status === "completed" && activity.activityId) {
            pendingActivityBlocks.delete(activity.activityId);
          }
        } else {
          const block: Extract<TranscriptBlock, { type: "activity" }> = {
            type: "activity",
            ts: entry.ts,
            startTs: entry.ts,
            activityId: activity.activityId,
            name: activity.name,
            status: activity.status,
          };
          blocks.push(block);
          if (activity.status === "running" && activity.activityId) {
            pendingActivityBlocks.set(activity.activityId, block);
          }
        }
        continue;
      }
      // Batch consecutive system events into a single collapsible group
      const prev = blocks[blocks.length - 1];
      if (prev && prev.type === "system_group") {
        prev.lines.push({ ts: entry.ts, text: entry.text });
        prev.endTs = entry.ts;
      } else {
        blocks.push({
          type: "system_group",
          ts: entry.ts,
          endTs: entry.ts,
          lines: [{ ts: entry.ts, text: entry.text }],
        });
      }
      continue;
    }

    const activeCommandBlock = [...blocks].reverse().find(
      (block): block is Extract<TranscriptBlock, { type: "tool" }> =>
        block.type === "tool" && block.status === "running" && isCommandTool(block.name, block.input),
    );
    if (activeCommandBlock) {
      activeCommandBlock.result = activeCommandBlock.result
        ? `${activeCommandBlock.result}${activeCommandBlock.result.endsWith("\n") || entry.text.startsWith("\n") ? entry.text : `\n${entry.text}`}`
        : entry.text;
      continue;
    }

    // ── Diff entries — accumulate into diff_group blocks ──────────
    if (entry.kind === "diff") {
      const prev = blocks[blocks.length - 1];
      if (prev && prev.type === "diff_group") {
        if (entry.changeType === "file_header") {
          // New file in the same diff block — update filePath
          prev.filePath = entry.text;
        }
        prev.hunks.push({ changeType: entry.changeType, text: entry.text });
        prev.endTs = entry.ts;
      } else {
        blocks.push({
          type: "diff_group",
          ts: entry.ts,
          endTs: entry.ts,
          filePath: entry.changeType === "file_header" ? entry.text : undefined,
          hunks: [{ changeType: entry.changeType, text: entry.text }],
        });
      }
      continue;
    }

    if (previous?.type === "stdout" && isPreparationText(previous.text) === isPreparationText(entry.text)) {
      previous.text += previous.text.endsWith("\n") || entry.text.startsWith("\n") ? entry.text : `\n${entry.text}`;
      previous.ts = entry.ts;
    } else {
      blocks.push({
        type: "stdout",
        ts: entry.ts,
        startTs: entry.ts,
        text: entry.text,
      });
    }
  }

  if (!streaming) {
    for (const round of rounds.values()) if (round.status === "running") round.status = "unknown";
  }
  return groupToolBlocks(groupCommandBlocks(blocks));
}

/**
 * Stable identity for a block's React key. Anchored to the block's opening
 * timestamp (`startTs`) or a durable id (`toolUseId`, `activityId`) rather than
 * its latest `ts`, which mutates on every streamed delta. A mutating key
 * remounts the block, restarting its 300ms fade-in so the text visibly blinks
 * out and back each chunk; a stable one keeps the streaming tail mounted.
 */
function transcriptBlockIdentity(block: TranscriptBlock): string {
  switch (block.type) {
    case "assignment":
      return `assignment:${block.phase}:${block.harness}:${block.ts}`;
    case "round":
      return `round:${block.executionId}:${block.harness}:${block.startTs}`;
    case "message_detail":
      return `message_detail:${block.id}`;
    case "message":
      return `message:${block.role}:${block.startTs}`;
    case "thinking":
      return `thinking:${block.startTs}`;
    case "stdout":
      return `stdout:${block.startTs}`;
    case "activity":
      return `activity:${block.activityId ?? block.startTs}`;
    case "tool":
      return `tool:${block.toolUseId ?? block.ts}`;
    case "command_group":
      return `command_group:${block.ts}`;
    case "tool_group":
      return `tool_group:${block.ts}`;
    case "stderr_group":
      return `stderr_group:${block.ts}`;
    case "system_group":
      return `system_group:${block.ts}`;
    case "diff_group":
      return `diff_group:${block.ts}`;
    case "event":
      return `event:${block.label}:${block.ts}`;
    case "provider_activity":
      return `provider_activity:${block.eventType}:${block.ts}`;
  }
}

function TranscriptProviderActivity({ block, density }: { block: Extract<TranscriptBlock, { type: "provider_activity" }>; density: TranscriptDensity }) {
  const [open, setOpen] = useState(block.status === "running");
  const steps = Array.isArray(block.payload.steps) ? block.payload.steps.map(asRecord).filter((value): value is Record<string, unknown> => value !== null) : [];
  const children = Array.isArray(block.payload.children) ? block.payload.children.map(asRecord).filter((value): value is Record<string, unknown> => value !== null) : [];
  const sources = Array.isArray(block.payload.sources) ? block.payload.sources.map(asRecord).filter((value): value is Record<string, unknown> => value !== null) : [];
  const output = typeof block.payload.output === "string" ? block.payload.output.slice(-(8 * 1024)) : "";
  return <div className={cn("rounded-xl border p-2", block.status === "failed" ? "border-red-500/30 bg-red-500/[0.05]" : "border-border/70 bg-muted/20")} data-provider-family={block.family}>
    <button type="button" className="flex min-h-8 w-full items-center gap-2 text-left" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
      <span aria-hidden="true">{block.status === "running" ? "⏳" : block.status === "failed" ? "✕" : block.status === "interrupted" ? "■" : "✓"}</span>
      <strong className={cn("font-mono", density === "compact" ? "text-(length:--text-micro)" : "text-xs")}>{block.title}</strong>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{block.summary}</span>
      {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
    </button>
    {open ? <div className="mt-2 space-y-2 border-l border-border pl-5 text-xs">
      {steps.length > 0 ? <ol className="space-y-1">{steps.map((step, index) => <li key={String(step.stepId ?? index)}><span className="mr-2" aria-hidden="true">{step.status === "completed" ? "✓" : step.status === "blocked" ? "!" : "○"}</span>{String(step.body ?? "")}</li>)}</ol> : null}
      {children.length > 0 ? <ul className="space-y-1">{children.map((child, index) => <li key={String(child.childId ?? index)}><strong>{String(child.role ?? "Child agent")}</strong> · {String(child.status ?? "unknown")}<div className="text-muted-foreground">{String(child.summary ?? "")}</div></li>)}</ul> : null}
      {sources.length > 0 ? <ul className="space-y-1">{sources.map((source, index) => { const url = typeof source.url === "string" && /^https?:\/\//.test(source.url) ? source.url : null; return <li key={String(source.sourceId ?? index)}>{url ? <a className="underline" href={url} target="_blank" rel="noreferrer">{String(source.title ?? url)}</a> : String(source.title ?? "Unavailable source")} <span className="text-muted-foreground">Provider-reported</span></li>; })}</ul> : null}
      {output ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-background p-2 font-mono">{output}</pre> : null}
      {block.family === "provider_notice" && Array.isArray(block.payload.details) ? <dl className="space-y-1">{block.payload.details.slice(0, 64).map((value, index) => { const detail = asRecord(value); return detail && typeof detail.name === "string" && typeof detail.value === "string" ? <div key={index}><dt className="text-muted-foreground">{detail.name}</dt><dd className="whitespace-pre-wrap break-words">{detail.value}</dd></div> : null; })}</dl> : null}
      {block.family === "model_identity" ? <div><span className="text-muted-foreground">Requested</span> {String(block.payload.requestedModel ?? "—")} · <span className="text-muted-foreground">Effective</span> {String(block.payload.effectiveModel ?? "—")}</div> : null}
    </div> : null}
  </div>;
}

/**
 * Assign each block a stable, unique React key. Identity is position-independent
 * so earlier blocks collapsing (truncation) does not remount the survivors; a
 * per-render occurrence counter disambiguates the rare identity collision.
 */
export function keyTranscriptBlocks(blocks: TranscriptBlock[]): Array<{ block: TranscriptBlock; key: string }> {
  const seen = new Map<string, number>();
  return blocks.map((block) => {
    const identity = transcriptBlockIdentity(block);
    const occurrence = seen.get(identity) ?? 0;
    seen.set(identity, occurrence + 1);
    return { block, key: occurrence === 0 ? identity : `${identity}#${occurrence}` };
  });
}

function TranscriptMessageBlock({
  block,
  density,
  externalReferences,
  expansion,
  plain,
}: {
  block: Extract<TranscriptBlock, { type: "message" }>;
  density: TranscriptDensity;
  externalReferences?: MarkdownExternalReferenceMap;
  expansion: MessageExpansion;
  plain: boolean;
}) {
  const isAssistant = block.role === "assistant";
  const compact = density === "compact";

  return (
    <div>
      {!isAssistant && (
        <div className="mb-1.5 flex items-center gap-2 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
          <User className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
          <span>User</span>
        </div>
      )}
      <TranscriptText
        text={block.text}
        markdown
        expansion={expansion}
        plain={plain}
        className={cn(
          "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
          // Match the default view's chat message body (IssueChatThread:
          // `text-sm leading-6`) so streamed text reads identically (PAP-461, A2).
          compact ? "text-xs leading-5 text-foreground/85" : "text-sm leading-6",
        )}
        externalReferences={externalReferences}
      />
      {block.streaming && (
        <div className="mt-2 inline-flex items-center gap-1 text-(length:--text-nano) font-medium italic text-muted-foreground">
          <span className="relative flex h-1.5 w-1.5">
            <span className="tc-live-ping absolute inline-flex h-full w-full rounded-full bg-current opacity-70" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
          </span>
          Streaming
        </div>
      )}
    </div>
  );
}

function TranscriptThinkingBlock({
  block,
  density,
  className,
  externalReferences,
}: {
  block: Extract<TranscriptBlock, { type: "thinking" }>;
  density: TranscriptDensity;
  className?: string;
  externalReferences?: MarkdownExternalReferenceMap;
}) {
  return (
    <MarkdownBody
      className={cn(
        // Match the default view's chain-of-thought text (IssueChatThread:
        // `text-(length:--text-compact) italic leading-5 text-muted-foreground/70`)
        // so streamed thinking reads identically across both views (PAP-461, A2).
        "italic text-muted-foreground/70 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        density === "compact" ? "text-(length:--text-micro) leading-5" : "text-(length:--text-compact) leading-5",
        className,
      )}
      externalReferences={externalReferences}
    >
      {block.text}
    </MarkdownBody>
  );
}

function ToolDecisionBadge({ decision }: { decision: ToolRunDecision | null }) {
  const summary = summarizeToolDecision(decision);
  if (!summary) return null;
  return (
    <span className={cn("shrink-0 text-(length:--text-nano) font-semibold", summary.className)}>
      {summary.label}
    </span>
  );
}

function ToolDecisionInlineDetail({ decision }: { decision: ToolRunDecision | null }) {
  const summary = summarizeToolDecision(decision);
  if (!summary?.detail) return null;
  return (
    <div className="mt-1 break-words text-(length:--text-micro) text-muted-foreground">
      {summary.detail}
    </div>
  );
}

function ToolDecisionDetails({ decision, compact }: { decision: ToolRunDecision | null; compact: boolean }) {
  if (!decision) return null;
  const actionRequest = decision.actionRequest;
  return (
    <div className={cn(
      "rounded-lg border border-border/60 bg-background/60 p-2",
      compact ? "text-(length:--text-micro)" : "text-xs",
    )}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">Decision</span>
        <ToolDecisionBadge decision={decision} />
        {decision.reasonCode && <span className="font-mono text-muted-foreground">{decision.reasonCode}</span>}
      </div>
      {decision.denialReason && (
        <div className="mt-1 break-words text-red-700 dark:text-red-300">
          {decision.denialReason}
        </div>
      )}
      <div className="mt-2 grid gap-1 font-mono text-muted-foreground sm:grid-cols-2">
        <span>invocation {decision.invocation.id.slice(0, 8)}</span>
        <span>audit {decision.auditEvents.length}</span>
        {actionRequest && <span>action {actionRequest.status} {actionRequest.id.slice(0, 8)}</span>}
        {actionRequest?.interactionId && <span>card {actionRequest.interactionId.slice(0, 8)}</span>}
      </div>
      {decision.pendingAction?.previewMarkdown && (
        <MarkdownBody className="mt-2 text-(length:--text-micro) leading-5 text-foreground/75 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          {decision.pendingAction.previewMarkdown}
        </MarkdownBody>
      )}
    </div>
  );
}

function TranscriptToolHeader({
  name, status, ts, endTs, durationMs, open, onToggle, hover, decision, kind = "tool",
}: {
  name: string;
  status: "running" | "completed" | "error";
  ts: string;
  endTs?: string;
  durationMs?: number;
  open: boolean;
  onToggle: () => void;
  hover: ReactNode;
  decision: ToolRunDecision | null;
  kind?: "tool" | "command";
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (status !== "running") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [status]);
  const elapsed = durationMs ?? (endTs || status === "running"
    ? Math.max(0, (endTs ? Date.parse(endTs) : now) - Date.parse(ts)) : undefined);
  const Icon = status === "running" ? LoaderCircle : status === "error" ? CircleAlert : Check;
  return <TooltipProvider><Tooltip>
    <TooltipTrigger asChild>
      <button type="button" className="flex min-h-5 w-full items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
        aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${kind} details`}
        onClick={() => { if (!hasSelectedText()) onToggle(); }}>
        <Icon className={cn("h-3.5 w-3.5 shrink-0",
          status === "running" ? "animate-spin motion-reduce:animate-none text-blue-600 dark:text-blue-300"
            : status === "error" ? "text-destructive" : "text-emerald-600 dark:text-emerald-300")} />
        <span className="min-w-0 truncate font-mono">{name}</span>
        <span className={cn("shrink-0", status === "error" && "text-destructive")}>{status === "error" ? "failed" : status}</span>
        {elapsed !== undefined && Number.isFinite(elapsed) && <time dateTime={ts} title={ts} className="shrink-0 font-mono">{elapsed < 1000 ? `${elapsed} ms` : formatDurationMs(elapsed)}</time>}
        <ToolDecisionBadge decision={decision} />
        {decision?.pendingAction && <span className="shrink-0 text-(length:--text-nano)">Action request {decision.pendingAction.actionRequestId.slice(0, 8)}</span>}
        {open ? <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0" />}
      </button>
    </TooltipTrigger>
    <TooltipContent side="top" aria-label={`Details for ${name}`} className="max-h-64 max-w-xl overflow-auto whitespace-pre-wrap break-words bg-popover text-left text-popover-foreground">
      {hover}
      <ToolDecisionInlineDetail decision={decision} />
    </TooltipContent>
  </Tooltip></TooltipProvider>;
}

function TranscriptToolCard({
  block,
  density,
  decision,
}: {
  block: Extract<TranscriptBlock, { type: "tool" }>;
  density: TranscriptDensity;
  decision: ToolRunDecision | null;
}) {
  const remoteInput = asRecord(block.input)?.clippyTool ? asRecord(block.input) : null;
  const [open, setOpen] = useState((!remoteInput && block.status === "error") || Boolean(decision?.pendingAction || decision?.denialReason));
  const compact = density === "compact";
  const parsedResult = parseStructuredToolResult(block.result);
  const detailsClass = cn(
    "space-y-3",
    block.status === "error" && "rounded-xl border border-red-500/20 bg-red-500/[0.06] p-3",
  );
  const summary = remoteInput
    ? String(remoteInput.summary ?? "")
    : block.status === "running"
    ? summarizeToolInput(block.name, block.input, density)
    : block.status === "completed" && parsedResult?.body
      ? truncate(parsedResult.body.split("\n")[0] ?? parsedResult.body, compact ? 84 : 140)
      : summarizeToolResult(block.result, block.isError, density);

  return (
    <div>
      <TranscriptToolHeader name={block.name} status={block.status} ts={block.ts} endTs={block.endTs}
        durationMs={typeof remoteInput?.durationMs === "number" ? remoteInput.durationMs : undefined}
        open={open} onToggle={() => setOpen(value => !value)} decision={decision}
        hover={<>
          <div>{summary}</div>
          {remoteInput ? <LazyToolDetails input={remoteInput} preview />
            : <pre className="whitespace-pre-wrap break-words font-mono">{formatToolPayload(block.input)}</pre>}
        </>} />
      {open && (
        <div className="mt-1">
          <div className={detailsClass}>
            {remoteInput ? <LazyToolDetails input={remoteInput} /> : <div className={cn("grid gap-3", compact ? "grid-cols-1" : "lg:grid-cols-2")}>
              <div>
                <div className="mb-1 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
                  Input
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-(length:--text-micro) text-foreground/80">
                  {formatToolPayload(block.input) || "<empty>"}
                </pre>
              </div>
              <div>
                <div className="mb-1 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
                  Result
                </div>
                <pre className={cn(
                  "overflow-x-auto whitespace-pre-wrap break-words font-mono text-(length:--text-micro)",
                  block.status === "error" ? "text-red-700 dark:text-red-300" : "text-foreground/80",
                )}>
                  {block.result ? formatToolPayload(block.result) : "Waiting for result..."}
                </pre>
              </div>
            </div>}
            <ToolDecisionDetails decision={decision} compact={compact} />
          </div>
        </div>
      )}
    </div>
  );
}

function hasSelectedText() {
  if (typeof window === "undefined") return false;
  return (window.getSelection()?.toString().length ?? 0) > 0;
}

function TranscriptCommandGroup({
  block,
  density,
  toolDecisionMaps,
}: {
  block: Extract<TranscriptBlock, { type: "command_group" }>;
  density: TranscriptDensity;
  toolDecisionMaps: ToolDecisionMaps;
}) {
  const [open, setOpen] = useState(false);
  const compact = density === "compact";
  const runningItem = [...block.items].reverse().find((item) => item.status === "running");
  const highlightedDecision =
    block.items
      .map((item) => findToolDecision(toolDecisionMaps, item))
      .find((decision) => decision?.pendingAction || decision?.denialReason)
    ?? block.items.map((item) => findToolDecision(toolDecisionMaps, item)).find(Boolean)
    ?? null;
  const hasError = block.items.some((item) => item.status === "error");
  const isRunning = Boolean(runningItem);
  const names = [...new Set(block.items.map(item => item.name))].join(", ");
  const title = block.items.length === 1 ? names : `${names} (${block.items.length} calls)`;

  return (
    <div>
      <TranscriptToolHeader name={title} status={hasError ? "error" : isRunning ? "running" : "completed"}
        ts={block.ts} endTs={isRunning ? undefined : block.endTs} open={open} onToggle={() => setOpen(value => !value)}
        decision={highlightedDecision} kind="command"
        hover={<pre className="whitespace-pre-wrap break-words font-mono">{block.items.map(item => formatToolPayload(item.input)).join("\n\n")}</pre>} />
      {open && (
        <div className={cn("mt-1 space-y-2", hasError && "rounded-xl border border-red-500/20 bg-red-500/[0.06] p-2")}>
          {block.items.map((item, index) => (
            <div key={`${item.ts}-${index}`} className="space-y-2">
              <div className="flex items-center gap-2">
                <span className={cn(
                  "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border",
                  item.status === "error"
                    ? "border-red-500/25 bg-red-500/[0.08] text-red-600 dark:text-red-300"
                    : item.status === "running"
                      ? "border-blue-500/25 bg-blue-500/[0.08] text-blue-600 dark:text-blue-300"
                      : "border-border/70 bg-background text-foreground/55",
                )}>
                  <TerminalSquare className="h-3 w-3" />
                </span>
                <span className={cn("font-mono break-all", compact ? "text-(length:--text-micro)" : "text-xs")}>
                  {formatToolPayload(item.input)}
                </span>
              </div>
              {item.result && (
                <pre className={cn(
                  "overflow-x-auto whitespace-pre-wrap break-words font-mono text-(length:--text-micro)",
                  item.status === "error" ? "text-red-700 dark:text-red-300" : "text-foreground/80",
                )}>
                  {formatToolPayload(item.result)}
                </pre>
              )}
              <ToolDecisionDetails decision={findToolDecision(toolDecisionMaps, item)} compact={compact} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TranscriptToolGroup({
  block,
  density,
  toolDecisionMaps,
}: {
  block: Extract<TranscriptBlock, { type: "tool_group" }>;
  density: TranscriptDensity;
  toolDecisionMaps: ToolDecisionMaps;
}) {
  const [open, setOpen] = useState(false);
  const compact = density === "compact";
  const runningItem = [...block.items].reverse().find((item) => item.status === "running");
  const hasError = block.items.some((item) => item.status === "error");
  const isRunning = Boolean(runningItem);
  const highlightedDecision =
    block.items
      .map((item) => findToolDecision(toolDecisionMaps, item))
      .find((decision) => decision?.pendingAction || decision?.denialReason)
    ?? block.items.map((item) => findToolDecision(toolDecisionMaps, item)).find(Boolean)
    ?? null;
  const uniqueNames = [...new Set(block.items.map((item) => item.name))];
  const toolLabel =
    uniqueNames.length === 1
      ? uniqueNames[0]
      : uniqueNames.join(", ");
  const title = block.items.length === 1 ? toolLabel : `${toolLabel} (${block.items.length} calls)`;

  return (
    <div>
      <TranscriptToolHeader name={title} status={hasError ? "error" : isRunning ? "running" : "completed"}
        ts={block.ts} endTs={isRunning ? undefined : block.endTs} open={open} onToggle={() => setOpen(value => !value)}
        decision={highlightedDecision}
        hover={<pre className="whitespace-pre-wrap break-words font-mono">{block.items.map(item => `${item.name}\n${formatToolPayload(item.input)}`).join("\n\n")}</pre>} />
      {open && (
        <div className="mt-1 space-y-2">
          {block.items.map((item, index) => (
            <div key={`${item.ts}-${index}`} className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className={cn(
                  "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border",
                  item.status === "error"
                    ? "border-red-500/25 bg-red-500/[0.08] text-red-600 dark:text-red-300"
                    : item.status === "running"
                      ? "border-blue-500/25 bg-blue-500/[0.08] text-blue-600 dark:text-blue-300"
                      : "border-border/70 bg-background text-foreground/55",
                )}>
                  <ToolFamilyIcon name={item.name} className="h-3 w-3" />
                </span>
                <span className="font-mono text-(length:--text-nano) text-muted-foreground">
                  {item.name}
                </span>
                <span className={cn("text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-eyebrow)",
                  // Gallery feedback r1: running label uses brand blue, not cyan.
                  item.status === "running" ? runningLabelText
                  : item.status === "error" ? "text-red-700 dark:text-red-300"
                  : "text-emerald-700 dark:text-emerald-300"
                )}>
                  {item.status === "running" ? "Running" : item.status === "error" ? "Errored" : "Completed"}
                </span>
                <ToolDecisionBadge decision={findToolDecision(toolDecisionMaps, item)} />
              </div>
              <div className={cn("grid gap-2 pl-7", compact ? "grid-cols-1" : "lg:grid-cols-2")}>
                <div>
                  <div className="mb-0.5 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">Input</div>
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-(length:--text-micro) text-foreground/80">
                    {formatToolPayload(item.input) || "<empty>"}
                  </pre>
                </div>
                {item.result && (
                  <div>
                    <div className="mb-0.5 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">Result</div>
                    <pre className={cn(
                      "overflow-x-auto whitespace-pre-wrap break-words font-mono text-(length:--text-micro)",
                      item.status === "error" ? "text-red-700 dark:text-red-300" : "text-foreground/80",
                    )}>
                      {formatToolPayload(item.result)}
                    </pre>
                  </div>
                )}
              </div>
              <div className="pl-7">
                <ToolDecisionDetails decision={findToolDecision(toolDecisionMaps, item)} compact={compact} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TranscriptActivityRow({
  block,
  density,
}: {
  block: Extract<TranscriptBlock, { type: "activity" }>;
  density: TranscriptDensity;
}) {
  return (
    <div className="flex items-start gap-2">
      {block.status === "completed" ? (
        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-300" />
      ) : (
        <span className="relative mt-1 flex h-2.5 w-2.5 shrink-0">
          <span className="tc-live-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-70" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-blue-500" />
        </span>
      )}
      <div className={cn(
        "break-words text-foreground/80",
        density === "compact" ? "text-xs leading-5" : "text-sm leading-6",
      )}>
        {block.name}
      </div>
    </div>
  );
}

function TranscriptEventRow({
  block,
  density,
  externalReferences,
  expansion,
}: {
  block: Extract<TranscriptBlock, { type: "event" }>;
  density: TranscriptDensity;
  externalReferences?: MarkdownExternalReferenceMap;
  expansion: MessageExpansion;
}) {
  const compact = density === "compact";
  const toneClasses =
    block.tone === "error"
      ? "rounded-xl border border-red-500/20 bg-red-500/[0.06] p-3 text-red-700 dark:text-red-300"
      : block.tone === "warn"
        ? "text-amber-700 dark:text-amber-300"
        : block.tone === "info"
          ? "text-sky-700 dark:text-sky-300"
          : "text-foreground/75";

  return (
    <div className={toneClasses}>
      <div className="flex items-start gap-2">
        {block.tone === "error" ? (
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        ) : block.tone === "warn" ? (
          <TerminalSquare className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        ) : (
          <span className="mt-(--sz-7px) h-1.5 w-1.5 shrink-0 rounded-full bg-current/50" />
        )}
        <div className="min-w-0 flex-1">
          {block.label === "result" && block.tone !== "error" ? (
            <TranscriptText
              text={block.text}
              markdown
              plain
              expansion={expansion}
              className={cn(
                "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 text-sky-700 dark:text-sky-300",
                compact ? "text-(length:--text-micro) leading-5" : "text-xs leading-5",
              )}
              externalReferences={externalReferences}
            />
          ) : (
            <div className={cn("whitespace-pre-wrap break-words", compact ? "text-(length:--text-micro)" : "text-xs")}>
              <span className="text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-label) text-muted-foreground/70">
                {block.label}
              </span>
              {block.text ? <span className="ml-2">{block.text}</span> : null}
            </div>
          )}
          {block.detail && (
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words font-mono text-(length:--text-micro) text-foreground/75">
              {block.detail}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function TranscriptDiffGroup({
  block,
  density,
}: {
  block: Extract<TranscriptBlock, { type: "diff_group" }>;
  density: TranscriptDensity;
}) {
  const [open, setOpen] = useState(false);
  const compact = density === "compact";

  // Count add/remove lines (exclude context, hunk, file_header, truncation)
  const addCount = block.hunks.filter((h) => h.changeType === "add").length;
  const removeCount = block.hunks.filter((h) => h.changeType === "remove").length;
  const hasChanges = addCount > 0 || removeCount > 0;

  // Extract a short file name from the path
  const shortFile = block.filePath
    ? block.filePath.split("/").pop() ?? block.filePath
    : "diff";

  return (
    <div className="rounded-xl border border-blue-500/20 bg-blue-500/[0.04] p-2">
      <div
        role="button"
        tabIndex={0}
        className="flex cursor-pointer items-center gap-2"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((v) => !v); } }}
      >
        <GitCompare className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
        <span className={cn("text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-blue-700 dark:text-blue-300")}>
          {shortFile}
        </span>
        {hasChanges && (
          <span className="text-(length:--text-nano) tabular-nums">
            <span className="text-emerald-600 dark:text-emerald-400">+{addCount}</span>
            {" "}
            <span className="text-red-600 dark:text-red-400">-{removeCount}</span>
          </span>
        )}
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
      </div>
      {open && (
        <pre className={cn(
          "mt-2 overflow-x-auto whitespace-pre-wrap break-words font-mono pl-5",
          compact ? "text-(length:--text-micro)" : "text-xs",
        )}>
          {block.hunks.map((hunk, i) => {
            const key = `${i}-${hunk.changeType}`;
            switch (hunk.changeType) {
              case "remove":
                return (
                  <span key={key} className="block bg-red-500/[0.10] text-red-700 dark:text-red-300 -mx-2 px-2">
                    <span className="select-none mr-2 text-red-500/60 dark:text-red-400/50">-</span>
                    {hunk.text}
                    {"\n"}
                  </span>
                );
              case "add":
                return (
                  <span key={key} className="block bg-emerald-500/[0.10] text-emerald-700 dark:text-emerald-300 -mx-2 px-2">
                    <span className="select-none mr-2 text-emerald-500/60 dark:text-emerald-400/50">+</span>
                    {hunk.text}
                    {"\n"}
                  </span>
                );
              case "file_header":
                return (
                  <span key={key} className="block font-semibold text-blue-600 dark:text-blue-300 mt-2 first:mt-0">
                    {hunk.text}
                    {"\n"}
                  </span>
                );
              case "truncation":
                return (
                  <span key={key} className="block text-muted-foreground italic mt-1">
                    {hunk.text}
                    {"\n"}
                  </span>
                );
              case "context":
              default:
                return (
                  <span key={key} className="block text-muted-foreground/70">
                    {" "}
                    {hunk.text}
                    {"\n"}
                  </span>
                );
            }
          })}
        </pre>
      )}
    </div>
  );
}

function TranscriptStderrGroup({
  block,
  density,
}: {
  block: Extract<TranscriptBlock, { type: "stderr_group" }>;
  density: TranscriptDensity;
}) {
  const [open, setOpen] = useState(false);
  const compact = density === "compact";
  return (
    <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] p-2 text-amber-700 dark:text-amber-300">
      <div
        role="button"
        tabIndex={0}
        className="flex cursor-pointer items-center gap-2"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((v) => !v); } }}
      >
        <span className={cn("text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-eyebrow)")}>
          {block.lines.length} log {block.lines.length === 1 ? "line" : "lines"}
        </span>
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
      </div>
      {open && (
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words font-mono text-(length:--text-micro) text-amber-700/80 dark:text-amber-300/80 pl-5">
          {block.lines.map((line, i) => (
            <span key={`${line.ts}-${i}`}>
              <span className="select-none text-amber-500/50 dark:text-amber-400/40">{i > 0 ? "\n" : ""}</span>
              {line.text}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}

function TranscriptSystemGroup({
  block,
  density,
}: {
  block: Extract<TranscriptBlock, { type: "system_group" }>;
  density: TranscriptDensity;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-blue-500/20 bg-blue-500/[0.04] p-2 text-blue-700 dark:text-blue-300">
      <div
        role="button"
        tabIndex={0}
        className="flex cursor-pointer items-center gap-2"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((v) => !v); } }}
      >
        <TerminalSquare className="h-3.5 w-3.5 shrink-0" />
        <span className="text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-eyebrow)">
          {block.lines.length} system {block.lines.length === 1 ? "message" : "messages"}
        </span>
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
      </div>
      {open && (
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words font-mono text-(length:--text-micro) text-blue-700/80 dark:text-blue-300/80 pl-5">
          {block.lines.map((line, i) => (
            <span key={`${line.ts}-${i}`}>
              <span className="select-none text-blue-500/40 dark:text-blue-400/30">{i > 0 ? "\n" : ""}</span>
              {line.text}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}

function TranscriptStdoutRow({
  block,
  density,
  collapseByDefault,
  expansion,
  plain,
}: {
  block: Extract<TranscriptBlock, { type: "stdout" }>;
  density: TranscriptDensity;
  collapseByDefault: boolean;
  expansion: MessageExpansion;
  plain: boolean;
}) {
  return (
      <TranscriptText text={block.text} expansion={expansion} forceCollapse={collapseByDefault} plain={plain || isPreparationText(block.text)}
        className={cn(
          "overflow-x-auto whitespace-pre-wrap break-words font-mono text-foreground/80",
          density === "compact" ? "text-(length:--text-micro)" : "text-xs",
        )} />
  );
}

function findScrollParent(element: HTMLElement): HTMLElement | Window {
  let current = element.parentElement;
  while (current) {
    const style = window.getComputedStyle(current);
    if (/(auto|scroll)/.test(style.overflowY) && current.scrollHeight > current.clientHeight) {
      return current;
    }
    current = current.parentElement;
  }
  return window;
}

function rawEntryContent(entry: TranscriptEntry): string {
  if (entry.kind === "provider_activity") {
    return `${entry.eventType}\n${entry.title}: ${entry.summary}`;
  }
  if (entry.kind === "tool_call") {
    return `${entry.name}\n${formatToolPayload(entry.input)}`;
  }
  if (entry.kind === "tool_result") {
    return formatToolPayload(entry.content);
  }
  if (entry.kind === "result") {
    return `${entry.text}\n${formatTokens(entry.inputTokens)} / ${formatTokens(entry.outputTokens)} / $${entry.costUsd.toFixed(6)}`;
  }
  if (entry.kind === "init") {
    return `model=${entry.model}${entry.sessionId ? ` session=${entry.sessionId}` : ""}`;
  }
  if (entry.kind === "workspace_change") return `${entry.totals.files} files · ${entry.source} · revision ${entry.revision}`;
  if (entry.kind === "workspace_file_reference") return `${entry.displayName}\n${entry.path}`;
  if (entry.kind === "runtime_request") return `${entry.requestType} · ${entry.status}\n${entry.prompt}`;
  if (entry.kind === "run_result") return `${entry.disposition}\n${entry.summary}`;
  if (entry.kind === "run_terminal") return `${entry.runState} · ${entry.turnState} · ${entry.disposition}${entry.stopReason ? `\n${entry.stopReason}` : ""}`;
  return entry.text;
}

function RawTranscriptView({
  entries,
  density,
}: {
  entries: TranscriptEntry[];
  density: TranscriptDensity;
}) {
  const compact = density === "compact";
  const listRef = useRef<HTMLDivElement | null>(null);
  const shouldVirtualize = entries.length > RAW_VIRTUALIZATION_THRESHOLD;
  const [range, setRange] = useState(() => ({
    start: 0,
    end: Math.min(entries.length, shouldVirtualize ? RAW_INITIAL_ROWS : entries.length),
  }));

  useEffect(() => {
    if (!shouldVirtualize) {
      setRange({ start: 0, end: entries.length });
      return;
    }

    const list = listRef.current;
    if (!list) return;

    const scrollParent = findScrollParent(list);
    const updateRange = () => {
      const scrollElement: HTMLElement | null = scrollParent === window ? null : (scrollParent as HTMLElement);
      const scrollerTop = scrollElement ? scrollElement.getBoundingClientRect().top : 0;
      const scrollerHeight = scrollElement ? scrollElement.clientHeight : window.innerHeight;
      const listTop = list.getBoundingClientRect().top;
      const visibleTop = Math.max(0, scrollerTop - listTop);
      const visibleBottom = Math.max(visibleTop + scrollerHeight, 0);
      const nextStart = Math.max(0, Math.floor(visibleTop / RAW_ESTIMATED_ROW_HEIGHT) - RAW_OVERSCAN_ROWS);
      const nextEnd = Math.min(
        entries.length,
        Math.ceil(visibleBottom / RAW_ESTIMATED_ROW_HEIGHT) + RAW_OVERSCAN_ROWS,
      );
      setRange((current) => (
        current.start === nextStart && current.end === nextEnd
          ? current
          : { start: nextStart, end: nextEnd }
      ));
    };

    updateRange();
    const frame = window.requestAnimationFrame(updateRange);
    scrollParent.addEventListener("scroll", updateRange, { passive: true });
    window.addEventListener("resize", updateRange);
    return () => {
      window.cancelAnimationFrame(frame);
      scrollParent.removeEventListener("scroll", updateRange);
      window.removeEventListener("resize", updateRange);
    };
  }, [entries.length, shouldVirtualize]);

  const visibleEntries = shouldVirtualize ? entries.slice(range.start, range.end) : entries;
  const topSpacer = shouldVirtualize ? range.start * RAW_ESTIMATED_ROW_HEIGHT : 0;
  const bottomSpacer = shouldVirtualize ? Math.max(0, entries.length - range.end) * RAW_ESTIMATED_ROW_HEIGHT : 0;

  return (
    <div ref={listRef} className={cn("font-mono", compact ? "space-y-1 text-(length:--text-micro)" : "space-y-1.5 text-xs")}>
      {topSpacer > 0 && <div aria-hidden="true" style={{ height: topSpacer }} />}
      {visibleEntries.map((entry, idx) => (
        <div
          key={`${entry.kind}-${entry.ts}-${range.start + idx}`}
          className={cn(
            "grid gap-x-3",
            "grid-cols-(--gtc-16)",
          )}
        >
          <span className="text-(length:--text-nano) uppercase tracking-(--tracking-caps) text-muted-foreground">
            {entry.kind}
          </span>
          <pre className="min-w-0 whitespace-pre-wrap break-words text-foreground/80">
            {rawEntryContent(entry)}
          </pre>
        </div>
      ))}
      {bottomSpacer > 0 && <div aria-hidden="true" style={{ height: bottomSpacer }} />}
    </div>
  );
}

export function RunTranscriptView({
  entries,
  toolDecisions,
  mode = "nice",
  density = "comfortable",
  limit,
  streaming = false,
  collapseStdout = false,
  emptyMessage = "No transcript yet.",
  className,
  thinkingClassName,
  externalReferences,
}: RunTranscriptViewProps) {
  const [messageExpansion, setMessageExpansion] = useState<MessageExpansion>({ open: false, revision: 0 });
  const toolDecisionMaps = useMemo(() => buildToolDecisionMaps(toolDecisions), [toolDecisions]);
  const blocks = useMemo(
    () => (mode === "raw" ? [] : normalizeTranscript(entries, streaming)),
    [entries, mode, streaming],
  );
  const visibleBlocks = limit ? blocks.slice(-limit) : blocks;
  const finalMessageIndex = visibleBlocks.findLastIndex(block =>
    block.type === "message" && block.role === "assistant"
    || block.type === "stdout" && !isPreparationText(block.text));
  const keyedBlocks = useMemo(() => keyTranscriptBlocks(visibleBlocks), [visibleBlocks]);
  const visibleEntries = limit ? entries.slice(-limit) : entries;

  if (entries.length === 0) {
    return (
      <div className={cn("rounded-2xl border border-dashed border-border/70 bg-background/40 p-4 text-sm text-muted-foreground", className)}>
        {emptyMessage}
      </div>
    );
  }

  if (mode === "raw") {
    return (
      <div className={className}>
        <RawTranscriptView entries={visibleEntries} density={density} />
      </div>
    );
  }

  return (
    <div className={cn("space-y-1", className)}>
      {visibleBlocks.some(block => block.type === "message_detail" || block.type === "message" || block.type === "stdout" || block.type === "event" && block.label === "result") && (
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" onClick={() => setMessageExpansion(value => ({ open: !value.open, revision: value.revision + 1 }))}>
            {messageExpansion.open ? "Collapse all messages" : "Expand all messages"}
          </Button>
        </div>
      )}
      {keyedBlocks.map(({ block, key }, index) => (
        <div
          key={key}
          className={cn(index === keyedBlocks.length - 1 && streaming && "tc-stream-block-enter")}
        >
          {(block.type === "round" || block.type === "assignment") && <TranscriptRound block={block} />}
          {block.type === "message_detail" && <TranscriptText text={block.summary} label={block.label} parts={block.parts} expansion={messageExpansion} streaming={streaming}
            plain={!block.parts[0]?.message.diagnostic && /assignment input|prep/i.test(block.label)} />}
          {block.type === "message" && (
            <TranscriptMessageBlock
              block={block}
              density={density}
              externalReferences={externalReferences}
              expansion={messageExpansion}
              plain={index === finalMessageIndex}
            />
          )}
          {block.type === "thinking" && (
            <TranscriptThinkingBlock
              block={block}
              density={density}
              className={thinkingClassName}
              externalReferences={externalReferences}
            />
          )}
          {block.type === "tool" && (
            <TranscriptToolCard
              block={block}
              density={density}
              decision={findToolDecision(toolDecisionMaps, block)}
            />
          )}
          {block.type === "command_group" && (
            <TranscriptCommandGroup block={block} density={density} toolDecisionMaps={toolDecisionMaps} />
          )}
          {block.type === "tool_group" && (
            <TranscriptToolGroup block={block} density={density} toolDecisionMaps={toolDecisionMaps} />
          )}
          {block.type === "diff_group" && <TranscriptDiffGroup block={block} density={density} />}
          {block.type === "stderr_group" && <TranscriptStderrGroup block={block} density={density} />}
          {block.type === "system_group" && <TranscriptSystemGroup block={block} density={density} />}
          {block.type === "stdout" && (
            <TranscriptStdoutRow block={block} density={density} collapseByDefault={collapseStdout} expansion={messageExpansion} plain={index === finalMessageIndex} />
          )}
          {block.type === "activity" && <TranscriptActivityRow block={block} density={density} />}
          {block.type === "event" && (
            <TranscriptEventRow
              block={block}
              density={density}
              externalReferences={externalReferences}
              expansion={messageExpansion}
            />
          )}
          {block.type === "provider_activity" && <TranscriptProviderActivity block={block} density={density} />}
        </div>
      ))}
    </div>
  );
}
