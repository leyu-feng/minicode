import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  agents, authUsers, budgetReservations, companies, companyMemberships, createDb, heartbeatRuns, issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { agentPoolBroker } from "../services/agent-pool-broker.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Worker capacity tests unavailable: ${support.reason}`);

describe.skipIf(!support.supported)("heartbeat AgentPool capacity queue", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const sockets: WebSocketServer[] = [];

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("heartbeat-agent-pool-capacity");
    db = createDb(database.connectionString);
    await db.insert(authUsers).values({
      id: "capacity-owner", name: "Fixture owner", email: "capacity@example.test",
      createdAt: new Date(), updatedAt: new Date(),
    });
    heartbeat = heartbeatService(db);
  }, 30_000);
  afterEach(async () => {
    agentPoolBroker.prepareExecution = undefined;
    for (const run of await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.status, "queued"))) {
      await heartbeat.cancelRun(run.id);
    }
    agentPoolBroker.close();
    await heartbeat.drainActiveRunExecutions();
    for (const run of await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.status, "queued"))) {
      await heartbeat.cancelRun(run.id);
    }
    for (const server of sockets.splice(0)) {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });

  async function fixture() {
    const [company] = await db.insert(companies).values({
      name: "Capacity fixture", issuePrefix: `Q${randomUUID().slice(0, 7)}`,
      defaultResponsibleUserId: "capacity-owner",
    }).returning();
    await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "user", principalId: "capacity-owner",
      status: "active", membershipRole: "member",
    });
    const [agent] = await db.insert(agents).values({
      companyId: company.id, name: "SqlDev", role: "engineer", status: "active",
      adapterType: "agent_pool", adapterConfig: { name: "windows" },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 20 } },
    }).returning();
    return { company, agent };
  }

  async function enqueue(agent: typeof agents.$inferSelect, priority = "medium") {
    const [issue] = await db.insert(issues).values({
      companyId: agent.companyId, title: "Capacity task", status: "todo", priority,
      assigneeAgentId: agent.id, responsibleUserId: "capacity-owner",
    }).returning();
    const run = await heartbeat.wakeup(agent.id, {
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: issue.id },
      contextSnapshot: { issueId: issue.id, wakeReason: "issue_assigned" },
    });
    if (!run) throw new Error("Expected durable queued run");
    return run;
  }

  async function worker(companyId: string) {
    const workerId = randomUUID();
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    sockets.push(server);
    server.on("connection", socket => agentPoolBroker.attach({ id: workerId, companyId, poolName: "windows" }, socket));
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected worker port");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const tasks: string[] = [];
    const send = (value: object) => socket.send(JSON.stringify(value));
    socket.on("message", data => {
      const message = JSON.parse(data.toString());
      if (message.type === "welcome") send({ type: "ready" });
      if (message.type === "task") tasks.push(message.runId);
      if (message.type === "cancel") send({ type: "result", runId: message.runId, seq: 1, exitCode: 0 });
      if (message.type === "ack" && message.completed) send({ type: "ready" });
    });
    await once(socket, "open");
    send({
      type: "hello", protocolVersion: 1, instanceId: randomUUID(), runId: null,
      capabilities: ["skill_bundle_v1", "pr_inspector_v1", "pr_inspection_result_v1",
        "inline_instructions_v1", "task_frame_512k_v1"],
    });
    await vi.waitFor(() => expect(agentPoolBroker.status(workerId)).toBe("idle"));
    return { tasks, workerId, finish: async (runId: string) => {
      const run = await heartbeat.getRun(runId);
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, String(run?.contextSnapshot?.issueId)));
      send({ type: "result", runId, seq: 1, exitCode: 0, summary: "Completed the assigned capacity fixture task." });
    } };
  }

  it("reserves one worker for twenty-slot agents and starts the next queued task once", async () => {
    const { company, agent } = await fixture();
    const client = await worker(company.id);
    const first = await enqueue(agent);
    await vi.waitFor(() => expect(client.tasks).toEqual([first.id]), { timeout: 10_000 });
    const waiting = await enqueue(agent, "critical");
    const cancelled = await enqueue(agent);
    expect(await heartbeat.getRun(waiting.id)).toMatchObject({ status: "queued", startedAt: null, errorCode: null });
    expect(await heartbeat.getRun(cancelled.id)).toMatchObject({ status: "queued", startedAt: null, errorCode: null });
    await heartbeat.cancelRun(cancelled.id);
    await client.finish(first.id);
    await vi.waitFor(() => expect(client.tasks).toEqual([first.id, waiting.id]), { timeout: 10_000 });
    await client.finish(waiting.id);
    await heartbeat.waitForRunExecutionDrain(waiting.id);
    await vi.waitFor(async () => expect((await heartbeat.getRun(waiting.id))?.status).toBe("succeeded"));
    expect((await heartbeat.getRun(cancelled.id))?.status).toBe("cancelled");
    expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, company.id),
      inArray(heartbeatRuns.status, ["failed", "timed_out"])))).toEqual([]);
  });

  it("retains queued work without workers across service recreation and shares capacity across agents", async () => {
    const { company, agent } = await fixture();
    const [other] = await db.insert(agents).values({
      companyId: company.id, name: "Other", role: "engineer", status: "active",
      adapterType: "agent_pool", adapterConfig: { name: "windows" },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 20 } },
    }).returning();
    const first = await enqueue(agent);
    const second = await enqueue(other);
    heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    expect((await heartbeat.getRun(first.id))?.status).toBe("queued");
    expect((await heartbeat.getRun(second.id))?.status).toBe("queued");
    const client = await worker(company.id);
    await Promise.all([
      heartbeat.resumeQueuedRunsForAgent(company.id, agent.id),
      heartbeat.resumeQueuedRunsForAgent(company.id, other.id),
    ]);
    await vi.waitFor(() => expect(client.tasks).toHaveLength(1), { timeout: 10_000 });
    const dispatched = client.tasks[0]!;
    const remaining = dispatched === first.id ? second : first;
    expect((await heartbeat.getRun(remaining.id))?.status).toBe("queued");
    await client.finish(dispatched);
    await heartbeat.waitForRunExecutionDrain(dispatched);
    await heartbeat.resumeQueuedRuns();
    await vi.waitFor(() => expect(client.tasks).toHaveLength(2), { timeout: 10_000 });
    expect(client.tasks[1]).toBe(remaining.id);
    await client.finish(remaining.id);
    await vi.waitFor(async () => expect((await heartbeat.getRun(remaining.id))?.status).toBe("succeeded"));
  });

  it("returns an undispatched run to the durable queue when its reserved worker disconnects", async () => {
    const { company, agent } = await fixture();
    const client = await worker(company.id);
    agentPoolBroker.prepareExecution = async (_ctx, options) => {
      expect(options).toEqual({ waitForWorker: false });
      agentPoolBroker.disconnect(client.workerId, "Fixture disconnect before dispatch");
    };
    const run = await enqueue(agent);
    await vi.waitFor(async () => {
      expect(await heartbeat.getRun(run.id)).toMatchObject({ status: "queued", startedAt: null, errorCode: null });
      expect(agentPoolBroker.status(client.workerId)).toBe("offline");
    }, { timeout: 10_000 });
    await heartbeat.waitForRunExecutionDrain(run.id);
    expect(client.tasks).toEqual([]);
    expect(await heartbeat.getRun(run.id)).toMatchObject({ costAccountingPending: false, costAccountedAt: null });
    expect(await db.select().from(budgetReservations).where(eq(budgetReservations.runId, run.id))).toEqual([]);
    agentPoolBroker.prepareExecution = undefined;
    const replacement = await worker(company.id);
    await heartbeat.resumeQueuedRunsForAgent(company.id, agent.id);
    await vi.waitFor(() => expect(replacement.tasks).toEqual([run.id]), { timeout: 10_000 });
    await replacement.finish(run.id);
    await vi.waitFor(async () => expect((await heartbeat.getRun(run.id))?.status).toBe("succeeded"));
  });
});
