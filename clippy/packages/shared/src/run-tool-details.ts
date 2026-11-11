import { z } from "zod";

export const AGENT_POOL_TOOL_DETAILS = "tool_details_v1";
export const AGENT_POOL_TRANSCRIPT_DETAILS = "transcript_details_v1";
const messagePartSchema = z.object({
  id: z.string().uuid(),
  part: z.number().int().nonnegative(),
  last: z.boolean(),
  label: z.string().max(160),
  diagnostic: z.boolean(),
}).strict();
export const runToolDetailSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  callId: z.string().uuid(),
  phase: z.enum(["start", "end"]),
  name: z.string().min(1).max(160),
  summary: z.string().max(200),
  ts: z.string().datetime(),
  cwd: z.string().max(2000),
  input: z.string().max(24000).optional(),
  output: z.string().max(24000).optional(),
  error: z.string().max(24000).optional(),
  durationMs: z.number().finite().nonnegative().optional(),
  truncated: z.boolean(),
  message: messagePartSchema.optional(),
}).strict();

export const runToolDetailRefSchema = z.object({
  schema: z.literal("run_tool_detail_ref_v1"),
  runId: z.string().uuid(),
  chunkId: z.string().uuid(),
}).strict();

export type RunToolDetail = z.infer<typeof runToolDetailSchema>;
export type RunToolDetailRef = z.infer<typeof runToolDetailRefSchema>;
export interface RunToolDetailPage {
  status: "available" | "expired" | "unavailable";
  input?: string;
  output?: string;
  error?: string;
  cwd?: string;
  durationMs?: number;
  truncated?: boolean;
  nextOffset?: number;
}

export const runToolSummarySchema = z.object({
  type: z.literal("clippy.tool"),
  callId: z.string().uuid(),
  phase: z.enum(["start", "end"]),
  name: z.string().max(160),
  summary: z.string().max(200),
  isError: z.boolean(),
  durationMs: z.number().finite().nonnegative().optional(),
  detailRef: runToolDetailRefSchema.nullable(),
  detailStatus: z.enum(["available", "unavailable"]),
}).strict();

export const runMessageSummarySchema = z.object({
  type: z.literal("clippy.message"),
  message: messagePartSchema,
  summary: z.string().max(200),
  detailRef: runToolDetailRefSchema.nullable(),
  detailStatus: z.enum(["available", "unavailable"]),
}).strict();
export type RunMessageSummary = z.infer<typeof runMessageSummarySchema>;

export const runRoundSummarySchema = z.object({
  type: z.literal("clippy.round"),
  executionId: z.string(),
  harness: z.string(),
  round: z.number().int().positive().optional(),
  action: z.enum(["round_start", "round_end", "model_request"]),
  summary: z.string(),
  status: z.enum(["completed", "failed", "cancelled"]).optional(),
}).strict();
