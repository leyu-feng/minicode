import { and, eq } from "drizzle-orm";
import {
  agents, companies, companyPrInspectors, heartbeatRuns, issues, prInspectionResults, type Db,
} from "@paperclipai/db";
import {
  prInspectionResultSchema, recordPrInspectionResultSchema,
  type PrInspectionResult, type RecordPrInspectionResult,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";

type Review = Pick<typeof issues.$inferSelect,
  "id" | "companyId" | "parentId" | "assigneeAgentId" | "createdByAgentId" | "description">;

export function bindPrInspectionResult(
  input: RecordPrInspectionResult,
  review: Review,
  parent: Pick<typeof issues.$inferSelect, "id" | "companyId" | "assigneeAgentId">,
  actor: { agentId: string; runId: string },
): PrInspectionResult {
  const line = (name: string) => {
    const matches = (review.description ?? "").split(/\r?\n/).filter((value) => value.startsWith(`${name}: `));
    if (matches.length !== 1) throw unprocessable("Inspection requires one original branch handoff");
    return matches[0].slice(name.length + 2);
  };
  if (review.assigneeAgentId !== actor.agentId || parent.companyId !== review.companyId
    || parent.id !== review.parentId || !parent.assigneeAgentId || parent.assigneeAgentId === actor.agentId
    || review.createdByAgentId !== parent.assigneeAgentId
    || line("Source task") !== parent.id || line("Source agent") !== parent.assigneeAgentId)
    throw forbidden("Inspection must belong to this inspector and the original producer's parent task");
  if (input.submissionId !== line("Submission ID") || input.reviewedCommit !== line("Remote commit"))
    throw conflict("Inspection result must identify the exact original submission and remote commit");
  const parsed = prInspectionResultSchema.safeParse({
    schema: input.schema, outcome: input.outcome, submissionId: input.submissionId,
    reviewedCommit: input.reviewedCommit, companyId: review.companyId, inspectionIssueId: review.id,
    sourceIssueId: parent.id, inspectorAgentId: actor.agentId, sourceAgentId: parent.assigneeAgentId,
    runId: actor.runId, repositoryUrl: line("Repository URL"), branch: line("Branch"),
  });
  if (!parsed.success) throw unprocessable("The original inspection handoff is invalid");
  return parsed.data;
}

function projectReceipt(row: typeof prInspectionResults.$inferSelect) {
  const result = prInspectionResultSchema.parse(row.result);
  if (result.companyId !== row.companyId || result.inspectionIssueId !== row.inspectionIssueId
    || (row.createdByRunId && result.runId !== row.createdByRunId))
    throw conflict("Stored inspection receipt provenance does not match");
  return { id: row.id, result, body: row.body, createdAt: row.createdAt };
}

export function prInspectionResultService(db: Db) {
  async function get(companyId: string, inspectionIssueId: string) {
    const [row] = await db.select().from(prInspectionResults).where(and(
      eq(prInspectionResults.companyId, companyId),
      eq(prInspectionResults.inspectionIssueId, inspectionIssueId),
    ));
    return row ? projectReceipt(row) : null;
  }
  return {
    get,
    async requireApproved(companyId: string, inspectionIssueId: string, inspectorAgentId: string) {
      const receipt = await get(companyId, inspectionIssueId);
      if (!receipt || receipt.result.outcome !== "approved" || receipt.result.inspectorAgentId !== inspectorAgentId)
        throw forbidden("Record an approved inspection receipt before posting a PR");
      const [review] = await db.select().from(issues).where(and(
        eq(issues.companyId, companyId), eq(issues.id, inspectionIssueId),
      ));
      if (!review?.parentId) throw conflict("The approved inspection no longer identifies its source task");
      const [parent] = await db.select().from(issues).where(and(
        eq(issues.companyId, companyId), eq(issues.id, review.parentId),
      ));
      if (!parent) throw conflict("The approved inspection source task no longer exists");
      const current = bindPrInspectionResult({ ...receipt.result, body: receipt.body }, review, parent,
        { agentId: inspectorAgentId, runId: receipt.result.runId });
      if (JSON.stringify(current) !== JSON.stringify(receipt.result))
        throw conflict("The approved inspection no longer matches the original branch handoff");
      return receipt;
    },
    async record(companyId: string, inspectionIssueId: string, actor: { agentId: string; runId: string },
      rawInput: RecordPrInspectionResult) {
      const input = recordPrInspectionResultSchema.parse(rawInput);
      return db.transaction(async (tx) => {
        const [review] = await tx.select().from(issues).where(and(
          eq(issues.companyId, companyId), eq(issues.id, inspectionIssueId),
        )).for("update");
        if (!review) throw notFound("Inspection issue not found");
        const [policy] = await tx.select().from(companyPrInspectors)
          .where(eq(companyPrInspectors.companyId, companyId));
        if (policy?.agentId !== actor.agentId || review.assigneeAgentId !== actor.agentId)
          throw forbidden("Only the assigned company PR Inspector may record an inspection result");
        const [company] = await tx.select({ status: companies.status }).from(companies)
          .where(eq(companies.id, companyId));
        const [agent] = await tx.select({ status: agents.status }).from(agents)
          .where(and(eq(agents.id, actor.agentId), eq(agents.companyId, companyId)));
        const [run] = await tx.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.id, actor.runId), eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, actor.agentId),
        )).for("update");
        if (company?.status !== "active" || !agent || !["idle", "running"].includes(agent.status)
          || run?.status !== "running" || (run.issueId ?? run.nativeIssueId ?? run.contextSnapshot?.issueId) !== review.id
          || review.checkoutRunId !== actor.runId
          || (review.executionRunId && review.executionRunId !== actor.runId))
          throw forbidden("Inspection results require the active, unpaused, issue-owning inspector run");
        if (!review.parentId) throw unprocessable("Inspection requires the producer's parent task");
        const [parent] = await tx.select().from(issues).where(and(
          eq(issues.id, review.parentId), eq(issues.companyId, companyId),
        ));
        if (!parent) throw notFound("Inspection source issue not found");
        const result = bindPrInspectionResult(input, review, parent, actor);
        const [existing] = await tx.select().from(prInspectionResults).where(and(
          eq(prInspectionResults.companyId, companyId),
          eq(prInspectionResults.inspectionIssueId, review.id),
        ));
        if (existing) {
          const receipt = projectReceipt(existing);
          if (JSON.stringify({ ...receipt.result, runId: result.runId }) !== JSON.stringify(result)
            || existing.body !== input.body)
            throw conflict("An immutable inspection result already exists; retry the original inputs or inspect a new submission");
          return receipt;
        }
        if (review.status !== "in_progress")
          throw conflict("Record the inspection result before blocking or completing the review");
        const [saved] = await tx.insert(prInspectionResults).values({
          companyId, inspectionIssueId, createdByRunId: actor.runId, result, body: input.body,
        }).returning();
        return projectReceipt(saved);
      });
    },
  };
}
