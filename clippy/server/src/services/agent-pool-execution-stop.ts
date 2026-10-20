import { z } from "zod";
import type { heartbeatRuns } from "@paperclipai/db";
import { claimedAdapterType } from "./conversation-continuation.js";

export const AGENT_POOL_STOP_SCHEMA = "agent_pool_stop_v1";

const receiptSchema = z.object({
  schema: z.literal(AGENT_POOL_STOP_SCHEMA),
  runId: z.string().uuid(),
  companyId: z.string().min(1),
  workerId: z.string().uuid(),
  instanceId: z.string().uuid(),
  resultSequence: z.number().int().positive(),
  stoppedAt: z.string().datetime(),
});

/** Only the broker writes this receipt, after result acknowledgement and ready. */
export function hasAgentPoolExecutionStop(
  run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "runnerProfileJson" | "resultJson">,
): boolean {
  const receipt = receiptSchema.safeParse(run.resultJson?.agentPoolStop);
  return claimedAdapterType(run) === "agent_pool" && receipt.success &&
    receipt.data.runId === run.id && receipt.data.companyId === run.companyId;
}
