import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentPools, companies, companyPrInspectors, createDb, heartbeatRuns, issues, issueWorkProducts, prInspectionResults } from "@paperclipai/db";
import { assertPrRevisionPublication, bindPrInspectionResult, prInspectionResultService } from "../services/pr-inspection-results.js";
import { agentPoolService } from "../services/agent-pools.js";
import type { AdapterExecutionContext } from "../adapters/types.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const input = {
  schema: "pr_inspection_result_v1" as const, outcome: "changes_requested" as const,
  submissionId: `submission-publication-${"a".repeat(64)}`, reviewedCommit: "b".repeat(40),
  body: "## Changes requested\n\nPreserve the requested blank line.",
};
function bindingFixture() {
  const companyId = randomUUID(), inspectorId = randomUUID(), producerId = randomUUID();
  const parent = { id: randomUUID(), companyId, assigneeAgentId: producerId };
  const actor = { agentId: inspectorId, runId: randomUUID() };
  const review = {
    id: randomUUID(), companyId, parentId: parent.id, assigneeAgentId: inspectorId, createdByAgentId: producerId,
    description: `Source task: ${parent.id}\nSource agent: ${producerId}\nSubmission ID: ${input.submissionId}\nRemote commit: ${input.reviewedCommit}\nRepository URL: https://dev.azure.com/fixture/project/_git/repository\nBranch: u/producer-one/feature`,
  };
  return { companyId, inspectorId, producerId, parent, actor, review };
}

