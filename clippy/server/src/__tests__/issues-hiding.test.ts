import { randomUUID } from "node:crypto";
import express from "express";
import { eq } from "drizzle-orm";
import request from "supertest";
import { expect, it } from "vitest";
import { activityLog, issues } from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.js";
import { errorHandler } from "../middleware/index.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("task hiding", () => {
  const ctx = useEmbeddedPostgres("paperclip-task-hiding-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await resetCompanyIssueFixtures(db);
    },
  });

  async function seedTree() {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Task hiding");
    const rootId = randomUUID();
    const childId = randomUUID();
    const grandchildId = randomUUID();
    const unrelatedId = randomUUID();
    await ctx.db.insert(issues).values({
      id: rootId, companyId: company.companyId, title: "Root", status: "todo",
    });
    await ctx.db.insert(issues).values([
      { id: childId, companyId: company.companyId, parentId: rootId, title: "Child", status: "in_progress" },
      { id: unrelatedId, companyId: company.companyId, title: "Unrelated", status: "todo" },
    ]);
    await ctx.db.insert(issues).values({
      id: grandchildId, companyId: company.companyId, parentId: childId, title: "Grandchild", status: "done",
    });
    return { ...company, rootId, childId, grandchildId, unrelatedId };
  }

  it("preserves single-task Hide and explicitly hides descendants of an already-hidden root", async () => {
    const tree = await seedTree();
    const app = routeApp(ctx.db, tree.actor, issueRoutes);
    const hiddenAt = "2026-11-12T00:00:00.000Z";
    await request(app).patch(`/api/issues/${tree.rootId}`).send({ hiddenAt }).expect(200);
    expect((await issueService(ctx.db).list(tree.companyId)).map((row) => row.id).sort())
      .toEqual([tree.childId, tree.grandchildId, tree.unrelatedId].sort());

    const response = await request(app).post(`/api/issues/${tree.rootId}/hide-subtree`).send({}).expect(200);
    expect(response.body.hiddenIssueIds.sort()).toEqual([tree.childId, tree.grandchildId].sort());
    const root = await request(app).get(`/api/issues/${tree.rootId}`).expect(200);
    expect(root.body.hiddenAt).toBe(hiddenAt);
    expect((await issueService(ctx.db).list(tree.companyId)).map((row) => row.id)).toEqual([tree.unrelatedId]);
    const child = await request(app).get(`/api/issues/${tree.childId}`).expect(200);
    const grandchild = await request(app).get(`/api/issues/${tree.grandchildId}`).expect(200);
    expect(child.body.status).toBe("in_progress");
    expect(grandchild.body.status).toBe("done");
    const audit = await ctx.db.select().from(activityLog);
    expect(audit.filter((row) => row.details?.source === "hide_subtree").map((row) => row.entityId).sort())
      .toEqual([tree.childId, tree.grandchildId].sort());

    const retry = await request(app).post(`/api/issues/${tree.rootId}/hide-subtree`).send({}).expect(200);
    expect(retry.body.hiddenIssueIds).toEqual([]);
    expect(await ctx.db.select().from(activityLog)).toHaveLength(audit.length);

    await request(app).patch(`/api/issues/${tree.rootId}`).send({ hiddenAt: null }).expect(200);
    expect((await issueService(ctx.db).list(tree.companyId)).map((row) => row.id).sort())
      .toEqual([tree.rootId, tree.unrelatedId].sort());
  });

  it("traverses hidden intermediate tasks and preserves their original hide timestamps", async () => {
    const tree = await seedTree();
    const previousHiddenAt = new Date("2026-11-11T00:00:00.000Z");
    await ctx.db.update(issues).set({ hiddenAt: previousHiddenAt }).where(eq(issues.id, tree.childId));
    const response = await issueService(ctx.db).hideSubtree(tree.companyId, tree.rootId,
      { actorType: "user", actorId: tree.userId }, async () => true);
    expect(response.hiddenIssueIds.sort()).toEqual([tree.rootId, tree.grandchildId].sort());
    const [child] = await ctx.db.select().from(issues).where(eq(issues.id, tree.childId));
    expect(child?.hiddenAt).toEqual(previousHiddenAt);
  });

  it("rejects an inaccessible descendant without partially hiding the tree or writing audit events", async () => {
    const tree = await seedTree();
    await ctx.db.update(issues).set({
      visibility: "private", responsibleUserId: "another-user", createdByUserId: "another-user",
    }).where(eq(issues.id, tree.grandchildId));
    const app = routeApp(ctx.db, tree.actor, issueRoutes);
    await request(app).post(`/api/issues/${tree.rootId}/hide-subtree`).send({}).expect(403);
    expect((await ctx.db.select().from(issues)).every((row) => row.hiddenAt === null)).toBe(true);
    expect(await ctx.db.select().from(activityLog)).toEqual([]);
  });

  it("enforces company, read-only membership and board identity boundaries", async () => {
    const tree = await seedTree();
    const other = await seedCompanyWithBoardAccess(ctx.db, "Other hiding company");
    await ctx.db.insert(issues).values({
      companyId: other.companyId, parentId: tree.rootId, title: "Foreign descendant",
    });
    const otherApp = routeApp(ctx.db, other.actor, issueRoutes);
    await request(otherApp).post(`/api/issues/${tree.rootId}/hide-subtree`).send({}).expect(404);
    const viewer = {
      ...tree.actor,
      memberships: [{ companyId: tree.companyId, membershipRole: "viewer", status: "active" }],
    };
    await request(routeApp(ctx.db, viewer, issueRoutes))
      .post(`/api/issues/${tree.rootId}/hide-subtree`).send({}).expect(403);
    const agentApp = express();
    agentApp.use(express.json(), (req, _res, next) => {
      req.actor = { type: "agent", source: "agent_key", agentId: randomUUID(), companyId: tree.companyId };
      next();
    });
    agentApp.use("/api", issueRoutes(ctx.db, {} as never));
    agentApp.use(errorHandler);
    await request(agentApp).post(`/api/issues/${tree.rootId}/hide-subtree`).send({}).expect(403);
    expect((await ctx.db.select().from(issues)).every((row) => row.hiddenAt === null)).toBe(true);

    const result = await request(routeApp(ctx.db, tree.actor, issueRoutes))
      .post(`/api/issues/${tree.rootId}/hide-subtree`).send({}).expect(200);
    expect(result.body.hiddenIssueIds.sort()).toEqual([tree.rootId, tree.childId, tree.grandchildId].sort());
    const [foreign] = await ctx.db.select().from(issues).where(eq(issues.companyId, other.companyId));
    expect(foreign?.hiddenAt).toBeNull();
  });
});
