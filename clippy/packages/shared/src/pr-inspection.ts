import { z } from "zod";
import { ISSUE_EXECUTION_DECISION_OUTCOMES } from "./constants.js";

export const PR_INSPECTION_RESULT_SCHEMA = "pr_inspection_result_v1";

export const recordPrInspectionResultSchema = z.object({
  schema: z.literal(PR_INSPECTION_RESULT_SCHEMA),
  outcome: z.enum(ISSUE_EXECUTION_DECISION_OUTCOMES),
  submissionId: z.string().regex(/^submission-publication-[a-f0-9]{64}$/),
  reviewedCommit: z.string().regex(/^[a-f0-9]{40}$/),
  body: z.string().trim().min(1).max(32000),
}).strict();

export const prInspectionResultSchema = recordPrInspectionResultSchema.omit({ body: true }).extend({
  companyId: z.string().uuid(),
  inspectionIssueId: z.string().uuid(),
  sourceIssueId: z.string().uuid(),
  inspectorAgentId: z.string().uuid(),
  sourceAgentId: z.string().uuid(),
  runId: z.string().uuid(),
  repositoryUrl: z.string().url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  }, "Inspection repositories require credential-free HTTPS URLs"),
  branch: z.string().regex(/^u\/[a-z0-9][a-z0-9_-]{0,23}\/[a-z0-9]+(?:-[a-z0-9]+)*$/i),
}).strict();

export type RecordPrInspectionResult = z.infer<typeof recordPrInspectionResultSchema>;
export type PrInspectionResult = z.infer<typeof prInspectionResultSchema>;
