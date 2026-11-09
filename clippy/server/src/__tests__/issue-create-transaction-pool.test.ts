import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agents, companyMemberships, createDb, issues, projects, projectWorkspaces } from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.js";
import {
  describeEmbeddedPostgres,
  routeApp,
  seedCompanyWithBoardAccess,
} from "./helpers/route-test-harness.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describeEmbeddedPostgres("issue create transaction connection reuse", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let rootDb: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-create-pool-");
    rootDb = createDb(database.connectionString);
  }, 20_000);
  afterAll(async () => { await database?.cleanup(); });

  async function withPool<T>(maxConnections: number, work: (db: ReturnType<typeof createDb>) => Promise<T>) {
    const db = createDb(database.connectionString, { maxConnections });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Issue creation exhausted its transaction pool")), 10_000);
    });
    const operation = work(db);
    try {
      return await Promise.race([operation, deadline]);
    } finally {
      clearTimeout(timer);
      await db.$client.end({ timeout: 0 });
      await Promise.allSettled([operation]);
    }
  }

  it("creates and replays concurrent human assignments with a single connection", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(rootDb, "Pool route");
    const agentId = randomUUID();
    await rootDb.insert(agents).values({
      id: agentId, companyId, name: "Paused assignee", status: "paused", adapterType: "codex_local",
    });
    const [parent] = await rootDb.insert(issues).values({ companyId, title: "Existing parent" }).returning();

    await withPool(1, async (db) => {
      const app = routeApp(db, actor, issueRoutes);
      const path = `/api/companies/${companyId}/issues`;
      const payload = (index: number) => ({
        parentId: parent.id, title: `Pool assignment ${index}`, status: "todo",
        assigneeAgentId: agentId, idempotencyKey: `pool:${index}`,
      });
      const responses = await Promise.all([0, 1].map((index) =>
        request(app).post(path).send(payload(index)).timeout(8_000).expect(201),
      ));
      const replay = await request(app).post(path).send(payload(0)).timeout(8_000).expect(200);
      expect(replay.body).toMatchObject({ id: responses[0].body.id, deduplicated: true });
      expect(await db.select().from(issues).where(eq(issues.parentId, parent.id))).toHaveLength(2);
    });
  });

  it("keeps configured-source workspace checks on the caller's connection", async () => {
    const { companyId, actor } = await seedCompanyWithBoardAccess(rootDb, "Pool workspace");
    const [project] = await rootDb.insert(projects).values({ companyId, name: "Source project" }).returning();
    const [workspace] = await rootDb.insert(projectWorkspaces).values({
      companyId, projectId: project.id, name: "Source", cwd: "fixture-workspace",
    }).returning();

    await withPool(1, async (db) => {
      const svc = issueService(db);
      const created = await db.transaction((tx) => svc.create(companyId, {
        title: "Configured source", projectId: project.id,
        createdByUserId: actor.userId, workspaceSelectionActor: actor,
        workspaceSelection: { kind: "configured_source", projectWorkspaceId: workspace.id, mode: "shared" },
      }, tx));
      expect(created.projectWorkspaceId).toBe(workspace.id);
    });
  });

  it("validates agent and user assignees written inside concurrent caller transactions", async () => {
    const { companyId, userId } = await seedCompanyWithBoardAccess(rootDb, "Pool validation");
    const agentId = randomUUID();
    const assigneeUserId = `assignee-${randomUUID()}`;
    await withPool(2, async (db) => {
      let entered = 0;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => { release = resolve; });
      const svc = issueService(db);
      const created = await Promise.all([0, 1].map((index) => db.transaction(async (tx) => {
        if (index === 0) {
          await tx.insert(agents).values({
            id: agentId, companyId, name: "New assignee", status: "active", adapterType: "codex_local",
          });
        } else {
          await tx.insert(companyMemberships).values({
            companyId, principalId: assigneeUserId, principalType: "user", status: "active",
          });
        }
        if (++entered === 2) release();
        await ready;
        return svc.create(companyId, {
          title: `Transactional assignee ${index}`, createdByUserId: userId,
          ...(index === 0 ? { assigneeAgentId: agentId } : { assigneeUserId }),
        }, tx);
      })));
      expect(created[0].assigneeAgentId).toBe(agentId);
      expect(created[1].assigneeUserId).toBe(assigneeUserId);
    });
  });
});
