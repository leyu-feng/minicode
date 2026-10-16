import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { agentPools, agentPoolWorkers, type Db } from "@paperclipai/db";
import { agentPoolNameSchema } from "@paperclipai/shared";
import { conflict, notFound, unauthorized } from "../errors.js";

export function hashAgentPoolToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function agentPoolService(db: Db) {
  async function list(companyId: string) {
    await db.insert(agentPools).values({ companyId, name: "default" }).onConflictDoNothing();
    return db.select().from(agentPools).where(eq(agentPools.companyId, companyId)).orderBy(agentPools.name);
  }

  async function get(companyId: string, poolId: string) {
    const [pool] = await db.select().from(agentPools)
      .where(and(eq(agentPools.id, poolId), eq(agentPools.companyId, companyId)));
    if (!pool) throw notFound("Agent pool not found");
    return pool;
  }

  return {
    list,
    get,
    async create(companyId: string, name: string) {
      await list(companyId);
      const [pool] = await db.insert(agentPools).values({ companyId, name: agentPoolNameSchema.parse(name) })
        .onConflictDoNothing().returning();
      if (!pool) throw conflict("An agent pool with that name already exists");
      return pool;
    },
    async workers(companyId: string, poolId: string) {
      await get(companyId, poolId);
      return db.select().from(agentPoolWorkers).where(eq(agentPoolWorkers.poolId, poolId));
    },
    async issuePairing(companyId: string, poolId: string, name: string) {
      await get(companyId, poolId);
      const serverToken = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 10 * 60_000);
      const [worker] = await db.insert(agentPoolWorkers).values({
        poolId, name, pairingTokenHash: hashAgentPoolToken(serverToken), pairingExpiresAt: expiresAt,
      }).returning();
      return { workerId: worker.id, serverToken, expiresAt: expiresAt.toISOString() };
    },
    async pair(workerId: string, serverToken: string, clientToken: string) {
      const [worker] = await db.update(agentPoolWorkers).set({
        clientTokenHash: hashAgentPoolToken(clientToken), pairingTokenHash: null, pairingExpiresAt: null,
      }).where(and(
        eq(agentPoolWorkers.id, workerId),
        eq(agentPoolWorkers.pairingTokenHash, hashAgentPoolToken(serverToken)),
        gt(agentPoolWorkers.pairingExpiresAt, new Date()),
        isNull(agentPoolWorkers.clientTokenHash), isNull(agentPoolWorkers.revokedAt),
      )).returning();
      if (!worker) throw unauthorized("Invalid, expired, or already used AgentPool pairing token");
      return { workerId: worker.id };
    },
    async authenticate(workerId: string, token: string) {
      if (!/^[a-f0-9]{64}$/.test(token)) return null;
      const [worker] = await db.select({
        id: agentPoolWorkers.id, companyId: agentPools.companyId, poolName: agentPools.name,
      }).from(agentPoolWorkers).innerJoin(agentPools, eq(agentPoolWorkers.poolId, agentPools.id))
        .where(and(eq(agentPoolWorkers.id, workerId),
          eq(agentPoolWorkers.clientTokenHash, hashAgentPoolToken(token)), isNull(agentPoolWorkers.revokedAt)));
      return worker ?? null;
    },
    async revoke(companyId: string, poolId: string, workerId: string) {
      await get(companyId, poolId);
      const [worker] = await db.update(agentPoolWorkers).set({
        revokedAt: new Date(), clientTokenHash: null, pairingTokenHash: null, pairingExpiresAt: null,
      }).where(and(eq(agentPoolWorkers.id, workerId), eq(agentPoolWorkers.poolId, poolId))).returning();
      if (!worker) throw notFound("AgentPool worker not found");
      return worker;
    },
  };
}
