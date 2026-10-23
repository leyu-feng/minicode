import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { agentPools, agentPoolWorkers, type Db } from "@paperclipai/db";
import { agentPoolNameSchema, hostedAgentRepositoriesSchema, type HostedWorkerRepository, type UpdateAgentPool,
  type hostedAgentPoolWorkerSchema } from "@paperclipai/shared";
import type { z } from "zod";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../errors.js";
import type { HostedWorkerProviderGrant } from "./entra-hosted-workers.js";
import { defaultHostedWorkerConfig, hostedWorkerClient } from "./hosted-worker-client.js";
import { agentPoolBroker } from "./agent-pool-broker.js";
import type { AdapterExecutionContext } from "../adapters/types.js";
import { setTimeout as delay } from "node:timers/promises";
import { logger } from "../middleware/logger.js";

type Pool = typeof agentPools.$inferSelect;

export function hashAgentPoolToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function agentPoolService(db: Db) {
  const waiting = new Map<string, { runs: Set<string>; tail: Promise<void> }>();

  function provider(pool: Pool) {
    if (pool.type !== "hosted" || !pool.hostedApiUrl || !pool.hostedAudience || !pool.hostedPoolId) {
      throw conflict("Hosted pool is not provisioned. Open Agent pools and reconnect the provider.");
    }
    return { client: hostedWorkerClient({ apiUrl: pool.hostedApiUrl, audience: pool.hostedAudience }), poolId: pool.hostedPoolId };
  }

  async function provision(companyId: string, poolId: string, signal?: AbortSignal) {
    return db.transaction(async (tx) => {
      const [pool] = await tx.select().from(agentPools)
        .where(and(eq(agentPools.id, poolId), eq(agentPools.companyId, companyId))).for("update");
      if (!pool) throw notFound("Agent pool not found");
      if (pool.type !== "hosted" || pool.hostedPoolId) return pool;
      if (!pool.hostedApiUrl || !pool.hostedAudience) throw conflict("Hosted provider configuration is missing.");
      const hostedPoolId = await hostedWorkerClient({ apiUrl: pool.hostedApiUrl, audience: pool.hostedAudience }).create(companyId, pool.name, signal);
      const [updated] = await tx.update(agentPools).set({ hostedPoolId }).where(eq(agentPools.id, pool.id)).returning();
      return updated;
    });
  }

  async function ensureDefault(companyId: string, provisionHosted = true) {
    const config = defaultHostedWorkerConfig();
    await db.insert(agentPools).values({
      companyId, name: "default", ...(config ? {
        type: "hosted" as const, hostedApiUrl: config.apiUrl, hostedAudience: config.audience,
      } : {}),
    }).onConflictDoNothing();
    const [pool] = await db.select().from(agentPools)
      .where(and(eq(agentPools.companyId, companyId), eq(agentPools.name, "default")));
    return provisionHosted ? provision(companyId, pool.id) : pool;
  }

  async function list(companyId: string) {
    await ensureDefault(companyId, false);
    return db.select().from(agentPools).where(eq(agentPools.companyId, companyId)).orderBy(agentPools.name);
  }

  async function get(companyId: string, poolId: string) {
    const [pool] = await db.select().from(agentPools)
      .where(and(eq(agentPools.id, poolId), eq(agentPools.companyId, companyId)));
    if (!pool) throw notFound("Agent pool not found");
    return pool;
  }

  function resolveRepositories(config: Record<string, unknown>, repos: HostedWorkerRepository[]) {
    const selections = hostedAgentRepositoriesSchema.parse(config);
    const primaryRepositoryId = selections.primaryRepositoryId ?? repos.find((repo) => repo.isDefault)!.id;
    const primary = repos.find((repo) => repo.id === primaryRepositoryId);
    if (!primary || selections.referenceRepositoryIds.some((id) => !repos.some((repo) => repo.id === id))
      || selections.referenceRepositoryIds.includes(primaryRepositoryId)) {
      throw badRequest("Select distinct primary and reference repositories from this pool's catalog.");
    }
    return {
      config: { ...config, primaryRepositoryId, referenceRepositoryIds: selections.referenceRepositoryIds },
      repositories: { primary, references: selections.referenceRepositoryIds.map((id) => repos.find((repo) => repo.id === id)!) },
    };
  }

  async function hostedWorker(input: z.infer<typeof hostedAgentPoolWorkerSchema>, grant: HostedWorkerProviderGrant, revoke: boolean) {
    return db.transaction(async (tx) => {
      const registration = tx.select().from(agentPools).where(and(
        eq(agentPools.companyId, input.companyId), eq(agentPools.name, input.poolName),
        eq(agentPools.type, "hosted"), eq(agentPools.hostedPoolId, input.poolId),
      ));
      // Revocation may be a provider callback from update(), which already locks this pool.
      const [pool] = await (revoke ? registration : registration.for("update"));
      if (!pool) {
        if (revoke) return { workerId: input.workerId, created: false, revoked: false };
        throw conflict("Hosted pool is not registered; retry worker bootstrap after provisioning commits");
      }
      if (pool.hostedApiUrl?.replace(/\/+$/, "") !== grant.apiUrl.replace(/\/+$/, "")
        || pool.hostedAudience !== grant.audience) {
        throw forbidden("The calling provider does not own this Hosted pool");
      }
      let created = false;
      if (!revoke) {
        if (!input.clientToken) throw badRequest("Hosted worker pairing requires a client credential");
        const inserted = await tx.insert(agentPoolWorkers).values({
          id: input.workerId, poolId: pool.id, name: `hosted-${input.workerId}`,
          clientTokenHash: hashAgentPoolToken(input.clientToken),
        }).onConflictDoNothing().returning({ id: agentPoolWorkers.id });
        created = inserted.length !== 0;
      }
      const [worker] = await tx.select().from(agentPoolWorkers)
        .where(eq(agentPoolWorkers.id, input.workerId)).for("update");
      if (!worker) return { workerId: input.workerId, created: false, revoked: false };
      if (worker.poolId !== pool.id) throw forbidden("The Hosted worker belongs to another pool");
      if (revoke) {
        await tx.update(agentPoolWorkers).set({
          revokedAt: new Date(), clientTokenHash: null, pairingTokenHash: null, pairingExpiresAt: null,
        }).where(eq(agentPoolWorkers.id, worker.id));
      } else if (worker.revokedAt || worker.clientTokenHash !== hashAgentPoolToken(input.clientToken!)) {
        throw forbidden("The Hosted worker is revoked or already paired to another credential");
      }
      return { workerId: worker.id, created, revoked: revoke };
    });
  }

  return {
    pairHostedWorker: (input: z.infer<typeof hostedAgentPoolWorkerSchema>, grant: HostedWorkerProviderGrant) =>
      hostedWorker(input, grant, false),
    revokeHostedWorker: (input: z.infer<typeof hostedAgentPoolWorkerSchema>, grant: HostedWorkerProviderGrant) =>
      hostedWorker(input, grant, true),
    list,
    get,
    ensureDefault,
    async update(companyId: string, poolId: string, input: UpdateAgentPool) {
      const revoked = await db.transaction(async (tx) => {
        const [pool] = await tx.select().from(agentPools)
          .where(and(eq(agentPools.id, poolId), eq(agentPools.companyId, companyId))).for("update");
        if (!pool) throw notFound("Agent pool not found");
        const sameProvider = pool.type === "hosted" && input.type === "hosted"
          && pool.hostedApiUrl === input.config.apiUrl.replace(/\/+$/, "") && pool.hostedAudience === input.config.audience;
        if (pool.type === "hosted" && !sameProvider && pool.hostedApiUrl && pool.hostedAudience) {
          const client = hostedWorkerClient({ apiUrl: pool.hostedApiUrl, audience: pool.hostedAudience });
          const remoteId = pool.hostedPoolId ?? await client.create(companyId, pool.name);
          await client.delete(remoteId);
        }
        const workers = await tx.update(agentPoolWorkers).set({
          revokedAt: new Date(), clientTokenHash: null, pairingTokenHash: null, pairingExpiresAt: null,
        }).where(eq(agentPoolWorkers.poolId, pool.id)).returning({ id: agentPoolWorkers.id });
        await tx.update(agentPools).set(input.type === "hosted" ? {
          type: "hosted", hostedApiUrl: input.config.apiUrl.replace(/\/+$/, ""), hostedAudience: input.config.audience,
          hostedPoolId: sameProvider ? pool.hostedPoolId : null,
        } : { type: "freelance", hostedApiUrl: null, hostedAudience: null, hostedPoolId: null })
          .where(eq(agentPools.id, pool.id));
        return workers;
      });
      for (const worker of revoked) agentPoolBroker.revoke(worker.id, "AgentPool settings changed; pair again");
      const pool = await provision(companyId, poolId);
      if (pool.type === "hosted") {
        const { client, poolId: remoteId } = provider(pool);
        await client.status(remoteId);
        await client.repositories(remoteId);
      }
      return pool;
    },
    async status(companyId: string, poolId: string) {
      const { client, poolId: remoteId } = provider(await provision(companyId, poolId));
      return client.status(remoteId);
    },
    async repositories(companyId: string, poolId: string) {
      const { client, poolId: remoteId } = provider(await provision(companyId, poolId));
      return client.repositories(remoteId);
    },
    async report(companyId: string, poolId: string, itemsWaiting: number) {
      const { client, poolId: remoteId } = provider(await provision(companyId, poolId));
      await client.report(remoteId, itemsWaiting);
    },
    async validateAgentRepositories(companyId: string, config: Record<string, unknown>, signal?: AbortSignal) {
      const name = agentPoolNameSchema.parse(config.name ?? "default");
      const [pool] = await db.select().from(agentPools)
        .where(and(eq(agentPools.companyId, companyId), eq(agentPools.name, name)));
      if (!pool) {
        const selections = hostedAgentRepositoriesSchema.parse(config);
        if (selections.primaryRepositoryId !== undefined || selections.referenceRepositoryIds.length > 0) {
          throw badRequest("Select an existing agent pool before choosing repositories.");
        }
        return config;
      }
      if (pool.type !== "hosted") return config;
      const { client, poolId: remoteId } = provider(await provision(companyId, pool.id, signal));
      const repos = await client.repositories(remoteId, signal);
      return resolveRepositories(config, repos).config;
    },
    async deleteHostedPools(companyId: string) {
      const pools = await db.select().from(agentPools).where(eq(agentPools.companyId, companyId));
      for (const pool of pools) {
        if (pool.type !== "hosted") continue;
        const provisioned = await provision(companyId, pool.id);
        const { client, poolId: remoteId } = provider(provisioned);
        await client.delete(remoteId);
      }
    },
    async prepareExecution(ctx: AdapterExecutionContext) {
      const name = agentPoolNameSchema.parse(ctx.config.name ?? "default");
      const [pool] = await db.select().from(agentPools)
        .where(and(eq(agentPools.companyId, ctx.agent.companyId), eq(agentPools.name, name)));
      if (!pool || pool.type !== "hosted") return;
      const deadline = AbortSignal.timeout(118_000);
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, deadline]) : deadline;
      const { client, poolId: remoteId } = provider(await provision(ctx.agent.companyId, pool.id, signal));
      const repos = await client.repositories(remoteId, signal);
      const resolved = resolveRepositories(ctx.config, repos);
      Object.assign(ctx.config, resolved.config);
      ctx.context.paperclipHostedRepositories = resolved.repositories;
      if (agentPoolBroker.reserveAvailableWorker(ctx)) return;
      const pending = waiting.get(pool.id) ?? { runs: new Set<string>(), tail: Promise.resolve() };
      waiting.set(pool.id, pending);
      pending.runs.add(ctx.runId);
      const report = (reportSignal: AbortSignal) => {
        const send = () => {
          reportSignal.throwIfAborted();
          return client.report(remoteId, pending.runs.size, reportSignal);
        };
        pending.tail = pending.tail.then(send, send);
        return new Promise<void>((resolve, reject) => {
          const abort = () => reject(reportSignal.reason);
          reportSignal.addEventListener("abort", abort, { once: true });
          pending.tail.then(resolve, reject).finally(() => reportSignal.removeEventListener("abort", abort));
          if (reportSignal.aborted) abort();
        });
      };
      try {
        await client.status(remoteId, signal);
        await report(signal);
        while (!agentPoolBroker.reserveAvailableWorker(ctx)) {
          await delay(250, undefined, { signal });
          const current = await get(ctx.agent.companyId, pool.id);
          if (current.type !== "hosted" || current.hostedPoolId !== remoteId
            || current.hostedApiUrl !== pool.hostedApiUrl || current.hostedAudience !== pool.hostedAudience) {
            throw conflict("Agent pool changed while waiting for a hosted worker. Retry the task.");
          }
        }
      } catch (error) {
        if (signal.aborted && !ctx.signal?.aborted) {
          throw new Error("No hosted worker connected within two minutes. Provider capacity is not a connected, compatible worker.", { cause: error });
        }
        throw error;
      } finally {
        pending.runs.delete(ctx.runId);
        // A cancelled or admitted run is no longer waiting, even if no other task arrives.
        try {
          await report(AbortSignal.timeout(2_000));
        } catch (error) {
          logger.warn({ err: error, poolId: pool.id }, "Hosted worker backlog cleanup failed");
        }
        if (pending.runs.size === 0 && waiting.get(pool.id) === pending) waiting.delete(pool.id);
      }
    },
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
      const serverToken = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 10 * 60_000);
      const worker = await db.transaction(async (tx) => {
        const [pool] = await tx.select().from(agentPools)
          .where(and(eq(agentPools.id, poolId), eq(agentPools.companyId, companyId))).for("update");
        if (!pool) throw notFound("Agent pool not found");
        const [issued] = await tx.insert(agentPoolWorkers).values({
          poolId, name, pairingTokenHash: hashAgentPoolToken(serverToken), pairingExpiresAt: expiresAt,
        }).returning();
        return issued;
      });
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