describe("inspection receipt bindings", () => {
  it("derives provenance from the original review and parent, not the findings", () => {
    const f = bindingFixture();
    expect(bindPrInspectionResult(input, f.review, f.parent, f.actor)).toMatchObject({
      outcome: "changes_requested", companyId: f.companyId, sourceIssueId: f.parent.id,
      inspectorAgentId: f.inspectorId, sourceAgentId: f.producerId, runId: f.actor.runId,
    });
  });
  it("rejects foreign parents, reassignment, ambiguous handoffs and a different reviewed commit", () => {
    const f = bindingFixture();
    expect(() => bindPrInspectionResult(input, f.review, { ...f.parent, companyId: randomUUID() }, f.actor)).toThrow();
    expect(() => bindPrInspectionResult(input, f.review, { ...f.parent, id: randomUUID() }, f.actor)).toThrow();
    expect(() => bindPrInspectionResult(input, f.review, f.parent, { ...f.actor, agentId: f.producerId })).toThrow();
    expect(() => bindPrInspectionResult(input, { ...f.review, createdByAgentId: f.inspectorId }, f.parent, f.actor)).toThrow();
    expect(() => bindPrInspectionResult(input, {
      ...f.review, description: `${f.review.description}\nRemote commit: ${input.reviewedCommit}`,
    }, f.parent, f.actor)).toThrow();
    expect(() => bindPrInspectionResult({ ...input, reviewedCommit: "c".repeat(40) }, f.review, f.parent, f.actor)).toThrow();
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("durable inspection receipts", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-inspection-results-");
    db = createDb(temporary.connectionString);
  }, 90_000);
  afterAll(async () => { await temporary?.cleanup(); });

  async function fixture() {
    const f = bindingFixture();
    await db.insert(companies).values({ id: f.companyId, name: "Inspection fixture", issuePrefix: `P${f.companyId.slice(0, 7)}` });
    await db.insert(agents).values([
      { id: f.inspectorId, companyId: f.companyId, name: "Inspector", status: "running" },
      { id: f.producerId, companyId: f.companyId, name: "Producer" },
    ]);
    await db.insert(companyPrInspectors).values({ companyId: f.companyId, agentId: f.inspectorId });
    await db.insert(issues).values({ ...f.parent, title: "Producer task" });
    await db.insert(issues).values({ ...f.review, title: "Inspect submitted branch", status: "in_progress" });
    await db.insert(heartbeatRuns).values({
      id: f.actor.runId, companyId: f.companyId, agentId: f.inspectorId, status: "running",
      contextSnapshot: { issueId: f.review.id },
    });
    await db.update(issues).set({ checkoutRunId: f.actor.runId, executionRunId: f.actor.runId }).where(eq(issues.id, f.review.id));
    return { ...f, service: prInspectionResultService(db) };
  }

  async function revisionFixture(explicitHandoff = true, alias = false) {
    const f = await fixture();
    const original = await f.service.record(f.companyId, f.review.id, f.actor, { ...input, outcome: "approved" });
    const [product] = await db.insert(issueWorkProducts).values({ companyId: f.companyId, issueId: f.review.id,
      type: "pull_request", provider: "azure_devops", title: "Feature", status: "ready_for_review",
      url: `${original.result.repositoryUrl}/pullrequest/12`, createdByRunId: f.actor.runId,
      metadata: { publicationMode: "external", submissionId: input.submissionId, reviewedCommit: input.reviewedCommit,
        sourceBranch: original.result.branch, branch: "u/original-inspector/feature", sourceAgentId: f.producerId,
        inspectorAgentId: f.inspectorId, inspectionIssueId: f.review.id } }).returning();
    const revisionInput = { ...input, outcome: "approved" as const, reviewedCommit: "c".repeat(40),
      submissionId: `submission-publication-${"d".repeat(64)}`, body: "Fresh independent exact-SHA validation passed." };
    const actor = { agentId: f.inspectorId, runId: randomUUID() };
    const review = { ...f.review, id: randomUUID(),
      description: f.review.description.replace(input.submissionId, revisionInput.submissionId)
        .replace(input.reviewedCommit, revisionInput.reviewedCommit).replace("u/producer-one/feature", "u/producer-two/revision")
        .replace(original.result.repositoryUrl, alias
          ? "https://fixture.visualstudio.com/DefaultCollection/project/_git/repository" : original.result.repositoryUrl)
        + (explicitHandoff ? `\nRevision of inspection: ${f.review.id}` : "") };
    await db.update(issues).set({ status: "blocked", checkoutRunId: null, executionRunId: null }).where(eq(issues.id, f.review.id));
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.parent.id));
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.actor.runId));
    await db.insert(heartbeatRuns).values({ id: actor.runId, companyId: f.companyId, agentId: f.inspectorId,
      status: "running", contextSnapshot: { issueId: review.id } });
    await db.insert(issues).values({ ...review, title: "Review PR: Feature", status: "in_progress",
      executionRunId: actor.runId, checkoutRunId: actor.runId });
    return { ...f, original, product, revisionInput, revisionReview: review, revisionActor: actor,
      recordRevision: () => f.service.record(f.companyId, review.id, actor, revisionInput) };
  }

  it.each([true, false])("binds a fresh revision to the same PR without rewriting the original approval (explicit: %s)", async explicit => {
    const f = await revisionFixture(explicit);
    const receipt = await f.recordRevision();
    expect(receipt.result.revision).toEqual({ previousInspectionIssueId: f.review.id, previousReceiptId: f.original.id,
      workProductId: f.product.id, provider: "azure_devops", url: f.product.url,
      branch: "u/original-inspector/feature", expectedCommit: input.reviewedCommit });
    expect(await f.recordRevision()).toEqual(receipt);
    expect(await f.service.requireApproved(f.companyId, f.review.id, f.inspectorId)).toEqual(f.original);
    expect(await f.service.requireApproved(f.companyId, f.revisionReview.id, f.inspectorId, f.revisionActor.runId)).toEqual(receipt);
    const result = receipt.result, revision = result.revision!;
    const publication = { provider: revision.provider, url: revision.url,
      metadata: { submissionId: result.submissionId, reviewedCommit: result.reviewedCommit, sourceBranch: result.branch,
        sourceAgentId: result.sourceAgentId, inspectorAgentId: result.inspectorAgentId, inspectionIssueId: result.inspectionIssueId,
        branch: revision.branch, revisionOfInspectionIssueId: revision.previousInspectionIssueId,
        previousInspectionReceiptId: revision.previousReceiptId, previousWorkProductId: revision.workProductId,
        expectedPreviousCommit: revision.expectedCommit } };
    expect(() => assertPrRevisionPublication(result, publication)).not.toThrow();
    expect(() => assertPrRevisionPublication(result, { ...publication, url: `${publication.url}3` })).toThrow(/original PR/);
    expect(() => assertPrRevisionPublication(result, { ...publication,
      metadata: { ...publication.metadata, reviewedCommit: input.reviewedCommit } })).toThrow(/immutable inspection lineage/);
    await db.update(issueWorkProducts).set({ metadata: { ...f.product.metadata, branch: "u/other-worker/changed" } })
      .where(eq(issueWorkProducts.id, f.product.id));
    await expect(f.service.requireApproved(f.companyId, f.revisionReview.id, f.inspectorId)).rejects.toThrow(/original branch handoff/);
    expect(await f.service.get(f.companyId, f.review.id)).toEqual(f.original);
  });

  it("recognizes existing publication across Azure repository URL aliases on a legacy handoff", async () => {
    const f = await revisionFixture(false, true);
    expect((await f.recordRevision()).result.revision?.workProductId).toBe(f.product.id);
  });

  it("derives worker admission from publication lineage and rejects board-only associations without that lineage", async () => {
    const f = await revisionFixture(false);
    await db.insert(agentPools).values({ companyId: f.companyId, name: "pr-inspector", type: "devbox" });
    const ctx: AdapterExecutionContext = { runId: f.revisionActor.runId,
      agent: { id: f.inspectorId, companyId: f.companyId, name: "Inspector", adapterType: "agent_pool", adapterConfig: {} },
      config: { name: "pr-inspector" }, context: { issueId: f.revisionReview.id, paperclipPrRevisionRequired: false },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      onLog: async () => {}, onCancellationReady: async () => {} };
    await agentPoolService(db).prepareExecution(ctx);
    expect(ctx.context.paperclipPrRevisionRequired).toBe(true);
    ctx.context.issueId = f.review.id;
    await agentPoolService(db).prepareExecution(ctx);
    expect(ctx.context.paperclipPrRevisionRequired).toBe(false);
    await db.update(issueWorkProducts).set({ issueId: f.parent.id }).where(eq(issueWorkProducts.id, f.product.id));
    ctx.context.issueId = f.revisionReview.id;
    await agentPoolService(db).prepareExecution(ctx);
    expect(ctx.context.paperclipPrRevisionRequired).toBe(true);
    await expect(f.recordRevision()).rejects.toThrow(/original immutable inspection lineage/);
  });

  it("refuses a board-only PR association, changed provenance, terminal producer and inactive inspector", async () => {
    const f = await revisionFixture();
    await db.update(issueWorkProducts).set({ createdByRunId: null }).where(eq(issueWorkProducts.id, f.product.id));
    await expect(f.recordRevision()).rejects.toThrow(/provenance/);
    await db.update(issueWorkProducts).set({ createdByRunId: f.actor.runId }).where(eq(issueWorkProducts.id, f.product.id));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.parent.id));
    await expect(f.recordRevision()).rejects.toThrow(/reopen/);
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.parent.id));
    await db.update(issues).set({ description: `${f.revisionReview.description}\nRevision of inspection: ${f.review.id}` })
      .where(eq(issues.id, f.revisionReview.id));
    await expect(f.recordRevision()).rejects.toThrow(/revision handoff/);
    await db.update(issues).set({ description: f.revisionReview.description }).where(eq(issues.id, f.revisionReview.id));
    await db.update(companies).set({ status: "paused" }).where(eq(companies.id, f.companyId));
    await expect(f.recordRevision()).rejects.toThrow(/active, unpaused/);
    expect(await f.service.get(f.companyId, f.revisionReview.id)).toBeNull();
    expect(await f.service.get(f.companyId, f.review.id)).toEqual(f.original);
  });

  it("serializes concurrent retries, persists one immutable receipt, and scopes reads by company", async () => {
    const f = await fixture();
    const record = () => f.service.record(f.companyId, f.review.id, f.actor, input);
    const [first, retry] = await Promise.all([record(), record()]);
    expect(retry).toEqual(first);
    expect(await prInspectionResultService(db).get(f.companyId, f.review.id)).toEqual(first);
    expect(await f.service.get(randomUUID(), f.review.id)).toBeNull();
    const rows = await db.select().from(prInspectionResults).where(and(
      eq(prInspectionResults.companyId, f.companyId), eq(prInspectionResults.inspectionIssueId, f.review.id),
    ));
    expect(rows).toHaveLength(1);
    await expect(f.service.record(f.companyId, f.review.id, f.actor, { ...input, outcome: "approved" })).rejects.toThrow(/immutable/);
    await expect(f.service.requireApproved(f.companyId, f.review.id, f.inspectorId)).rejects.toThrow(/approved/);
  });

  it("requires the designated inspector's active company, run and checkout", async () => {
    const f = await fixture();
    await expect(f.service.record(f.companyId, f.review.id, { ...f.actor, agentId: f.producerId }, input)).rejects.toThrow(/Inspector/);
    await expect(f.service.record(f.companyId, f.review.id, { ...f.actor, runId: randomUUID() }, input)).rejects.toThrow(/active/);
    await db.update(companies).set({ status: "paused" }).where(eq(companies.id, f.companyId));
    await expect(f.service.record(f.companyId, f.review.id, f.actor, input)).rejects.toThrow(/active/);
    await db.update(companies).set({ status: "active" }).where(eq(companies.id, f.companyId));
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.actor.runId));
    await expect(f.service.record(f.companyId, f.review.id, f.actor, input)).rejects.toThrow(/active/);
    expect(await f.service.get(f.companyId, f.review.id)).toBeNull();
  });

  it("reconciles from a new owning run without replacing the original receipt provenance", async () => {
    const f = await fixture();
    const receipt = await f.service.record(f.companyId, f.review.id, f.actor, input);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.actor.runId));
    const retryActor = { ...f.actor, runId: randomUUID() };
    await db.insert(heartbeatRuns).values({
      id: retryActor.runId, companyId: f.companyId, agentId: f.inspectorId, status: "running",
      contextSnapshot: { issueId: f.review.id },
    });
    await db.update(issues).set({
      checkoutRunId: retryActor.runId, executionRunId: retryActor.runId,
    }).where(eq(issues.id, f.review.id));
    expect(await f.service.record(f.companyId, f.review.id, retryActor, input)).toEqual(receipt);
    await expect(f.service.record(f.companyId, f.review.id, retryActor, {
      ...input, body: "Different findings",
    })).rejects.toThrow(/immutable/);
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, f.actor.runId));
    expect(await f.service.get(f.companyId, f.review.id)).toEqual(receipt);
  });

  it("gates PR postback on approval bound to the current source task and original commit", async () => {
    const f = await fixture();
    await expect(f.service.requireApproved(f.companyId, f.review.id, f.inspectorId)).rejects.toThrow(/approved/);
    const receipt = await f.service.record(f.companyId, f.review.id, f.actor, { ...input, outcome: "approved" });
    expect(await f.service.requireApproved(f.companyId, f.review.id, f.inspectorId)).toEqual(receipt);
    await db.update(issues).set({
      description: f.review.description.replace(input.reviewedCommit, "c".repeat(40)),
    }).where(eq(issues.id, f.review.id));
    await expect(f.service.requireApproved(f.companyId, f.review.id, f.inspectorId)).rejects.toThrow(/original submission/);
    await db.update(issues).set({
      description: f.review.description.replace("u/producer-one/feature", "u/producer-one/other-feature"),
    }).where(eq(issues.id, f.review.id));
    await expect(f.service.requireApproved(f.companyId, f.review.id, f.inspectorId)).rejects.toThrow(/original branch handoff/);
  });
});
