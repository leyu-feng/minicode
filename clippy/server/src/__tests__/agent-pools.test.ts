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
import { and, eq } from "drizzle-orm";
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createDb, companies, agentPoolWorkers, activityLog } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentPoolService, hashAgentPoolToken } from "../services/agent-pools.js";
import { agentPoolPairingRoutes, agentPoolRoutes } from "../routes/agent-pools.js";
import { errorHandler } from "../middleware/error-handler.js";
import { setupAgentPoolWebSocketServer } from "../realtime/agent-pool-ws.js";
import { agentPoolBroker } from "../services/agent-pool-broker.js";
import { deleteCompany } from "../services/company-deletion.js";
import * as hostedWorkers from "../services/hosted-worker-client.js";
import type { AdapterExecutionContext } from "../adapters/types.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`AgentPool DB tests unavailable: ${support.reason}`);
const companyId = randomUUID();
const otherCompanyId = randomUUID();
const execFileAsync = promisify(execFile);

(support.supported ? describe : describe.skip)("AgentPool persistence and access", () => {
  let db: ReturnType<typeof createDb>;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("agent-pools");
    cleanup = started.cleanup;
    db = createDb(started.connectionString);
    await db.insert(companies).values([
      { id: companyId, name: "AgentPool test", issuePrefix: "AP" },
      { id: otherCompanyId, name: "Other company", issuePrefix: "AO" },
    ]);
  });
  afterAll(async () => { agentPoolBroker.close(); await cleanup?.(); });
  afterEach(() => vi.restoreAllMocks());

  function hostedProvider() {
    const poolId = randomUUID();
    const config = { apiUrl: "https://provider.example/v1/hosted-worker", audience: "api://engsys" };
    const repos = [
      { id: "main", name: "Main", branch: "main", isDefault: true },
      { id: "other", name: "Other", branch: "release", isDefault: false },
    ];
    const client = {
      create: vi.fn(async () => poolId), delete: vi.fn(async () => {}),
      status: vi.fn(async () => ({ activeWorkers: 1, provisioningWorkers: 1, isMock: true })),
      repositories: vi.fn(async () => repos), report: vi.fn(async () => {}),
      claim: vi.fn(async () => {}),
    };
    vi.spyOn(hostedWorkers, "hostedWorkerClient").mockReturnValue(client);
    return { config, client, poolId };
  }

  it("retains provider IDs, resets pairings in both directions, and validates company-scoped repository choices", async () => {
    const provider = hostedProvider();
    const svc = agentPoolService(db);
    const pool = await svc.create(companyId, "hosted-conversion");
    const pairing = await svc.issuePairing(companyId, pool.id, "old-worker");
    await svc.pair(pairing.workerId, pairing.serverToken, "a".repeat(64));
    const hosted = await svc.update(companyId, pool.id, { type: "hosted", clearPairings: true, config: provider.config });
    expect(hosted).toMatchObject({ type: "hosted", hostedPoolId: provider.poolId });
    expect(await svc.authenticate(pairing.workerId, "a".repeat(64))).toBeNull();
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
    const hostedPair = await svc.issuePairing(companyId, pool.id, "hosted-worker");
    await svc.pair(hostedPair.workerId, hostedPair.serverToken, "b".repeat(64));
    expect(await svc.update(companyId, pool.id, { type: "freelance", clearPairings: true }))
      .toMatchObject({ type: "freelance", hostedPoolId: null, hostedApiUrl: null });
    expect(await svc.authenticate(hostedPair.workerId, "b".repeat(64))).toBeNull();
    expect(provider.client.delete).toHaveBeenCalledWith(provider.poolId);
    expect(provider.client.create).toHaveBeenCalledTimes(1);
  });

  it("bootstraps a new company's default Hosted pool once when a provider is configured", async () => {
    const provider = hostedProvider();
    vi.spyOn(hostedWorkers, "defaultHostedWorkerConfig").mockReturnValue(provider.config);
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

  it("allows provider revocation callbacks while a pool settings update holds the registration lock", async () => {
    const provider = hostedProvider();
    const svc = agentPoolService(db);
    const pool = await svc.create(companyId, "hosted-revocation-callback");
    await svc.update(companyId, pool.id, { type: "hosted", clearPairings: true, config: provider.config });
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
      await expect(svc.update(companyId, pool.id, { type: "freelance", clearPairings: true }))
        .resolves.toMatchObject({ type: "freelance", hostedPoolId: null });
      expect(await svc.authenticate(input.workerId, input.clientToken)).toBeNull();
    } finally {
      await revocation;
    }
  });

  it("pairs only the owning Hosted provider and refuses credential takeover or revoked worker resurrection", async () => {
    const provider = hostedProvider();
    const svc = agentPoolService(db);
    const pool = await svc.create(companyId, "managed-hosted");
    await svc.update(companyId, pool.id, { type: "hosted", clearPairings: true, config: provider.config });
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
    const pool = await svc.create(companyId, "managed-shared");
    await svc.update(companyId, pool.id, { type: "hosted", clearPairings: true, config: provider.config });
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

  it.each(["cancellation", "timeout", "stalled-report"])("does not dispatch mock capacity and bounds waiting after %s", async (kind) => {
    const provider = hostedProvider();
    const svc = agentPoolService(db);
    const pool = await svc.create(companyId, `hosted-${kind}`);
    await svc.update(companyId, pool.id, { type: "hosted", clearPairings: true, config: provider.config });
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

  it("preserves saving a Freelance agent before its workers or named pool exist", async () => {
    const config = { name: "pool-to-provision-later" };
    expect(await agentPoolService(db).validateAgentRepositories(companyId, config)).toEqual(config);
    expect(await agentPoolService(db).validateAgentRepositories(companyId, { ...config, referenceRepositoryIds: [] }))
      .toEqual({ ...config, referenceRepositoryIds: [] });
  });

  it("keeps failed provisioning visible and retries without falling back to Freelance", async () => {
    const provider = hostedProvider();
    const svc = agentPoolService(db);
    const pool = await svc.create(companyId, "hosted-retry");
    provider.client.create.mockRejectedValueOnce(new Error("Provider unavailable"));
    await expect(svc.update(companyId, pool.id, { type: "hosted", clearPairings: true, config: provider.config }))
      .rejects.toThrow("Provider unavailable");
    expect(await svc.get(companyId, pool.id)).toMatchObject({ type: "hosted", hostedPoolId: null });
    expect(await svc.list(companyId)).toContainEqual(expect.objectContaining({ id: pool.id, type: "hosted" }));
    await svc.status(companyId, pool.id);
    expect(await svc.get(companyId, pool.id)).toMatchObject({ hostedPoolId: provider.poolId });
    expect(provider.client.create).toHaveBeenCalledTimes(2);
  });

  it("accepts an absolute backlog with 202 and denies invalid demand and agent administration", async () => {
    const provider = hostedProvider();
    const svc = agentPoolService(db);
    const pool = await svc.create(companyId, "hosted-api");
    await svc.update(companyId, pool.id, { type: "hosted", clearPairings: true, config: provider.config });
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

  it("creates the default once, enforces unique company names, and isolates worker management", async () => {
    const svc = agentPoolService(db);
    const initial = await svc.list(companyId);
    expect(initial.filter((pool) => pool.name === "default")).toHaveLength(1);
    await Promise.all([svc.list(companyId), svc.list(companyId)]);
    expect((await svc.list(companyId)).filter((pool) => pool.name === "default")).toHaveLength(1);
    const pool = await svc.create(companyId, "coding");
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
    const pool = (await svc.list(companyId)).find((row) => row.name === "default")!;
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
    expect(await svc.authenticate(pairing.workerId, winner)).toMatchObject({ companyId, poolName: "default" });
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
