import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createAgentPoolSchema, createAgentPoolWorkerSchema, pairAgentPoolWorkerSchema,
  updateAgentPoolSchema, hostedWorkerDemandSchema, hostedAgentPoolWorkerSchema } from "@paperclipai/shared";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertBoardOrAgent, assertCompanyAccess } from "./authz.js";
import { logActivity } from "../services/activity-log.js";
import { agentPoolService } from "../services/agent-pools.js";
import { agentPoolBroker } from "../services/agent-pool-broker.js";
import { unauthorized, notFound } from "../errors.js";
import { agentPoolSkillsArchive } from "../services/agent-pool-skills.js";
import { defaultHostedWorkerConfig } from "../services/hosted-worker-client.js";
import { authenticateHostedWorkerProvider } from "../services/entra-hosted-workers.js";

export function agentPoolPairingRoutes(db: Db) {
  const router = Router();
  const svc = agentPoolService(db);
  router.post("/api/agent-pool/hosted/workers", validate(hostedAgentPoolWorkerSchema), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const grant = await authenticateHostedWorkerProvider(req.headers.authorization);
    const input = hostedAgentPoolWorkerSchema.parse(req.body);
    const result = await svc.pairHostedWorker(input, grant);
    if (result.created) await logActivity(db, {
      companyId: input.companyId, actorType: "system", actorId: grant.clientId,
      action: "agent_pool.hosted_worker_paired", entityType: "agent_pool_worker", entityId: result.workerId,
      details: { providerPoolId: input.poolId },
    });
    res.json({ workerId: result.workerId });
  });
  router.delete("/api/agent-pool/hosted/workers", validate(hostedAgentPoolWorkerSchema), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const grant = await authenticateHostedWorkerProvider(req.headers.authorization);
    const input = hostedAgentPoolWorkerSchema.parse(req.body);
    const result = await svc.revokeHostedWorker(input, grant);
    if (result.revoked) agentPoolBroker.revoke(result.workerId);
    res.status(204).end();
  });
  router.post("/api/agent-pool/pair", validate(pairAgentPoolWorkerSchema), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const body = pairAgentPoolWorkerSchema.parse(req.body);
    const result = await svc.pair(body.workerId, body.serverToken, body.clientToken);
    const identity = await svc.authenticate(body.workerId, body.clientToken);
    if (!identity) throw unauthorized("AgentPool worker was revoked during pairing");
    await logActivity(db, {
      companyId: identity.companyId, actorType: "system", actorId: identity.id,
      action: "agent_pool.worker_paired", entityType: "agent_pool_worker", entityId: identity.id,
    });
    res.json(result);
  });
  return router;
}

export function agentPoolSkillsRoutes() {
  const router = Router();
  router.get("/agent-pool/skills/:sha256.zip", (req, res) => {
    assertBoardOrAgent(req);
    if (req.actor.type === "agent") {
      if (!req.actor.companyId) throw unauthorized("Agent company is required");
      assertCompanyAccess(req, req.actor.companyId);
    }
    const hash = z.string().regex(/^[a-f0-9]{64}$/).parse(req.params.sha256);
    const archive = agentPoolSkillsArchive(hash);
    if (!archive) throw notFound("Skill bundle expired or unavailable; retry the assignment");
    res.setHeader("Cache-Control", "private, no-store");
    res.type("application/zip").send(archive);
  });
  return router;
}

export function agentPoolRoutes(db: Db) {
  const router = Router();
  const svc = agentPoolService(db);
  router.use(agentPoolSkillsRoutes());
  const base = "/companies/:companyId/agent-pools";
  router.use(base, (req, _res, next) => {
    assertBoard(req);
    assertCompanyAccess(req, z.string().uuid().parse(req.params.companyId));
    next();
  });
  const company = (value: unknown) => z.string().uuid().parse(value);
  const id = company;
  router.get(base, async (req, res) => res.json(await svc.list(company(req.params.companyId))));
  router.get(`${base}/hosted-defaults`, (_req, res) => res.json(defaultHostedWorkerConfig()));
  router.post(base, validate(createAgentPoolSchema), async (req, res) => {
    const companyId = company(req.params.companyId);
    const pool = await svc.create(companyId, createAgentPoolSchema.parse(req.body).name);
    await logActivity(db, {
      companyId, actorType: "user", actorId: req.actor.userId ?? "local-board",
      action: "agent_pool.created", entityType: "agent_pool", entityId: pool.id, details: { name: pool.name },
    });
    res.status(201).json(pool);
  });
  router.patch(`${base}/:poolId`, validate(updateAgentPoolSchema), async (req, res) => {
    const companyId = company(req.params.companyId);
    const poolId = id(req.params.poolId);
    const input = updateAgentPoolSchema.parse(req.body);
    await svc.get(companyId, poolId);
    await logActivity(db, {
      companyId, actorType: "user", actorId: req.actor.userId ?? "local-board",
      action: "agent_pool.settings_update_attempted", entityType: "agent_pool", entityId: poolId,
      details: { type: input.type },
    });
    res.json(await svc.update(companyId, poolId, input));
  });
  router.get(`${base}/:poolId/status`, async (req, res) =>
    res.json(await svc.status(company(req.params.companyId), id(req.params.poolId))));
  router.get(`${base}/:poolId/repos`, async (req, res) =>
    res.json(await svc.repositories(company(req.params.companyId), id(req.params.poolId))));
  router.post(`${base}/:poolId`, validate(hostedWorkerDemandSchema), async (req, res) => {
    const companyId = company(req.params.companyId);
    const poolId = id(req.params.poolId);
    const { itemsWaiting } = hostedWorkerDemandSchema.parse(req.body);
    await svc.report(companyId, poolId, itemsWaiting);
    await logActivity(db, {
      companyId, actorType: "user", actorId: req.actor.userId ?? "local-board",
      action: "agent_pool.demand_reported", entityType: "agent_pool", entityId: poolId,
      details: { itemsWaiting },
    });
    res.status(202).end();
  });
  router.get(`${base}/:poolId/workers`, async (req, res) => {
    const workers = await svc.workers(company(req.params.companyId), id(req.params.poolId));
    res.json(workers.map((worker) => ({
      id: worker.id, poolId: worker.poolId, name: worker.name,
      paired: Boolean(worker.clientTokenHash), revoked: Boolean(worker.revokedAt),
      status: agentPoolBroker.status(worker.id),
    })));
  });
  router.post(`${base}/:poolId/workers`, validate(createAgentPoolWorkerSchema), async (req, res) => {
    const companyId = company(req.params.companyId);
    const pairing = await svc.issuePairing(companyId, id(req.params.poolId),
      createAgentPoolWorkerSchema.parse(req.body).name);
    await logActivity(db, {
      companyId, actorType: "user", actorId: req.actor.userId ?? "local-board",
      action: "agent_pool.worker_pairing_issued", entityType: "agent_pool_worker", entityId: pairing.workerId,
    });
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json(pairing);
  });
  router.delete(`${base}/:poolId/workers/:workerId`, async (req, res) => {
    const companyId = company(req.params.companyId);
    const worker = await svc.revoke(companyId, id(req.params.poolId), id(req.params.workerId));
    agentPoolBroker.revoke(worker.id);
    await logActivity(db, {
      companyId, actorType: "user", actorId: req.actor.userId ?? "local-board",
      action: "agent_pool.worker_revoked", entityType: "agent_pool_worker", entityId: worker.id,
    });
    res.status(204).end();
  });
  return router;
}
