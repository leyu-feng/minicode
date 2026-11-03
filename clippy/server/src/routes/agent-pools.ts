import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createAgentPoolSchema, createAgentPoolWorkerSchema, pairAgentPoolWorkerSchema,
  hostedWorkerDemandSchema, hostedAgentPoolWorkerSchema, hostedAgentPoolSlotsSchema } from "@paperclipai/shared";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertBoardOrAgent, assertCompanyAccess } from "./authz.js";
import { logActivity } from "../services/activity-log.js";
import { agentPoolService } from "../services/agent-pools.js";
import { agentPoolBroker } from "../services/agent-pool-broker.js";
import { unauthorized, notFound, forbidden } from "../errors.js";
import { agentPoolSkillsArchive } from "../services/agent-pool-skills.js";
import { authenticateHostedWorkerProvider } from "../services/entra-hosted-workers.js";
import { agentGitHubAuthService } from "../services/agent-github-auth.js";
import { agentPoolGitIdentitySchema } from "@paperclipai/shared";
import { prInspectorService } from "../services/pr-inspector.js";

export function agentPoolPairingRoutes(db: Db) {
  const router = Router();
  const svc = agentPoolService(db);
  router.get("/api/agent-pool/hosted/organizations", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const grant = await authenticateHostedWorkerProvider(req.headers.authorization);
    res.json(await svc.hostedOrganizationNames(grant));
  });
  router.post("/api/agent-pool/hosted/slots", validate(hostedAgentPoolSlotsSchema), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const grant = await authenticateHostedWorkerProvider(req.headers.authorization);
    const input = hostedAgentPoolSlotsSchema.parse(req.body);
    res.json(await svc.registerHostedSlots(input, grant));
  });
  router.put("/api/agent-pool/hosted/workers", validate(hostedAgentPoolWorkerSchema), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const grant = await authenticateHostedWorkerProvider(req.headers.authorization);
    const result = await svc.deactivateHostedWorker(hostedAgentPoolWorkerSchema.parse(req.body), grant);
    if (result.deactivated) agentPoolBroker.disconnect(result.workerId, "Hosted worker connection is inactive");
    res.status(204).end();
  });
  router.post("/api/agent-pool/hosted/workers", validate(hostedAgentPoolWorkerSchema), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const grant = await authenticateHostedWorkerProvider(req.headers.authorization);
    const input = hostedAgentPoolWorkerSchema.parse(req.body);
    const result = await svc.pairHostedWorker(input, grant);
    if (result.reactivated) agentPoolBroker.reactivate(result.workerId);
    if (result.created || result.reactivated) await logActivity(db, {
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
  const github = agentGitHubAuthService(db);
  const inspectors = prInspectorService(db);
  router.get("/companies/:companyId/pr-inspector", async (req, res) => {
    assertBoardOrAgent(req);
    const companyId = z.string().uuid().parse(req.params.companyId);
    assertCompanyAccess(req, companyId);
    res.setHeader("Cache-Control", "no-store");
    res.json(await inspectors.get(companyId));
  });
  router.post("/companies/:companyId/pr-inspector", validate(z.object({}).strict()), async (req, res) => {
    assertBoard(req);
    const companyId = z.string().uuid().parse(req.params.companyId);
    assertCompanyAccess(req, companyId);
    const state = await inspectors.create(companyId, req.actor.userId ?? null);
    await logActivity(db, {
      companyId, actorType: "user", actorId: req.actor.userId ?? "local-board",
      action: "company.pr_inspector_created", entityType: "company", entityId: companyId,
      details: { agentId: state.agentId },
    });
    res.json(state);
  });
  router.use(agentPoolSkillsRoutes());
  const login = "/companies/:companyId/agents/:agentId/github-login";
  router.use(login, (req, res, next) => {
    assertBoard(req);
    assertCompanyAccess(req, z.string().uuid().parse(req.params.companyId));
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.get(login, async (req, res) => res.json(await github.status(
    z.string().uuid().parse(req.params.companyId), z.string().uuid().parse(req.params.agentId),
  )));
  router.post(login, async (req, res) => {
    const companyId = z.string().uuid().parse(req.params.companyId);
    const agentId = z.string().uuid().parse(req.params.agentId);
    const status = await github.start(companyId, agentId, req.actor.userId);
    await logActivity(db, {
      companyId, actorType: "user", actorId: req.actor.userId ?? "local-board",
      action: "agent.github_login_started", entityType: "agent", entityId: agentId,
    });
    res.json(status);
  });
  router.put(`${login}/git-identity`, validate(agentPoolGitIdentitySchema), async (req, res) => {
    const companyId = z.string().uuid().parse(req.params.companyId);
    const agentId = z.string().uuid().parse(req.params.agentId);
    const status = await github.updateIdentity(companyId, agentId, agentPoolGitIdentitySchema.parse(req.body));
    await logActivity(db, {
      companyId, actorType: "user", actorId: req.actor.userId ?? "local-board",
      action: "agent.git_identity_updated", entityType: "agent", entityId: agentId,
    });
    res.json(status);
  });
  router.post(`${login}/poll`, async (req, res) => {
    const companyId = z.string().uuid().parse(req.params.companyId);
    const agentId = z.string().uuid().parse(req.params.agentId);
    const { status, completed } = await github.poll(companyId, agentId);
    if (completed) await logActivity(db, {
      companyId, actorType: "user", actorId: req.actor.userId ?? "local-board",
      action: "agent.github_login_completed", entityType: "agent", entityId: agentId,
    });
    res.json(status);
  });
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
  router.get(`${base}/:poolId/status`, async (req, res) =>
    res.json(await svc.status(company(req.params.companyId), id(req.params.poolId))));
  router.get(`${base}/:poolId/repos`, async (req, res) =>
    res.json(await svc.repositories(company(req.params.companyId), id(req.params.poolId))));
  router.get(`${base}/:poolId/harnesses`, async (req, res) =>
    res.json(await svc.harnesses(company(req.params.companyId), id(req.params.poolId))));
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
      paired: /^W\d\d$/.test(worker.name) || Boolean(worker.clientTokenHash), revoked: Boolean(worker.revokedAt),
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
