import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import express from "express";
import request from "supertest";
import { WebSocket } from "ws";
import { ManagedIdentityCredential } from "@azure/identity";
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createDb, companies, agents, authUsers, heartbeatRuns, agentPools, agentPoolWorkers, activityLog, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentPoolService, hashAgentPoolToken } from "../services/agent-pools.js";
import { agentGitHubAuthService } from "../services/agent-github-auth.js";
import { prInspectorService } from "../services/pr-inspector.js";
import { agentPoolPairingRoutes, agentPoolRoutes } from "../routes/agent-pools.js";
import { issueRoutes } from "../routes/issues.js";
import { routeApp, seedCompanyWithBoardAccess } from "./helpers/route-test-harness.js";
import { errorHandler } from "../middleware/error-handler.js";
import { setupAgentPoolWebSocketServer } from "../realtime/agent-pool-ws.js";
import { AgentPoolCapacityWaitError, agentPoolBroker } from "../services/agent-pool-broker.js";
import { deleteCompany } from "../services/company-deletion.js";
import * as hostedWorkers from "../services/hosted-worker-client.js";
import * as remoteHttp from "../services/remote-http-fetch.js";
import type { AdapterExecutionContext } from "../adapters/types.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`AgentPool DB tests unavailable: ${support.reason}`);
let companyId: string;
const otherCompanyId = randomUUID();
const execFileAsync = promisify(execFile);

