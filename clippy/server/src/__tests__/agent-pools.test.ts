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
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { createDb, companies, agentPoolWorkers, activityLog } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentPoolService, hashAgentPoolToken } from "../services/agent-pools.js";
import { agentPoolPairingRoutes, agentPoolRoutes } from "../routes/agent-pools.js";
import { errorHandler } from "../middleware/error-handler.js";
import { setupAgentPoolWebSocketServer } from "../realtime/agent-pool-ws.js";
import { agentPoolBroker } from "../services/agent-pool-broker.js";
import { deleteCompany } from "../services/company-deletion.js";

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
