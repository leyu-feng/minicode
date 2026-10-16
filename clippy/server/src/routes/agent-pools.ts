import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createAgentPoolSchema, createAgentPoolWorkerSchema, pairAgentPoolWorkerSchema } from "@paperclipai/shared";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { logActivity } from "../services/activity-log.js";
import { agentPoolService } from "../services/agent-pools.js";
import { agentPoolBroker } from "../services/agent-pool-broker.js";
import { unauthorized } from "../errors.js";

export function agentPoolPairingRoutes(db: Db) {
  const router = Router();
  const svc = agentPoolService(db);
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

export function agentPoolRoutes(db: Db) {
  const router = Router();
  const svc = agentPoolService(db);
  const base = "/companies/:companyId/agent-pools";
  router.use(base, (req, _res, next) => {
    assertBoard(req);
    assertCompanyAccess(req, z.string().uuid().parse(req.params.companyId));
    next();
  });
  const company = (value: unknown) => z.string().uuid().parse(value);
  const id = company;
  router.get(base, async (req, res) => res.json(await svc.list(company(req.params.companyId))));
  router.post(base, validate(createAgentPoolSchema), async (req, res) => {
    const companyId = company(req.params.companyId);
    const pool = await svc.create(companyId, createAgentPoolSchema.parse(req.body).name);
    await logActivity(db, {
      companyId, actorType: "user", actorId: req.actor.userId ?? "local-board",
      action: "agent_pool.created", entityType: "agent_pool", entityId: pool.id, details: { name: pool.name },
    });
    res.status(201).json(pool);
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
