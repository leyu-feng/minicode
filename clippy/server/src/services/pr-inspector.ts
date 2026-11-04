import { and, eq } from "drizzle-orm";
import { agents, agentPools, companyPrInspectors, type Db } from "@paperclipai/db";
import { conflict, forbidden } from "../errors.js";
import { prInspectionResultService } from "./pr-inspection-results.js";
import { withAccountingTransaction } from "./accounting-transaction.js";
import { requestAgentHireInTransaction, scheduleAgentLifecycle } from "./agent-lifecycle.js";

export function prInspectorService(db: Db) {
  async function get(companyId: string) {
    const [row] = await db.select({
      agentId: companyPrInspectors.agentId,
      agentStatus: agents.status,
    }).from(companyPrInspectors).leftJoin(agents, and(
      eq(agents.id, companyPrInspectors.agentId), eq(agents.companyId, companyId),
    )).where(eq(companyPrInspectors.companyId, companyId));
    return {
      agentId: row?.agentStatus && row.agentStatus !== "terminated" ? row.agentId : null,
      specialRole: "pr_inspector" as const,
    };
  }
  return {
    get,
    async assertPrPostbackAllowed(companyId: string, agentId: string | undefined, issueId: string) {
      const policy = await get(companyId);
      if (policy.agentId && policy.agentId !== agentId)
        throw forbidden("Only this company's PR Inspector may record a PR while an inspector exists.");
      if (policy.agentId) await prInspectionResultService(db).requireApproved(companyId, issueId, policy.agentId);
    },
    async create(companyId: string, userId: string | null) {
      const state = await withAccountingTransaction(db, companyId, async (tx, publications) => {
        const current = await prInspectorService(tx).get(companyId);
        if (current.agentId) return current;
        await tx.insert(agentPools).values({ companyId, name: "pr-inspector", type: "devbox" }).onConflictDoNothing();
        const [pool] = await tx.select().from(agentPools).where(and(
          eq(agentPools.companyId, companyId), eq(agentPools.name, "pr-inspector"),
        ));
        if (pool.type !== "devbox") throw conflict("The pr-inspector pool must have Devbox type; an incompatible pool already uses that name.");
        const inspector = await requestAgentHireInTransaction(tx, companyId, {
          name: "Pull Request (PR) Inspector", role: "qa", title: "PR Inspector",
          adapterType: "agent_pool", adapterConfig: { name: pool.name, harness: "default" },
          capabilities: "Review branches submitted by other agents, request corrections, and create PRs only after review. Never merge or enable auto-complete.",
        }, { createdByUserId: userId, runnerResolved: true }, publications);
        await tx.insert(companyPrInspectors).values({ companyId, agentId: inspector.id })
          .onConflictDoUpdate({ target: companyPrInspectors.companyId, set: { agentId: inspector.id, updatedAt: new Date() } });
        return { agentId: inspector.id, specialRole: "pr_inspector" as const };
      });
      if (state.agentId) scheduleAgentLifecycle(db, state.agentId);
      return state;
    },
    async assignmentPolicy(companyId: string, agentId: string) {
      return withAccountingTransaction(db, companyId, async (tx) => {
        const policy = await prInspectorService(tx).get(companyId);
        return { inspectorAgentId: policy.agentId, isInspector: policy.agentId === agentId };
      });
    },
  };
}