(support.supported ? describe : describe.skip)("AgentPool persistence and access", () => {
  let db: ReturnType<typeof createDb>;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("agent-pools");
    cleanup = started.cleanup;
    db = createDb(started.connectionString);
    await db.insert(companies).values({ id: otherCompanyId, name: "Other company", issuePrefix: "AO" });
    await db.insert(authUsers).values({ id: "board-user", name: "Board Operator", email: "operator@example.test",
      createdAt: new Date(), updatedAt: new Date() });
  });
  beforeEach(async () => {
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "AgentPool test", issuePrefix: `AP${companyId.slice(0, 8)}` });
    vi.spyOn(hostedWorkers, "defaultHostedWorkerConfig").mockReturnValue(null);
  });
  afterAll(async () => { agentPoolBroker.close(); await cleanup?.(); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  const instructionResources: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of instructionResources.splice(0).reverse()) await close();
  });

  async function instructionFixture() {
    const seeded = await seedCompanyWithBoardAccess(db, "Targeted worker instructions");
    const application = routeApp(db, seeded.actor, agentPoolRoutes, issueRoutes);
    const svc = agentPoolService(db);
    const pool = await svc.create(seeded.companyId, "operator");
    const [agent] = await db.insert(agents).values({
      companyId: seeded.companyId, name: "Paused operator agent", status: "paused",
      adapterType: "agent_pool", adapterConfig: { name: pool.name },
    }).returning();
    const http = createServer(application);
    const closeWs = setupAgentPoolWebSocketServer(http, db);
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    instructionResources.push(async () => {
      closeWs();
      await new Promise<void>(resolve => http.close(() => resolve()));
    });
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("Expected server port");
    const workers = [];
    for (const name of ["operator-spare", "operator-target"]) {
      const pairing = await svc.issuePairing(seeded.companyId, pool.id, name);
      const token = createHash("sha256").update(randomUUID()).digest("hex");
      await svc.pair(pairing.workerId, pairing.serverToken, token);
      const socket = new WebSocket(
        `ws://127.0.0.1:${address.port}/api/agent-pool/worker?workerId=${pairing.workerId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      await once(socket, "open");
      const instanceId = randomUUID();
      const messages: Array<Record<string, unknown>> = [];
      socket.on("message", data => messages.push(JSON.parse(data.toString())));
      socket.send(JSON.stringify({
        type: "hello", protocolVersion: 1, instanceId, runId: null,
        capabilities: ["skill_bundle_v1", "pr_inspector_v1", "pr_inspection_result_v1", "task_frame_512k_v1"],
      }));
      await vi.waitFor(() => expect(messages.some(message => message.type === "welcome")).toBe(true));
      socket.send(JSON.stringify({ type: "ready" }));
      await vi.waitFor(() => expect(agentPoolBroker.status(pairing.workerId)).toBe("idle"));
      workers.push({ id: pairing.workerId, instanceId, socket, messages });
    }
    const [spare, target] = workers;
    const base = `/api/companies/${seeded.companyId}/agent-pools/${pool.id}/workers`;
    const payload = {
      title: "Read-only local smoke test", description: "Report your working directory; do not modify any files.",
      assigneeAgentId: agent.id, idempotencyKey: randomUUID(),
    };
    return { ...seeded, application, svc, pool, agent, spare, target, base, payload };
  }

  it("identifies a worker and creates idempotent audited tasks with durable exact-worker pins", async () => {
    const f = await instructionFixture();
    const detail = await request(f.application).get(`${f.base}/${f.target.id}`).expect(200);
    expect(detail.body).toMatchObject({
      id: f.target.id, name: "operator-target", poolId: f.pool.id, paired: true, revoked: false, status: "idle",
      connection: { instanceId: f.target.instanceId, capabilities: expect.arrayContaining(["skill_bundle_v1"]) },
    });
    expect(detail.headers["cache-control"]).toBe("no-store");
    expect(JSON.stringify(detail.body)).not.toMatch(/Hash|Token/);
    const first = await request(f.application).post(`${f.base}/${f.target.id}/instructions`).send(f.payload).expect(201);
    expect(first.body).toMatchObject({
      status: "todo", assigneeAgentId: f.agent.id, description: f.payload.description,
      assigneeAdapterOverrides: { adapterConfig: { name: f.pool.name, targetWorkerId: f.target.id } },
    });
    const replay = await request(f.application).post(`${f.base}/${f.target.id}/instructions`).send(f.payload).expect(200);
    expect(replay.body).toMatchObject({ id: first.body.id, deduplicated: true, deduplicationReason: "idempotency_key" });
    const other = await request(f.application).post(`${f.base}/${f.spare.id}/instructions`).send(f.payload).expect(201);
    expect(other.body.id).not.toBe(first.body.id);
    expect(other.body.assigneeAdapterOverrides.adapterConfig.targetWorkerId).toBe(f.spare.id);
    const [saved] = await db.select().from(issues).where(eq(issues.id, first.body.id));
    const run = { id: randomUUID() };
    expect(agentPoolService(db).reserveQueuedRun(run, f.agent, saved)).toBe(true);
    expect(agentPoolBroker.reservedWorker(run.id)?.id).toBe(f.target.id);
    await request(f.application).post(`${f.base}/${f.target.id}/instructions`)
      .send({ ...f.payload, idempotencyKey: randomUUID() }).expect(409);
    agentPoolBroker.releaseReservation(run.id);
    expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toHaveLength(2);
    const audit = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, f.companyId), eq(activityLog.entityId, first.body.id), eq(activityLog.action, "issue.created"),
    ));
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({ targetWorkerId: f.target.id, agentPoolId: f.pool.id });
    expect(f.spare.messages.some(message => message.type === "task")).toBe(false);
    expect(f.target.messages.some(message => message.type === "task")).toBe(false);
  });

  it("rejects foreign identities, non-board callers and malformed instruction bodies without creating work", async () => {
    const f = await instructionFixture();
    const other = await seedCompanyWithBoardAccess(db, "Unrelated company");
    const foreign = await f.svc.create(other.companyId, "foreign");
    const unpaired = await f.svc.issuePairing(f.companyId, f.pool.id, "unpaired-target");
    const [foreignAgent, nonPoolAgent, wrongPoolAgent] = await db.insert(agents).values([
      { companyId: other.companyId, name: "Foreign agent", adapterType: "agent_pool", adapterConfig: { name: f.pool.name } },
      { companyId: f.companyId, name: "Other adapter", adapterType: "process" },
      { companyId: f.companyId, name: "Other pool", adapterType: "agent_pool", adapterConfig: { name: "another" } },
    ]).returning();
    await request(f.application).get(`/api/companies/${f.companyId}/agent-pools/${foreign.id}/workers/${f.target.id}`).expect(404);
    await request(f.application).post(`${f.base}/${randomUUID()}/instructions`).send(f.payload).expect(404);
    await request(f.application).post(`${f.base}/${unpaired.workerId}/instructions`).send(f.payload).expect(409);
    for (const [agentId, status] of [[foreignAgent.id, 404], [nonPoolAgent.id, 400], [wrongPoolAgent.id, 400]] as const) {
      await request(f.application).post(`${f.base}/${f.target.id}/instructions`)
        .send({ ...f.payload, assigneeAgentId: agentId }).expect(status);
    }
    for (const patch of [
      { description: " " }, { idempotencyKey: "not-a-uuid" }, { assigneeAgentId: null },
      { status: "in_progress" }, { assigneeAdapterOverrides: { adapterConfig: { targetWorkerId: f.spare.id } } },
    ]) {
      await request(f.application).post(`${f.base}/${f.target.id}/instructions`).send({ ...f.payload, ...patch }).expect(400);
    }
    const agentApp = routeApp(db, { type: "agent", agentId: f.agent.id, companyId: f.companyId, source: "api_key" }, agentPoolRoutes, issueRoutes);
    await request(agentApp).get(`${f.base}/${f.target.id}`).expect(403);
    await request(agentApp).post(`${f.base}/${f.target.id}/instructions`).send(f.payload).expect(403);
    const foreignBoard = routeApp(db, other.actor, agentPoolRoutes, issueRoutes);
    await request(foreignBoard).post(`${f.base}/${f.target.id}/instructions`).send(f.payload).expect(403);
    expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toEqual([]);
  });

  it("rejects offline, reconnecting, revoked and incompatible targets even with an idle spare", async () => {
    const f = await instructionFixture();
    await db.update(agents).set({ adapterConfig: { name: f.pool.name, instructionsFilePath: "managed/AGENTS.md" } })
      .where(eq(agents.id, f.agent.id));
    await request(f.application).post(`${f.base}/${f.target.id}/instructions`).send(f.payload).expect(409);
    await db.update(agents).set({ adapterConfig: { name: f.pool.name } }).where(eq(agents.id, f.agent.id));
    const closed = once(f.target.socket, "close");
    f.target.socket.terminate();
    await closed;
    await vi.waitFor(() => expect(agentPoolBroker.status(f.target.id)).toBe("reconnecting"));
    await request(f.application).post(`${f.base}/${f.target.id}/instructions`).send(f.payload).expect(409);
    agentPoolBroker.disconnect(f.target.id, "Test target disconnected");
    await request(f.application).post(`${f.base}/${f.target.id}/instructions`).send(f.payload).expect(409);
    await f.svc.revoke(f.companyId, f.pool.id, f.target.id);
    await request(f.application).post(`${f.base}/${f.target.id}/instructions`).send(f.payload).expect(409);
    expect(agentPoolBroker.status(f.spare.id)).toBe("idle");
    expect(f.spare.messages.some(message => message.type === "task")).toBe(false);
    expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toEqual([]);
  });

  function hostedProvider() {
    const poolId = randomUUID();
    const config = { apiUrl: "https://provider.example/v1/hosted-worker", audience: "api://provider" };
    const repos = [
      { id: "main", name: "Main", branch: "main", isDefault: true },
      { id: "other", name: "Other", branch: "release", isDefault: false },
    ];
    const client = {
      create: vi.fn(async () => poolId), delete: vi.fn(async () => {}),
      status: vi.fn(async () => ({ activeWorkers: 1, provisioningWorkers: 1, isMock: true })),
      repositories: vi.fn(async () => repos), report: vi.fn(async () => {}),
      harnesses: vi.fn(async () => [{ id: "default", name: "default" }, { id: "pi", name: "pi" }]),
      claim: vi.fn(async () => {}),
    };
    vi.spyOn(hostedWorkers, "hostedWorkerClient").mockReturnValue(client);
    vi.mocked(hostedWorkers.defaultHostedWorkerConfig).mockReturnValue(config);
    return { config, client, poolId };
  }

  it("returns organization names only to the configured Hosted provider", async () => {
    const provider = hostedProvider();
    const svc = agentPoolService(db);
    await svc.ensureDefault(companyId);
    const grant = { ...provider.config, clientId: randomUUID(), principalId: randomUUID() };
    expect(await svc.hostedOrganizationNames(grant)).toContainEqual({ companyId, name: "AgentPool test" });
    await expect(svc.hostedOrganizationNames({ ...grant, audience: "api://other" })).rejects.toThrow();
  });

  it("retains the built-in host's pool ID and validates company-scoped repository choices", async () => {
    const provider = hostedProvider();
    const svc = agentPoolService(db);
    const pool = await svc.ensureDefault(companyId);
    expect(pool).toMatchObject({ type: "hosted", hostedPoolId: provider.poolId });
    expect(await svc.validateAgentRepositories(companyId, { name: pool.name })).toMatchObject({ primaryRepositoryId: "main" });
    expect(await svc.validateAgentRepositories(companyId, {
      name: pool.name, primaryRepositoryId: "other", referenceRepositoryIds: ["main"],
    })).toMatchObject({ primaryRepositoryId: "other", referenceRepositoryIds: ["main"] });
    await expect(svc.validateAgentRepositories(companyId, {
      name: pool.name, primaryRepositoryId: "unknown",
    })).rejects.toThrow("this pool's catalog");
    await expect(svc.validateAgentRepositories(companyId, {
      name: pool.name, primaryRepositoryId: "main", referenceRepositoryIds: ["main"],
    })).rejects.toThrow("distinct");
    await svc.report(companyId, pool.id, 4);
    expect(provider.client.report).toHaveBeenCalledWith(provider.poolId, 4);
    await expect(svc.status(otherCompanyId, pool.id)).rejects.toThrow("not found");
    await expect(svc.issuePairing(companyId, pool.id, "manual-worker")).rejects.toThrow("Only Devbox pools");
    expect(provider.client.create).toHaveBeenCalledTimes(1);
  });

  it("persists the Claude default for API-selected harnesses without replacing an explicit model", async () => {
    const provider = hostedProvider();
    provider.client.harnesses.mockResolvedValue([{ id: "claudecode", name: "Claude Code" }]);
    const svc = agentPoolService(db);
    await svc.ensureDefault(companyId);
    expect(await svc.validateAgentRepositories(companyId, { name: "default", harness: "claudecode" }))
      .toMatchObject({ harness: "claudecode", harnessModel: "claude-sonnet-5" });
    expect(await svc.validateAgentRepositories(companyId, { name: "default", harness: "claudecode", harnessModel: "claude-opus-4.6" }))
      .toMatchObject({ harnessModel: "claude-opus-4.6" });
    expect(await svc.validateAgentRepositories(companyId, { name: "default" })).not.toHaveProperty("harnessModel");
  });

  it("reports durable Hosted queue demand across service recreation and clears it after cancellation", async () => {
    const provider = hostedProvider();
    const svc = agentPoolService(db);
    await svc.ensureDefault(companyId);
    const [hosted, devbox] = await db.insert(agents).values([
      { companyId, name: "Hosted queue", adapterType: "agent_pool", adapterConfig: { name: "default" } },
      { companyId, name: "Devbox queue", adapterType: "agent_pool", adapterConfig: { name: "windows" } },
    ]).returning();
    const [override] = await db.insert(issues).values({
      companyId, title: "Use Hosted", assigneeAgentId: devbox.id,
      assigneeAdapterOverrides: { adapterConfig: { name: "default" } },
    }).returning();
    await db.insert(heartbeatRuns).values([
      { companyId, agentId: hosted.id, status: "queued", invocationSource: "assignment" },
      { companyId, agentId: devbox.id, status: "queued", invocationSource: "assignment",
        contextSnapshot: { issueId: override.id } },
      { companyId, agentId: devbox.id, status: "queued", invocationSource: "assignment" },
      { companyId, agentId: hosted.id, status: "running", invocationSource: "assignment" },
    ]);
    await agentPoolService(db).reportQueuedDemand();
    expect(provider.client.report).toHaveBeenCalledWith(provider.poolId, 2, expect.any(AbortSignal));
    provider.client.report.mockClear();
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.companyId, companyId));
    await agentPoolService(db).reportQueuedDemand();
    expect(provider.client.report).toHaveBeenCalledWith(provider.poolId, 0, expect.any(AbortSignal));
    expect(agentPoolBroker.hasConnectedWorker(companyId, "default")).toBe(false);
  });

  it("discovers provider harnesses only for the owning company and validates agent choices", async () => {
    const provider = hostedProvider();
    const svc = agentPoolService(db);
    const pool = await svc.ensureDefault(companyId);
    expect(await svc.harnesses(companyId, pool.id)).toEqual(await provider.client.harnesses());
    await expect(svc.harnesses(otherCompanyId, pool.id)).rejects.toThrow("not found");
    await expect(svc.validateAgentRepositories(companyId, { name: "default", harness: "pi" }))
      .resolves.toMatchObject({ harness: "pi" });
    await expect(svc.validateAgentRepositories(companyId, { name: "default", harness: "missing" }))
      .rejects.toThrow("not available");
    const devbox = await svc.create(companyId, "local");
    await expect(svc.validateAgentRepositories(companyId, { name: devbox.name, harness: "pi" }))
      .rejects.toThrow("Hosted pools");
    await expect(svc.harnesses(companyId, devbox.id)).resolves.toEqual([{ id: "default", name: "Default" }]);
  });

  it("rejects board revocation of Hosted workers without changing their credentials", async () => {
    const provider = hostedProvider();
    const svc = agentPoolService(db);
    const pool = await svc.ensureDefault(companyId);
    const grant = { ...provider.config, clientId: randomUUID(), principalId: randomUUID() };
    const input = {
      companyId, poolId: provider.poolId, poolName: pool.name,
      workerId: randomUUID(), clientToken: "c".repeat(64),
    };
    await svc.pairHostedWorker(input, grant);
    const before = await svc.workers(companyId, pool.id);
    const response = await request(app())
      .delete(`/api/companies/${companyId}/agent-pools/${pool.id}/workers/${input.workerId}`).expect(409);
    expect(response.body.error).toBe("Only Devbox pools support manual worker revocation.");
    expect(await svc.workers(companyId, pool.id)).toEqual(before);
    expect(await svc.authenticate(input.workerId, input.clientToken)).toMatchObject({ companyId, poolName: pool.name });
    await expect(svc.revokeHostedWorker(input, grant)).resolves.toMatchObject({ revoked: true });
    expect(await svc.authenticate(input.workerId, input.clientToken)).toBeNull();
  });

  it("uses the entire v2 repository catalog without retaining primary or reference selections", async () => {
    const provider = hostedProvider();
    vi.mocked(hostedWorkers.hostedWorkerClient).mockReturnValue({
      ...provider.client, repositories: vi.fn(async () => [
        { id: "supervisory", name: "shared-guidance", branch: "main", readOnly: true, supervisory: true, isDefault: false, workspaceMode: "all_repositories" as const },
        { id: "writable", name: "Main", branch: "main", readOnly: false, isDefault: false, workspaceMode: "all_repositories" as const },
        { id: "reference", name: "Reference", branch: "release", readOnly: true, isDefault: false, workspaceMode: "all_repositories" as const },
      ]),
    });
    const svc = agentPoolService(db);
    const pool = await svc.ensureDefault(companyId);
    expect(await svc.validateAgentRepositories(companyId, {
      name: pool.name, primaryRepositoryId: "removed", referenceRepositoryIds: ["removed"], keep: "setting",
    })).toEqual({ name: pool.name, keep: "setting" });
  });

  it("keeps an unconfigured default Hosted, reports missing deployment settings, and still permits company deletion", async () => {
    const svc = agentPoolService(db);
    const pool = await svc.ensureDefault(companyId);
    expect(pool).toMatchObject({ type: "hosted", name: "default", hostedPoolId: null });
    await expect(svc.status(companyId, pool.id)).rejects.toThrow("built-in agent host is not configured");
    expect(await deleteCompany(db, companyId)).toMatchObject({ id: companyId });
  });

  it("reads legacy pools as Devbox without converting an existing default or its stored settings", async () => {
    const [legacy] = await db.insert(agentPools).values({ companyId, name: "default", type: "freelance" }).returning();
    const provider = hostedProvider();
    const svc = agentPoolService(db);
    expect(await svc.ensureDefault(companyId)).toMatchObject({ id: legacy.id, type: "devbox", hostedPoolId: null });
    expect(await svc.list(companyId)).toContainEqual(expect.objectContaining({ id: legacy.id, type: "devbox" }));
    const [stored] = await db.select().from(agentPools).where(eq(agentPools.id, legacy.id));
    expect(stored.type).toBe("freelance");
    expect(provider.client.create).not.toHaveBeenCalled();
  });

  it("does not silently abandon a previously configured pending host pool when deployment settings disappear", async () => {
    hostedProvider();
    const svc = agentPoolService(db);
    const [pool] = await svc.list(companyId);
    vi.mocked(hostedWorkers.defaultHostedWorkerConfig).mockReturnValue(null);
    await expect(deleteCompany(db, companyId)).rejects.toThrow("built-in agent host is not configured");
    expect(await svc.get(companyId, pool.id)).toMatchObject({ type: "hosted", hostedPoolId: null });
  });

  it.each(["default", "hosted"])("refuses an outstanding manual pairing token on a %s pool", async (kind) => {
    const [pool] = await db.insert(agentPools).values({
      companyId, name: kind === "default" ? "default" : "managed", type: kind === "default" ? "freelance" : "hosted",
    }).returning();
    const serverToken = "s".repeat(64);
    const [worker] = await db.insert(agentPoolWorkers).values({
      poolId: pool.id, name: "previously-issued", pairingTokenHash: hashAgentPoolToken(serverToken),
      pairingExpiresAt: new Date(Date.now() + 60_000),
    }).returning();
    await expect(agentPoolService(db).pair(worker.id, serverToken, "a".repeat(64))).rejects.toThrow("pairing token");
  });

  it("creates only Devbox additional pools and exposes no type or provider-settings mutation", async () => {
    const provider = hostedProvider();
    const base = `/api/companies/${companyId}/agent-pools`;
    const svc = agentPoolService(db);
    const hosted = await svc.ensureDefault(companyId);
    const created = await request(app()).post(base).send({ name: "dev-machines" }).expect(201);
    expect(created.body).toMatchObject({ type: "devbox", hostedPoolId: null });
    const pairing = await svc.issuePairing(companyId, created.body.id, "devbox");
    const token = "a".repeat(64);
    await svc.pair(pairing.workerId, pairing.serverToken, token);
    await request(app()).patch(`${base}/${created.body.id}`).send({ type: "hosted", clearPairings: true, config: provider.config }).expect(404);
    await request(app()).patch(`${base}/${hosted.id}`).send({ type: "devbox", clearPairings: true }).expect(404);
    await request(app()).post(base).send({ name: "third-party", type: "hosted", config: provider.config }).expect(400);
    await request(app()).post(`${base}/${hosted.id}/workers`).send({ name: "manual" }).expect(409);
    expect(await svc.authenticate(pairing.workerId, token)).not.toBeNull();
    expect(provider.client.create).toHaveBeenCalledTimes(1);
  });

  it("bootstraps a new company's default Hosted pool once when a provider is configured", async () => {
    const provider = hostedProvider();
    const id = randomUUID();
    await db.insert(companies).values({ id, name: "Hosted company", issuePrefix: "HC" });
    const svc = agentPoolService(db);
    const pool = await svc.ensureDefault(id);
    expect(pool).toMatchObject({ companyId: id, name: "default", type: "hosted", hostedPoolId: provider.poolId });
    await svc.ensureDefault(id);
    await svc.list(id);
    expect(provider.client.create).toHaveBeenCalledTimes(1);
    await deleteCompany(db, id);
    expect(provider.client.delete).toHaveBeenCalledWith(provider.poolId);
  });

  it("allows the built-in host to revoke workers during company deletion", async () => {
    const provider = hostedProvider();
    const svc = agentPoolService(db);
    const pool = await svc.ensureDefault(companyId);
    const grant = { ...provider.config, clientId: randomUUID(), principalId: randomUUID() };
    const input = { companyId, poolId: provider.poolId, poolName: pool.name, workerId: randomUUID(), clientToken: "c".repeat(64) };
    await svc.pairHostedWorker(input, grant);
    let revocation: Promise<unknown> | undefined;
    provider.client.delete.mockImplementationOnce(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        revocation = svc.revokeHostedWorker(input, grant);
        await Promise.race([revocation, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Provider revocation callback blocked")), 1000);
        })]);
      } finally {
        clearTimeout(timer);
      }
    });
    try {
      await expect(deleteCompany(db, companyId)).resolves.toMatchObject({ id: companyId });
      expect(await svc.authenticate(input.workerId, input.clientToken)).toBeNull();
    } finally {
      await revocation;
    }
  });

  it("uses deployment settings rather than stored provider overrides and refuses takeover or revoked resurrection", async () => {
    const provider = hostedProvider();
    const svc = agentPoolService(db);
    const pool = await svc.ensureDefault(companyId);
    await db.update(agentPools).set({
      hostedApiUrl: "https://old-provider.example/v1/hosted-worker", hostedAudience: "api://old",
    }).where(eq(agentPools.id, pool.id));
    await svc.status(companyId, pool.id);
    expect(hostedWorkers.hostedWorkerClient).toHaveBeenLastCalledWith(provider.config);
    const grant = { ...provider.config, clientId: randomUUID(), principalId: randomUUID() };
    const input = { companyId, poolId: provider.poolId, poolName: pool.name, workerId: randomUUID(), clientToken: "a".repeat(64) };
    await expect(svc.pairHostedWorker(input, { ...grant, audience: "api://wrong" })).rejects.toThrow("does not own");
    await expect(svc.pairHostedWorker({ ...input, companyId: otherCompanyId }, grant)).rejects.toThrow("not registered");
    await expect(svc.pairHostedWorker(input, grant)).resolves.toMatchObject({ created: true });
    await expect(svc.pairHostedWorker(input, grant)).resolves.toMatchObject({ created: false });
    await expect(svc.pairHostedWorker({ ...input, clientToken: "b".repeat(64) }, grant)).rejects.toThrow("another credential");
    expect(await svc.authenticate(input.workerId, input.clientToken)).toMatchObject({ companyId, poolName: pool.name });
    await expect(svc.revokeHostedWorker({ ...input, companyId: otherCompanyId }, grant)).resolves.toMatchObject({ revoked: false });
    expect(await svc.authenticate(input.workerId, input.clientToken)).not.toBeNull();
    await svc.revokeHostedWorker(input, grant);
    expect(await svc.authenticate(input.workerId, input.clientToken)).toBeNull();
    await expect(svc.pairHostedWorker(input, grant)).rejects.toThrow("revoked");
  });

  it("reuses a revoked shared slot with rotated credentials and fences late revocation by generation", async () => {
    const provider = hostedProvider();
    const svc = agentPoolService(db);
    const pool = await svc.ensureDefault(companyId);
    const grant = { ...provider.config, clientId: randomUUID(), principalId: randomUUID() };
    const input = {
      companyId, poolId: provider.poolId, poolName: pool.name, workerId: randomUUID(),
      executionId: randomUUID(), generation: randomUUID(), clientToken: "a".repeat(64),
    };
    await svc.pairHostedWorker(input, grant);
    expect(await svc.authenticate(input.workerId, input.clientToken)).toMatchObject({ executionId: input.executionId });
    const replacement = { ...input, executionId: randomUUID(), generation: randomUUID(), clientToken: "b".repeat(64) };
    await expect(svc.pairHostedWorker(replacement, grant)).rejects.toThrow("another credential");
    await svc.revokeHostedWorker(input, grant);
    await expect(svc.pairHostedWorker(replacement, grant)).resolves.toMatchObject({ created: false, reactivated: true });
    expect(await svc.authenticate(input.workerId, input.clientToken)).toBeNull();
    expect(await svc.authenticate(input.workerId, replacement.clientToken)).toMatchObject({ executionId: replacement.executionId });
    await expect(svc.revokeHostedWorker(input, grant)).resolves.toMatchObject({ revoked: false });
    expect(await svc.authenticate(input.workerId, replacement.clientToken)).not.toBeNull();
    expect(await svc.workers(companyId, pool.id)).toHaveLength(1);
  });

  it("registers provider-defined persistent slots idempotently and fences activation/deactivation without revoking", async () => {
    const provider = hostedProvider();
    const svc = agentPoolService(db);
    const pool = await svc.ensureDefault(companyId);
    const grant = { ...provider.config, clientId: randomUUID(), principalId: randomUUID() };
    const registration = { companyId, poolId: provider.poolId, poolName: pool.name,
      slots: Array.from({ length: 3 }, (_, index) => ({ workerId: randomUUID(), name: `worker-${index + 1}` })) };
    await svc.registerHostedSlots(registration, grant);
    await svc.registerHostedSlots(registration, grant);
    expect(await svc.workers(companyId, pool.id)).toHaveLength(3);
    const input = { companyId, poolId: provider.poolId, poolName: pool.name, workerId: registration.slots[0].workerId,
      executionId: randomUUID(), generation: randomUUID(), activationVersion: 1, clientToken: "a".repeat(64) };
    await svc.pairHostedWorker(input, grant);
    await expect(svc.deactivateHostedWorker(input, grant)).resolves.toMatchObject({ deactivated: true, revoked: false });
    expect(await svc.authenticate(input.workerId, input.clientToken)).toBeNull();
    const replacement = { ...input, executionId: randomUUID(), generation: randomUUID(), activationVersion: 2, clientToken: "b".repeat(64) };
    await svc.pairHostedWorker(replacement, grant);
    await expect(svc.deactivateHostedWorker(input, grant)).resolves.toMatchObject({ deactivated: false });
    await expect(svc.pairHostedWorker(input, grant)).rejects.toThrow("another credential");
    expect(await svc.authenticate(input.workerId, replacement.clientToken)).toMatchObject({ executionId: replacement.executionId });
    await svc.registerHostedSlots(registration, grant);
    expect(await svc.authenticate(input.workerId, replacement.clientToken)).not.toBeNull();
    await svc.revokeHostedWorker(replacement, grant);
    await svc.registerHostedSlots(registration, grant);
    await expect(svc.pairHostedWorker({ ...replacement, activationVersion: 3 }, grant)).rejects.toThrow("revoked");
    expect((await svc.workers(companyId, pool.id)).filter(worker => worker.name === "worker-1")).toHaveLength(1);
  });

  it("enforces one Hosted pool per organization while preserving additional Devbox pools", async () => {
    hostedProvider();
    const svc = agentPoolService(db);
    await svc.ensureDefault(companyId);
    await expect(db.insert(agentPools).values({ companyId, name: "duplicate-hosted", type: "hosted" }))
      .rejects.toThrow();
    expect(await svc.create(companyId, "additional-devbox")).toMatchObject({ type: "devbox" });
  });

  it.each(["cancellation", "timeout", "stalled-report"])("does not dispatch mock capacity and bounds waiting after %s", async (kind) => {
    const provider = hostedProvider();
    const svc = agentPoolService(db);
    const pool = await svc.ensureDefault(companyId);
    const controller = new AbortController();
    let releaseReport: (() => void) | undefined;
    if (kind !== "cancellation") {
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => timeout(ms === 118_000 ? 300 : ms === 2_000 ? 50 : ms));
    }
    if (kind === "stalled-report") {
      provider.client.report.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseReport = resolve; }));
    }
    const ctx: AdapterExecutionContext = {
      runId: randomUUID(), agent: { id: randomUUID(), companyId, name: "Hosted", adapterType: "agent_pool", adapterConfig: {} },
      config: { name: pool.name }, context: {}, signal: controller.signal,
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      onLog: vi.fn(async () => {}), onDispatch: vi.fn(),
    };
    const result = svc.prepareExecution(ctx);
    const rejected = expect(result).rejects.toThrow(kind === "cancellation" ? /abort/i : /within two minutes/);
    await vi.waitFor(() => expect(provider.client.report).toHaveBeenCalledWith(provider.poolId, 1, expect.any(AbortSignal)));
    expect(agentPoolBroker.hasConnectedWorker(companyId, pool.name)).toBe(false);
    if (kind === "cancellation") controller.abort();
    try {
      await rejected;
      if (kind !== "stalled-report") {
        expect(provider.client.report).toHaveBeenLastCalledWith(provider.poolId, 0, expect.any(AbortSignal));
      }
    } finally {
      releaseReport?.();
    }
    expect(ctx.onDispatch).not.toHaveBeenCalled();
  });

  it("preserves durable capacity waiting through the production WebSocket preparation callback", async () => {
    const provider = hostedProvider();
    const pool = await agentPoolService(db).ensureDefault(companyId);
    const http = createServer(app());
    const closeWs = setupAgentPoolWebSocketServer(http, db);
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => timeout(ms === 118_000 ? 300 : ms));
    try {
      const prepare = agentPoolBroker.prepareExecution;
      if (!prepare) throw new Error("Expected production worker preparation");
      await expect(prepare({
        runId: randomUUID(), agent: { id: randomUUID(), companyId, name: "Hosted", adapterType: "agent_pool", adapterConfig: {} },
        config: { name: pool.name }, context: {},
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        onLog: vi.fn(async () => {}), onDispatch: vi.fn(),
      }, { waitForWorker: false })).rejects.toBeInstanceOf(AgentPoolCapacityWaitError);
      expect(provider.client.report).not.toHaveBeenCalled();
    } finally {
      closeWs();
    }
  });

  it("preserves saving a Devbox agent before its workers or named pool exist", async () => {
    const config = { name: "pool-to-provision-later" };
    expect(await agentPoolService(db).validateAgentRepositories(companyId, config)).toEqual(config);
    expect(await agentPoolService(db).validateAgentRepositories(companyId, { ...config, referenceRepositoryIds: [] }))
      .toEqual({ ...config, referenceRepositoryIds: [] });
  });

  it("keeps failed provisioning visible and retries without falling back to Devbox", async () => {
    const provider = hostedProvider();
    const svc = agentPoolService(db);
    const [pool] = await svc.list(companyId);
    provider.client.create.mockRejectedValueOnce(new Error("Provider unavailable"));
    await expect(svc.ensureDefault(companyId)).rejects.toThrow("Provider unavailable");
    expect(await svc.get(companyId, pool.id)).toMatchObject({ type: "hosted", hostedPoolId: null });
    expect(await svc.list(companyId)).toContainEqual(expect.objectContaining({ id: pool.id, type: "hosted" }));
    await svc.status(companyId, pool.id);
    expect(await svc.get(companyId, pool.id)).toMatchObject({ hostedPoolId: provider.poolId });
    expect(provider.client.create).toHaveBeenCalledTimes(2);
  });

  it("accepts an absolute backlog with 202 and denies invalid demand and agent administration", async () => {
    const provider = hostedProvider();
    const svc = agentPoolService(db);
    const pool = await svc.ensureDefault(companyId);
    const url = `/api/companies/${companyId}/agent-pools/${pool.id}`;
    await request(app()).post(url).send({ itemsWaiting: 3 }).expect(202);
    expect(provider.client.report).toHaveBeenCalledWith(provider.poolId, 3);
    await request(app()).post(url).send({ itemsWaiting: -1 }).expect(400);
    await request(app()).get(`${url}/status`).expect(200, { activeWorkers: 1, provisioningWorkers: 1, isMock: true });
    await request(app({ type: "agent", agentId: randomUUID(), companyId, source: "api_key" }))
      .post(url).send({ itemsWaiting: 3 }).expect(403);
    expect(provider.client.report).toHaveBeenCalledTimes(1);
  });

  function app(actor: Express.Request["actor"] = {
    type: "board", userId: "board-user", source: "session", companyIds: [companyId],
  }) {
    const result = express();
    result.use(express.json());
    result.use(agentPoolPairingRoutes(db));
    result.use((req, _res, next) => { req.actor = actor; next(); });
    result.use("/api", agentPoolRoutes(db));
    result.use(errorHandler);
    return result;
  }

  it("allows direct PRs without an inspector and limits inspector creation to the company board", async () => {
    const url = `/api/companies/${companyId}/pr-inspector`;
    expect((await request(app()).get(url).expect(200)).body).toEqual({
      agentId: null, specialRole: "pr_inspector",
    });
    const agentApp = app({ type: "agent", agentId: randomUUID(), companyId, source: "api_key" });
    await request(agentApp).post(url).send({}).expect(403);
    await request(app()).post(`/api/companies/${otherCompanyId}/pr-inspector`).send({}).expect(403);
    await request(app()).post(url).send({ agentId: randomUUID() }).expect(400);
    expect(await prInspectorService(db).assignmentPolicy(companyId, randomUUID())).toEqual({
      inspectorAgentId: null, isInspector: false,
    });
  });

  it("creates exactly one Devbox inspector and pool and restores direct PRs after termination", async () => {
    const url = `/api/companies/${companyId}/pr-inspector`;
    const [first, second] = await Promise.all([
      request(app()).post(url).send({}),
      request(app()).post(url).send({}),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.agentId).toBe(first.body.agentId);
    const rows = await db.select().from(agents).where(eq(agents.companyId, companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: first.body.agentId, name: "Pull Request (PR) Inspector",
      adapterType: "agent_pool", adapterConfig: { name: "pr-inspector", harness: "default" },
    });
    expect(await db.select().from(agentPools).where(eq(agentPools.companyId, companyId))).toMatchObject([
      { name: "pr-inspector", type: "devbox", hostedPoolId: null, hostedApiUrl: null, hostedAudience: null },
    ]);
    expect(await prInspectorService(db).assignmentPolicy(companyId, first.body.agentId)).toEqual({
      inspectorAgentId: first.body.agentId, isInspector: true,
    });
    expect(await prInspectorService(db).assignmentPolicy(companyId, randomUUID())).toMatchObject({ isInspector: false });
    const ctx: AdapterExecutionContext = {
      runId: randomUUID(), agent: { ...rows[0], adapterConfig: rows[0].adapterConfig },
      config: rows[0].adapterConfig, context: {}, runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      onLog: async () => {},
    };
    await expect(agentPoolService(db).prepareExecution(ctx)).resolves.toEqual({
      prPolicy: { inspectorAgentId: first.body.agentId, isInspector: true },
    });
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, first.body.agentId));
    expect(await prInspectorService(db).assignmentPolicy(companyId, randomUUID()))
      .toEqual({ inspectorAgentId: first.body.agentId, isInspector: false });
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, first.body.agentId));
    expect(await prInspectorService(db).assignmentPolicy(companyId, first.body.agentId))
      .toEqual({ inspectorAgentId: null, isInspector: false });
    const recreated = await request(app()).post(url).send({}).expect(200);
    expect(recreated.body.agentId).not.toBe(first.body.agentId);
    expect(await db.select().from(agentPools).where(eq(agentPools.companyId, companyId))).toHaveLength(1);
    expect(await prInspectorService(db).get(otherCompanyId)).toMatchObject({ agentId: null });
  });

  it("rejects an incompatible inspector pool without creating an agent", async () => {
    await db.insert(agentPools).values({ companyId, name: "pr-inspector", type: "hosted" });
    await request(app()).post(`/api/companies/${companyId}/pr-inspector`).send({}).expect(409);
    expect(await db.select().from(agents).where(eq(agents.companyId, companyId))).toHaveLength(0);
    expect(await prInspectorService(db).get(companyId)).toMatchObject({ agentId: null });
  });

  it("limits external PR postbacks to the inspector while it exists", async () => {
    const svc = prInspectorService(db);
    const producerId = randomUUID();
    await expect(svc.assertPrPostbackAllowed(companyId, producerId)).resolves.toBeUndefined();
    const inspector = await svc.create(companyId, "board-user");
    await expect(svc.assertPrPostbackAllowed(companyId, producerId)).rejects.toThrow(/Only.*PR Inspector/);
    await expect(svc.assertPrPostbackAllowed(companyId, inspector.agentId!)).resolves.toBeUndefined();
    await expect(svc.assertPrPostbackAllowed(otherCompanyId, producerId)).resolves.toBeUndefined();
    await db.delete(agents).where(eq(agents.id, inspector.agentId!));
    await expect(svc.assertPrPostbackAllowed(companyId, producerId)).resolves.toBeUndefined();
  });

  it("isolates GitHub login APIs by company, agent and board access", async () => {
    const foreignAgent = randomUUID();
    await db.insert(agents).values({ id: foreignAgent, companyId: otherCompanyId, name: "Foreign", adapterType: "agent_pool" });
    const url = `/api/companies/${companyId}/agents/${foreignAgent}/github-login`;
    const agentApp = app({ type: "agent", agentId: foreignAgent, companyId, source: "api_key" });
    await request(agentApp).get(url).expect(403);
    await request(agentApp).post(url).expect(403);
    await request(agentApp).post(`${url}/poll`).expect(403);
    await request(agentApp).put(`${url}/git-identity`).send({ name: "Agent", email: "agent@example.test" }).expect(403);
    await request(app()).get(`/api/companies/${otherCompanyId}/agents/${foreignAgent}/github-login`).expect(403);
    await request(app()).get(url).expect(404);
    await request(app()).post(url).expect(404);
    await request(app()).post(`${url}/poll`).expect(404);
  });

  it("stores GitHub device secrets using managed identity and blocks sign-in restart during an active assignment", async () => {
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Native", adapterType: "agent_pool" });
    vi.stubEnv("PAPERCLIP_AGENT_CREDENTIAL_VAULT_URL", "https://agent-credentials.vault.azure.net/");
    const identity = vi.spyOn(ManagedIdentityCredential.prototype, "getToken").mockResolvedValue({
      token: "private-vault-token", expiresOnTimestamp: Date.now() + 3_600_000,
    });
    const stored = new Map<string, string>();
    vi.spyOn(remoteHttp, "guardedRemoteHttpFetch").mockImplementation(async (input, init) => {
      const url = new URL(input);
      expect(url.origin).toBe("https://agent-credentials.vault.azure.net");
      expect(url.pathname).toContain(`${companyId.replaceAll("-", "")}-${agentId.replaceAll("-", "")}-`);
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer private-vault-token");
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        stored.set(url.pathname, body.value);
        return new Response("{}", { status: 200 });
      }
      const value = stored.get(url.pathname);
      return value ? Response.json({ value }) : new Response(null, { status: 404 });
    });
    const oauth = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      if (String(input) === "https://github.com/login/device/code") return Response.json({
          device_code: "private-device-code", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device",
          expires_in: 900, interval: 5,
        });
      if (String(input) === "https://github.com/login/oauth/access_token") return Response.json({
        access_token: "private-access-token", expires_in: 28_800, token_type: "bearer",
        refresh_token: "private-refresh-token", refresh_token_expires_in: 15_897_600,
      });
      expect(String(input)).toBe("https://api.github.com/user");
      return Response.json({ id: 12345, login: "github-account" });
    });
    const url = `/api/companies/${companyId}/agents/${agentId}/github-login`;
    const response = await request(app()).post(url).expect(200);
    expect(response.body).toMatchObject({ state: "pending", userCode: "ABCD-1234" });
    expect(response.body.gitIdentity).toEqual({ name: "Board Operator", email: "operator@example.test" });
    expect(JSON.stringify(response.body)).not.toMatch(/private-device-code|private-vault-token/);
    expect([...stored.values()].some(value => value.includes("private-device-code"))).toBe(true);
    expect(identity).toHaveBeenCalledWith("https://vault.azure.net/.default", expect.objectContaining({ abortSignal: expect.any(AbortSignal) }));
    await request(app()).post(`${url}/poll`).expect(200);
    const anotherBoard = app({ type: "board", userId: "another-board-user", source: "session", companyIds: [companyId] });
    const pending = await request(anotherBoard).post(url).expect(200);
    expect(pending.body.gitIdentity).toEqual(response.body.gitIdentity);
    await request(app()).put(`${url}/git-identity`).send({ name: "Override", email: "override@example.test" }).expect(409);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6000);
    const connected = await request(anotherBoard).post(`${url}/poll`).expect(200);
    expect(connected.body).toMatchObject({ state: "connected", gitIdentity: response.body.gitIdentity });
    await request(app()).put(`${url}/git-identity`).send({ name: "Invalid\nName", email: "override@example.test" }).expect(400);
    const updated = await request(app()).put(`${url}/git-identity`)
      .send({ name: "Override", email: "override@example.test" }).expect(200);
    expect(updated.body.gitIdentity).toEqual({ name: "Override", email: "override@example.test" });
    expect(JSON.stringify(updated.body)).not.toMatch(/private-|refreshToken|accessToken/);
    const auth = agentGitHubAuthService(db);
    const runId = randomUUID();
    const assignment = await auth.assignmentCredentials(companyId, agentId, runId);
    expect(assignment).toMatchObject({
      githubCredential: { companyId, agentId, runId, accessToken: "private-access-token" },
      gitIdentity: updated.body.gitIdentity,
    });
    await request(app()).put(`${url}/git-identity`).send({ name: "Next Operator", email: "next@example.test" }).expect(200);
    expect(assignment.gitIdentity).toEqual(updated.body.gitIdentity);
    expect((await auth.assignmentCredentials(companyId, agentId, randomUUID())).gitIdentity)
      .toEqual({ name: "Next Operator", email: "next@example.test" });
    const credentialsKey = [...stored.keys()].find(key => key.endsWith("-credentials"))!;
    const legacy = JSON.parse(stored.get(credentialsKey)!);
    delete legacy.gitIdentity;
    stored.set(credentialsKey, JSON.stringify(legacy));
    await expect(auth.assignmentCredentials(companyId, agentId, randomUUID())).rejects.toThrow("Set this agent's Git name and email");
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running" });
    await request(app()).post(url).expect(409);
    expect(oauth).toHaveBeenCalledTimes(3);
  });

  it("creates the default once, enforces unique company names, and isolates worker management", async () => {
    const svc = agentPoolService(db);
    const initial = await svc.list(companyId);
    expect(initial.filter((pool) => pool.name === "default")).toHaveLength(1);
    expect(initial[0].type).toBe("hosted");
    await Promise.all([svc.list(companyId), svc.list(companyId)]);
    expect((await svc.list(companyId)).filter((pool) => pool.name === "default")).toHaveLength(1);
    const pool = await svc.create(companyId, "coding");
    expect(pool.type).toBe("devbox");
    await expect(svc.create(companyId, "coding")).rejects.toThrow("already exists");
    await expect(svc.get(otherCompanyId, pool.id)).rejects.toThrow("not found");
    expect((await svc.create(otherCompanyId, "coding")).companyId).toBe(otherCompanyId);
    await request(app()).get(`/api/companies/${otherCompanyId}/agent-pools`).expect(403);
    await request(app({ type: "agent", agentId: randomUUID(), companyId, source: "agent_key" }))
      .get(`/api/companies/${companyId}/agent-pools`).expect(403);
    await request(app()).get(`/api/companies/${companyId}/agent-pools/${pool.id}/workers`).expect(200);
    await request(app()).get(`/api/companies/${companyId}/agent-pools/not-a-uuid/workers`).expect(400);
  });

  it("pairs atomically with expiring one-time tokens, stores only hashes, and revokes client credentials", async () => {
    const svc = agentPoolService(db);
    const pool = await svc.create(companyId, "devbox");
    const pairing = await svc.issuePairing(companyId, pool.id, "test-worker");
    const clientToken = "1".repeat(64);
    expect(await svc.authenticate(pairing.workerId, clientToken)).toBeNull();
    const paired = await Promise.allSettled([
      svc.pair(pairing.workerId, pairing.serverToken, clientToken),
      svc.pair(pairing.workerId, pairing.serverToken, "2".repeat(64)),
    ]);
    expect(paired.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [row] = await db.select().from(agentPoolWorkers).where(eq(agentPoolWorkers.id, pairing.workerId));
    expect(row!.pairingTokenHash).toBeNull();
    expect(row!.clientTokenHash).not.toBe(clientToken);
    const winner = row!.clientTokenHash === hashAgentPoolToken(clientToken) ? clientToken : "2".repeat(64);
    expect(await svc.authenticate(pairing.workerId, winner)).toMatchObject({ companyId, poolName: "devbox" });
    expect(await svc.authenticate(pairing.workerId, "3".repeat(64))).toBeNull();
    await svc.revoke(companyId, pool.id, pairing.workerId);
    expect(await svc.authenticate(pairing.workerId, winner)).toBeNull();

    const expired = await svc.issuePairing(companyId, pool.id, "expired");
    await db.update(agentPoolWorkers).set({ pairingExpiresAt: new Date(0) }).where(eq(agentPoolWorkers.id, expired.workerId));
    await expect(svc.pair(expired.workerId, expired.serverToken, clientToken)).rejects.toThrow("expired");
  });

  it("audits board mutations, omits credentials from inventories, and authenticates real WebSocket upgrades", async () => {
    const base = `/api/companies/${companyId}/agent-pools`;
    const created = await request(app()).post(base).send({ name: "wire" }).expect(201);
    const poolId: string = created.body.id;
    const issued = await request(app()).post(`${base}/${poolId}/workers`).send({ name: "wire-worker" }).expect(201);
    const workerId: string = issued.body.workerId;
    const clientToken = "4".repeat(64);
    await request(app()).post("/api/agent-pool/pair").send({
      workerId, serverToken: issued.body.serverToken, clientToken,
    }).expect(200);
    const inventory = await request(app()).get(`${base}/${poolId}/workers`).expect(200);
    expect(inventory.body[0]).toMatchObject({ paired: true, status: "offline" });
    expect(JSON.stringify(inventory.body)).not.toMatch(/Hash|Token/);
    const audit = await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityId, workerId)));
    expect(audit.some((row) => row.action === "agent_pool.worker_pairing_issued")).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(issued.body.serverToken);

    const http = createServer(app());
    const closeWs = setupAgentPoolWebSocketServer(http, db);
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("Expected server port");
    const endpoint = `ws://127.0.0.1:${address.port}/api/agent-pool/worker?workerId=${workerId}`;
    const denied = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => {
      denied.once("unexpected-response", (_req, res) => { res.resume(); expect(res.statusCode).toBe(401); denied.terminate(); resolve(); });
      denied.on("error", () => {});
      denied.once("open", () => reject(new Error("Unauthenticated worker accepted")));
    });
    const socket = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${clientToken}` } });
    try {
      await once(socket, "open");
      const welcomed = once(socket, "message");
      socket.send(JSON.stringify({ type: "hello", instanceId: randomUUID(), runId: null }));
      expect(JSON.parse((await welcomed)[0].toString()).type).toBe("welcome");
      const closed = once(socket, "close");
      await request(app()).delete(`${base}/${poolId}/workers/${workerId}`).expect(204);
      await closed;
      expect(await agentPoolService(db).authenticate(workerId, clientToken)).toBeNull();
    } finally {
      socket.terminate();
      closeWs();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  });

  it("pairs the real Minicode CLI and executes an assigned task through AgentSession", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-pool-e2e-"));
    const source = path.join(directory, "clippy-worker");
    await execFileAsync("git", ["init", "--initial-branch=main",
      "--separate-git-dir", path.join(directory, "submodule-git"), source], { windowsHide: true });
    await writeFile(path.join(source, "source.txt"), "committed");
    await execFileAsync("git", ["-C", source, "add", "source.txt"], { windowsHide: true });
    await execFileAsync("git", ["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
      "-c", "commit.gpgsign=false", "commit", "-m", "Fixture"], { windowsHide: true });
    const svc = agentPoolService(db);
    const pool = await svc.create(companyId, "e2e");
    const pairing = await svc.issuePairing(companyId, pool.id, "minicode-cli");
    const agentId = randomUUID();
    const workspace = path.join(directory, "config", "agent-pool", "workspaces", pairing.workerId, agentId);
    const application = app();
    let modelCalls = 0;
    application.post("/model/chat/completions", (req, res) => {
      const input = JSON.stringify(req.body);
      expect(input).toContain("Write a useful artifact");
      expect(req.body.messages[0].content).toContain(workspace);
      expect(req.body.messages[0].content).toContain("Control-plane agent instructions delivered inline");
      modelCalls++;
      res.json({ choices: [{ message: { content: JSON.stringify(modelCalls === 1
        ? { type: "write", path: "proof.txt", content: "AgentPool completed this assignment" }
        : { type: "final", message: "Wrote proof.txt" }) } }] });
    });
    const http = createServer(application);
    const closeWs = setupAgentPoolWebSocketServer(http, db);
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("Missing local server port");
    const origin = `http://127.0.0.1:${address.port}`;
    const worker = spawn(process.execPath, [
      fileURLToPath(new URL("../../../../minicode/cli.js", import.meta.url)),
      "worker", "--server", origin, "--worker-id", pairing.workerId, "--repo-root", source, "--workspace-mode", "clone",
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, MINICODE_CONFIG_HOME: path.join(directory, "config"),
        MINICODE_AGENT_POOL_PAIRING_TOKEN: pairing.serverToken,
        OPENCODE_API_KEY: "fixture-only", OPENCODE_BASE_URL: `${origin}/model`, OPENCODE_MODEL: "fixture-model" },
    });
    let output = "";
    worker.stdout.on("data", (chunk) => { output += chunk.toString(); });
    worker.stderr.on("data", (chunk) => { output += chunk.toString(); });
    try {
      await vi.waitFor(() => {
        expect(worker.exitCode, output).toBeNull();
        expect(agentPoolBroker.status(pairing.workerId)).toBe("idle");
      }, { timeout: 5000 });
      const logs: string[] = [];
      const result = await agentPoolBroker.execute({
        runId: randomUUID(), agent: { id: agentId, companyId, name: "Worker", adapterType: "agent_pool", adapterConfig: {} },
        authToken: "fixture-run-key",
        config: { name: "e2e" }, context: {
          task: "Write a useful artifact",
          paperclipAgentInstructions: {
            version: 1, format: "markdown", content: "Control-plane agent instructions delivered inline",
            revisionId: "e2e-revision", contentSha256: createHash("sha256").update("Control-plane agent instructions delivered inline").digest("hex"),
          },
        },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        onLog: async (_stream, data) => { logs.push(data); },
      });
      expect(result.errorMessage).toBeUndefined();
      expect(result.exitCode).toBe(0);
      expect(result.resultJson).toMatchObject({ agentPoolStop: {
        schema: "agent_pool_stop_v1", companyId, workerId: pairing.workerId,
      } });
      expect(agentPoolBroker.status(pairing.workerId)).toBe("idle");
      expect(await readFile(path.join(workspace, "proof.txt"), "utf8")).toBe("AgentPool completed this assignment");
      await expect(stat(path.join(source, "proof.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(modelCalls).toBe(2);
      expect(logs.join("")).toContain("Wrote proof.txt");
      expect(logs.join("")).toContain(`[minicode] Agent workspace: ${workspace}`);
      expect(output).not.toContain(pairing.serverToken);
    } finally {
      const exited = once(worker, "exit");
      closeWs();
      if (worker.exitCode === null) worker.kill();
      if (worker.exitCode === null) await exited;
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves company deletion and disconnects its paired workers", async () => {
    const deletedCompanyId = randomUUID();
    await db.insert(companies).values({ id: deletedCompanyId, name: "Temporary pool company", issuePrefix: "TP" });
    const svc = agentPoolService(db);
    const pool = await svc.create(deletedCompanyId, "temporary");
    const pairing = await svc.issuePairing(deletedCompanyId, pool.id, "temporary-worker");
    const clientToken = "5".repeat(64);
    await svc.pair(pairing.workerId, pairing.serverToken, clientToken);
    const http = createServer(app());
    const closeWs = setupAgentPoolWebSocketServer(http, db);
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("Expected server port");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/agent-pool/worker?workerId=${pairing.workerId}`, {
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    try {
      await once(socket, "open");
      const welcomed = once(socket, "message");
      socket.send(JSON.stringify({ type: "hello", instanceId: randomUUID(), runId: null }));
      await welcomed;
      const closed = once(socket, "close");
      expect(await deleteCompany(db, deletedCompanyId)).toMatchObject({ id: deletedCompanyId });
      await closed;
      expect(await svc.authenticate(pairing.workerId, clientToken)).toBeNull();
      expect(agentPoolBroker.status(pairing.workerId)).toBe("offline");
      expect(await db.select().from(companies).where(eq(companies.id, deletedCompanyId))).toEqual([]);
    } finally {
      socket.terminate();
      closeWs();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  });
});
