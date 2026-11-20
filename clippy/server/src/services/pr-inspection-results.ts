import { and, eq, ne, sql } from "drizzle-orm";
import {
  agents, companies, companyPrInspectors, heartbeatRuns, issues, issueWorkProducts, prInspectionResults, type Db,
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

function canonicalRepository(value: string) {
  const url = new URL(value);
  const legacy = url.hostname.match(/^([a-z0-9][a-z0-9-]*)\.visualstudio\.com$/i);
  if (legacy) {
    url.hostname = "dev.azure.com";
    url.pathname = `/${legacy[1]}${url.pathname.replace(/^\/defaultcollection(?=\/)/i, "")}`;
  }
  return url.href;
}

export type PrInspectionPublication = { provider?: string; url?: string | null; metadata?: Record<string, unknown> | null };

export function assertPrRevisionPublication(result: PrInspectionResult, publication?: PrInspectionPublication) {
  const revision = result.revision;
  if (!revision) return;
  const expected = { submissionId: result.submissionId, reviewedCommit: result.reviewedCommit,
    sourceAgentId: result.sourceAgentId, inspectorAgentId: result.inspectorAgentId,
    inspectionIssueId: result.inspectionIssueId, sourceBranch: result.branch, branch: revision.branch,
    revisionOfInspectionIssueId: revision.previousInspectionIssueId, previousInspectionReceiptId: revision.previousReceiptId,
    previousWorkProductId: revision.workProductId, expectedPreviousCommit: revision.expectedCommit };
  if (publication?.provider !== revision.provider || publication.url !== revision.url
    || Object.entries(expected).some(([key, value]) => publication.metadata?.[key] !== value))
    throw forbidden("A revision may record only its original PR and fresh immutable inspection lineage");
}

export function prInspectionResultService(db: Db) {
  async function assertActiveInspector(query: Pick<Db, "select">, review: typeof issues.$inferSelect,
    actor: { agentId: string; runId: string }) {
    const companyId = review.companyId;
    const [policy] = await query.select().from(companyPrInspectors).where(eq(companyPrInspectors.companyId, companyId));
    if (policy?.agentId !== actor.agentId || review.assigneeAgentId !== actor.agentId)
      throw forbidden("Only the assigned company PR Inspector may record an inspection result");
    const [company] = await query.select({ status: companies.status }).from(companies).where(eq(companies.id, companyId));
    const [agent] = await query.select({ status: agents.status }).from(agents)
      .where(and(eq(agents.id, actor.agentId), eq(agents.companyId, companyId)));
    const [run] = await query.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, actor.runId), eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, actor.agentId),
    )).for("update");
    if (company?.status !== "active" || !agent || !["idle", "running"].includes(agent.status)
      || run?.status !== "running" || (run.issueId ?? run.nativeIssueId ?? run.contextSnapshot?.issueId) !== review.id
      || review.checkoutRunId !== actor.runId || (review.executionRunId && review.executionRunId !== actor.runId))
      throw forbidden("Inspection results require the active, unpaused, issue-owning inspector run");
  }
  async function bindRevision(query: Pick<Db, "select">, review: Review, result: PrInspectionResult,
    recordedPreviousId?: string, discover = false) {
    const lines = (review.description ?? "").split(/\r?\n/).filter((line) => line.startsWith("Revision of inspection: "));
    let previousId = lines[0]?.slice("Revision of inspection: ".length) ?? recordedPreviousId;
    if (lines.length > 1 || (recordedPreviousId && previousId !== recordedPreviousId))
      throw conflict("The revision handoff no longer matches the recorded previous inspection");
    if (!previousId && discover) {
      const rows = await query.select({ id: issues.id, result: prInspectionResults.result }).from(issues)
        .innerJoin(prInspectionResults, and(eq(prInspectionResults.inspectionIssueId, issues.id),
          eq(prInspectionResults.companyId, issues.companyId)))
        .innerJoin(issueWorkProducts, and(eq(issueWorkProducts.issueId, issues.id),
          eq(issueWorkProducts.companyId, issues.companyId), eq(issueWorkProducts.type, "pull_request")))
        .where(and(eq(issues.companyId, result.companyId), eq(issues.parentId, result.sourceIssueId), ne(issues.id, review.id),
          eq(sql<string>`${prInspectionResults.result}->>'outcome'`, "approved"))).limit(101);
      if (rows.length > 100) throw conflict("Too many published inspections; an explicit revision handoff is required");
      const candidates = rows.filter((candidate) => canonicalRepository(candidate.result.repositoryUrl) === canonicalRepository(result.repositoryUrl));
      const superseded = new Set(candidates.map((candidate) =>
        prInspectionResultSchema.parse(candidate.result).revision?.previousInspectionIssueId));
      const latest = candidates.filter((candidate) => !superseded.has(candidate.id));
      if (latest.length > 1) throw conflict("Reconcile the unique latest published inspection before another verdict");
      previousId = latest[0]?.id;
      if (!previousId) {
        const products = await query.select({ url: issueWorkProducts.url }).from(issueWorkProducts).where(and(
          eq(issueWorkProducts.companyId, result.companyId), eq(issueWorkProducts.issueId, result.sourceIssueId),
          eq(issueWorkProducts.type, "pull_request"))).limit(101);
        if (products.length > 100 || products.some(product => product.url && URL.canParse(product.url)
          && canonicalRepository(product.url).startsWith(`${canonicalRepository(result.repositoryUrl).replace(/\/$/, "")}/pullrequest/`)))
          throw conflict("The existing PR requires its original immutable inspection lineage; a board-only association is not approval");
      }
    }
    if (!previousId) return result;
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(previousId)
      || previousId === review.id)
      throw unprocessable("A revision requires one distinct previous inspection UUID");
    const [previous] = await query.select().from(issues).where(and(
      eq(issues.companyId, result.companyId), eq(issues.id, previousId),
    ));
    const [row] = await query.select().from(prInspectionResults).where(and(
      eq(prInspectionResults.companyId, result.companyId), eq(prInspectionResults.inspectionIssueId, previousId),
    ));
    if (!previous || !row) throw conflict("The previous inspection and immutable approval are required");
    const receipt = projectReceipt(row), prior = receipt.result;
    if (prior.outcome !== "approved" || prior.sourceIssueId !== result.sourceIssueId
      || prior.sourceAgentId !== result.sourceAgentId || prior.inspectorAgentId !== result.inspectorAgentId
      || canonicalRepository(prior.repositoryUrl) !== canonicalRepository(result.repositoryUrl) || prior.reviewedCommit === result.reviewedCommit
      || prior.submissionId === result.submissionId)
      throw conflict("A revision must reinspect a new producer submission for the same approved task and repository");
    const parent = { id: result.sourceIssueId, companyId: result.companyId, assigneeAgentId: result.sourceAgentId };
    const original = bindPrInspectionResult({ ...prior, body: receipt.body }, previous, parent,
      { agentId: prior.inspectorAgentId, runId: prior.runId });
    if (Object.entries(original).some(([key, value]) => prior[key as keyof PrInspectionResult] !== value))
      throw conflict("The previous approval no longer matches its original handoff");
    const products = await query.select().from(issueWorkProducts).where(and(
      eq(issueWorkProducts.companyId, result.companyId), eq(issueWorkProducts.issueId, previousId),
      eq(issueWorkProducts.type, "pull_request"),
    ));
    if (products.length !== 1) throw conflict("A revision requires one original PR work product");
    const product = products[0], metadata = product.metadata;
    const [publisher] = product.createdByRunId ? await query.select({ agentId: heartbeatRuns.agentId }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, result.companyId), eq(heartbeatRuns.id, product.createdByRunId))) : [];
    if (publisher?.agentId !== result.inspectorAgentId || product.provider !== "azure_devops"
      || metadata?.publicationMode !== "external" || metadata.submissionId !== prior.submissionId
      || metadata.reviewedCommit !== prior.reviewedCommit || metadata.sourceBranch !== prior.branch
      || metadata.sourceAgentId !== prior.sourceAgentId || metadata.inspectorAgentId !== prior.inspectorAgentId
      || metadata.inspectionIssueId !== previousId || metadata.branch === prior.branch || metadata.branch === result.branch)
      throw conflict("The original PR provenance must match the independent approval and distinct inspector branch");
    return prInspectionResultSchema.parse({ ...result, revision: {
      previousInspectionIssueId: previousId, previousReceiptId: receipt.id, workProductId: product.id,
      provider: product.provider, url: product.url, branch: metadata.branch, expectedCommit: prior.reviewedCommit,
    } });
  }
  async function get(companyId: string, inspectionIssueId: string) {
    const [row] = await db.select().from(prInspectionResults).where(and(
      eq(prInspectionResults.companyId, companyId),
      eq(prInspectionResults.inspectionIssueId, inspectionIssueId),
    ));
    return row ? projectReceipt(row) : null;
  }
  return {
    get,
    async requireApproved(companyId: string, inspectionIssueId: string, inspectorAgentId: string, runId?: string) {
      const receipt = await get(companyId, inspectionIssueId);
      if (!receipt || receipt.result.outcome !== "approved" || receipt.result.inspectorAgentId !== inspectorAgentId)
        throw forbidden("Record an approved inspection receipt before posting a PR");
      const [review] = await db.select().from(issues).where(and(
        eq(issues.companyId, companyId), eq(issues.id, inspectionIssueId),
      ));
      if (!review?.parentId) throw conflict("The approved inspection no longer identifies its source task");
      if (runId) await assertActiveInspector(db, review, { agentId: inspectorAgentId, runId });
      const [parent] = await db.select().from(issues).where(and(
        eq(issues.companyId, companyId), eq(issues.id, review.parentId),
      ));
      if (!parent) throw conflict("The approved inspection source task no longer exists");
      const current = await bindRevision(db, review, bindPrInspectionResult({ ...receipt.result, body: receipt.body }, review, parent,
        { agentId: inspectorAgentId, runId: receipt.result.runId }), receipt.result.revision?.previousInspectionIssueId);
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
        await assertActiveInspector(tx, review, actor);
        if (!review.parentId) throw unprocessable("Inspection requires the producer's parent task");
        const [parent] = await tx.select().from(issues).where(and(
          eq(issues.id, review.parentId), eq(issues.companyId, companyId),
        ));
        if (!parent) throw notFound("Inspection source issue not found");
        const [existing] = await tx.select().from(prInspectionResults).where(and(
          eq(prInspectionResults.companyId, companyId),
          eq(prInspectionResults.inspectionIssueId, review.id),
        ));
        const result = await bindRevision(tx, review, bindPrInspectionResult(input, review, parent, actor),
          existing ? projectReceipt(existing).result.revision?.previousInspectionIssueId : undefined, !existing);
        if (existing) {
          const receipt = projectReceipt(existing);
          if (JSON.stringify({ ...receipt.result, runId: result.runId }) !== JSON.stringify(result)
            || existing.body !== input.body)
            throw conflict("An immutable inspection result already exists; retry the original inputs or inspect a new submission");
          return receipt;
        }
        if (result.revision && !["in_progress", "blocked"].includes(parent.status))
          throw conflict("An operator must reopen the producer task before a new revision inspection");
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
