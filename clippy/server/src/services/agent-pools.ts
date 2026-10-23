import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { agentPools, agentPoolWorkers, type Db } from "@paperclipai/db";
import { agentPoolNameSchema, hostedAgentRepositoriesSchema, type AgentPool, type HostedWorkerRepository,
  type hostedAgentPoolWorkerSchema, type hostedAgentPoolSlotsSchema } from "@paperclipai/shared";
import type { z } from "zod";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../errors.js";
import type { HostedWorkerProviderGrant } from "./entra-hosted-workers.js";
import { defaultHostedWorkerConfig, hostedWorkerClient } from "./hosted-worker-client.js";
import { agentPoolBroker } from "./agent-pool-broker.js";
import type { AdapterExecutionContext } from "../adapters/types.js";
import { setTimeout as delay } from "node:timers/promises";
import { logger } from "../middleware/logger.js";

type Pool = typeof agentPools.$inferSelect;

function poolView(pool: Pool): AgentPool {
  return { ...pool, type: pool.type === "freelance" ? "devbox" : pool.type };
}

export function hashAgentPoolToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function agentPoolService(db: Db) {
  const waiting = new Map<string, { runs: Set<string>; tail: Promise<void> }>();

  function hostedConfig(pool: Pool) {
    if (pool.type !== "hosted" || pool.name !== "default") {
      throw conflict("Only the default pool uses the built-in agent host.");
    }
    const config = defaultHostedWorkerConfig();
    if (!config) throw conflict("The built-in agent host is not configured. Set PAPERCLIP_HOSTED_WORKER_URL and PAPERCLIP_HOSTED_WORKER_AUDIENCE in the deployment.");
    return config;
  }

  function provider(pool: Pool) {
    const config = hostedConfig(pool);
    if (!pool.hostedPoolId) throw conflict("Hosted pool is not provisioned. Retry after the built-in agent host is available.");
    return { client: hostedWorkerClient(config), poolId: pool.hostedPoolId };
  }

  async function provision(companyId: string, poolId: string, signal?: AbortSignal) {
    return db.transaction(async (tx) => {
      const [pool] = await tx.select().from(agentPools)
        .where(and(eq(agentPools.id, poolId), eq(agentPools.companyId, companyId))).for("update");
      if (!pool) throw notFound("Agent pool not found");
      if (pool.type !== "hosted") return pool;
      const config = hostedConfig(pool);
      if (pool.hostedPoolId) return pool;
      const hostedPoolId = await hostedWorkerClient(config).create(companyId, pool.name, signal);
      const [updated] = await tx.update(agentPools).set({ hostedPoolId }).where(eq(agentPools.id, pool.id)).returning();
      return updated;
    });
  }

  async function ensureDefault(companyId: string, provisionHosted = true) {
    const config = defaultHostedWorkerConfig();
    await db.insert(agentPools).values({
      companyId, name: "default", type: "hosted",
      hostedApiUrl: config?.apiUrl ?? null, hostedAudience: config?.audience ?? null,
    }).onConflictDoNothing();
    const [pool] = await db.select().from(agentPools)
      .where(and(eq(agentPools.companyId, companyId), eq(agentPools.name, "default")));
    return poolView(provisionHosted && config ? await provision(companyId, pool.id) : pool);
  }

  async function list(companyId: string) {
    await ensureDefault(companyId, false);
    const pools = await db.select().from(agentPools).where(eq(agentPools.companyId, companyId)).orderBy(agentPools.name);
    return pools.map(poolView);
  }

  async function get(companyId: string, poolId: string) {
    const [pool] = await db.select().from(agentPools)
      .where(and(eq(agentPools.id, poolId), eq(agentPools.companyId, companyId)));
    if (!pool) throw notFound("Agent pool not found");
    return poolView(pool);
  }

  function resolveRepositories(config: Record<string, unknown>, repos: HostedWorkerRepository[]) {
    if (repos.every(repo => repo.workspaceMode === "all_repositories")) {
      const { primaryRepositoryId: _primary, referenceRepositoryIds: _references, ...workspaceConfig } = config;
      return {
        config: workspaceConfig,
        repositories: { mode: "all_repositories" as const, repositories: repos.map(repo => ({
          id: repo.id, name: repo.name, branch: repo.branch, readOnly: repo.readOnly === true,
          supervisory: repo.supervisory === true,
        })) },
      };
    }
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

  async function hostedWorker(input: z.infer<typeof hostedAgentPoolWorkerSchema>, grant: HostedWorkerProviderGrant,
    mode: "pair" | "revoke" | "deactivate") {
    const revoke = mode !== "pair";
    return db.transaction(async (tx) => {
      const registration = tx.select().from(agentPools).where(and(
        eq(agentPools.companyId, input.companyId), eq(agentPools.name, input.poolName),
        eq(agentPools.type, "hosted"), eq(agentPools.hostedPoolId, input.poolId),
      ));
      // Provider retirement callbacks must not wait for the pool's provisioning lock.
      const [pool] = await (revoke ? registration : registration.for("update"));
      if (!pool) {
        if (revoke) return { workerId: input.workerId, created: false, revoked: false };
        throw conflict("Hosted pool is not registered; retry worker bootstrap after provisioning commits");
      }
      const config = hostedConfig(pool);
      if (config.apiUrl.replace(/\/+$/, "") !== grant.apiUrl.replace(/\/+$/, "")
        || config.audience !== grant.audience) {
        throw forbidden("The calling provider does not own this Hosted pool");
      }
      let created = false;
      if (!revoke) {
        if (!input.clientToken) throw badRequest("Hosted worker pairing requires a client credential");
        const inserted = await tx.insert(agentPoolWorkers).values({
          id: input.workerId, poolId: pool.id, name: `hosted-${input.workerId}`,
          clientTokenHash: hashAgentPoolToken(input.clientToken),
          hostedExecutionId: input.executionId ?? null, hostedGeneration: input.generation ?? null,
          hostedActivationVersion: input.activationVersion ?? 0,
        }).onConflictDoNothing().returning({ id: agentPoolWorkers.id });
        created = inserted.length !== 0;
      }
      const [worker] = await tx.select().from(agentPoolWorkers)
        .where(eq(agentPoolWorkers.id, input.workerId)).for("update");
      if (!worker) return { workerId: input.workerId, created: false, revoked: false };
      if (worker.poolId !== pool.id) throw forbidden("The Hosted worker belongs to another pool");
      let reactivated = false;
      if (mode === "deactivate") {
        if (!input.executionId || worker.hostedExecutionId !== input.executionId || worker.hostedGeneration !== input.generation) {
          return { workerId: worker.id, created: false, revoked: false, reactivated: false, deactivated: false };
        }
        await tx.update(agentPoolWorkers).set({ clientTokenHash: null, hostedExecutionId: null })
          .where(eq(agentPoolWorkers.id, worker.id));
        return { workerId: worker.id, created: false, revoked: false, reactivated: false, deactivated: true };
      } else if (revoke) {
        if (input.executionId && (worker.hostedExecutionId !== input.executionId || worker.hostedGeneration !== input.generation)) {
          return { workerId: worker.id, created: false, revoked: false, reactivated: false };
        }
        await tx.update(agentPoolWorkers).set({
          revokedAt: new Date(), clientTokenHash: null, pairingTokenHash: null, pairingExpiresAt: null,
        }).where(eq(agentPoolWorkers.id, worker.id));
      } else if (!worker.revokedAt && input.executionId
        && (input.activationVersion ?? 0) > worker.hostedActivationVersion) {
        await tx.update(agentPoolWorkers).set({
          clientTokenHash: hashAgentPoolToken(input.clientToken!),
          hostedExecutionId: input.executionId, hostedGeneration: input.generation,
          hostedActivationVersion: input.activationVersion!,
          pairingTokenHash: null, pairingExpiresAt: null,
        }).where(eq(agentPoolWorkers.id, worker.id));
        reactivated = true;
      } else if (worker.revokedAt && !/^W\d\d$/.test(worker.name) && input.executionId
        && worker.hostedActivationVersion === 0 && !input.activationVersion && input.generation !== worker.hostedGeneration) {
        await tx.update(agentPoolWorkers).set({
          revokedAt: null, clientTokenHash: hashAgentPoolToken(input.clientToken!),
          hostedExecutionId: input.executionId, hostedGeneration: input.generation,
          pairingTokenHash: null, pairingExpiresAt: null,
        }).where(eq(agentPoolWorkers.id, worker.id));
        reactivated = true;
      } else if (worker.revokedAt || worker.clientTokenHash !== hashAgentPoolToken(input.clientToken!)
        || worker.hostedExecutionId !== (input.executionId ?? null) || worker.hostedGeneration !== (input.generation ?? null)
        || worker.hostedActivationVersion !== (input.activationVersion ?? 0)) {
        throw forbidden("The Hosted worker is revoked or already paired to another credential");
      }
      return { workerId: worker.id, created, revoked: revoke, reactivated };
    });
  }

  return {
    pairHostedWorker: (input: z.infer<typeof hostedAgentPoolWorkerSchema>, grant: HostedWorkerProviderGrant) =>
      hostedWorker(input, grant, "pair"),
    revokeHostedWorker: (input: z.infer<typeof hostedAgentPoolWorkerSchema>, grant: HostedWorkerProviderGrant) =>
      hostedWorker(input, grant, "revoke"),
    deactivateHostedWorker: (input: z.infer<typeof hostedAgentPoolWorkerSchema>, grant: HostedWorkerProviderGrant) =>
      hostedWorker(input, grant, "deactivate"),
    async registerHostedSlots(input: z.infer<typeof hostedAgentPoolSlotsSchema>, grant: HostedWorkerProviderGrant) {
      return db.transaction(async tx => {
        const [pool] = await tx.select().from(agentPools).where(and(
          eq(agentPools.companyId, input.companyId), eq(agentPools.name, input.poolName),
          eq(agentPools.hostedPoolId, input.poolId), eq(agentPools.type, "hosted"),
        )).for("update");
        if (!pool) throw conflict("Hosted pool is not registered");
        const config = hostedConfig(pool);
        if (config.apiUrl.replace(/\/+$/, "") !== grant.apiUrl.replace(/\/+$/, "")
          || config.audience !== grant.audience) throw forbidden("The calling provider does not own this Hosted pool");
        const existing = await tx.select({ poolId: agentPoolWorkers.poolId }).from(agentPoolWorkers)
          .where(inArray(agentPoolWorkers.id, input.slots.map(slot => slot.workerId)));
        if (existing.some(worker => worker.poolId !== pool.id)) throw forbidden("A worker slot belongs to another pool");
        await tx.insert(agentPoolWorkers).values(input.slots.map(slot => ({
          id: slot.workerId, poolId: pool.id, name: slot.name,
        }))).onConflictDoUpdate({ target: agentPoolWorkers.id, set: { name: sql`excluded.name` } });
        return { registeredSlots: input.slots.length };
      });
    },
    list,
    get,
    ensureDefault,
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
        if (!pool.hostedPoolId && !pool.hostedApiUrl && !pool.hostedAudience && !defaultHostedWorkerConfig()) continue;
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
      const reserve = async () => {
        if (!agentPoolBroker.reserveAvailableWorker(ctx)) return false;
        const worker = agentPoolBroker.reservedWorker(ctx.runId);
        if (worker?.executionId) await client.claim(remoteId, {
          workerId: worker.id, runId: ctx.runId, agentId: ctx.agent.id,
        }, signal);
        return true;
      };
      if (await reserve()) return;
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
        while (!await reserve()) {
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
      const [pool] = await db.insert(agentPools).values({ companyId, name: agentPoolNameSchema.parse(name), type: "devbox" })
        .onConflictDoNothing().returning();
      if (!pool) throw conflict("An agent pool with that name already exists");
      return poolView(pool);
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
        if (pool.type === "hosted" || pool.name === "default") {
          throw conflict("Only Devbox pools support manual worker pairing.");
        }
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
        inArray(agentPoolWorkers.poolId, db.select({ id: agentPools.id }).from(agentPools)
          .where(and(ne(agentPools.type, "hosted"), ne(agentPools.name, "default")))),
      )).returning();
      if (!worker) throw unauthorized("Invalid, expired, or already used AgentPool pairing token");
      return { workerId: worker.id };
    },
    async authenticate(workerId: string, token: string) {
      if (!/^[a-f0-9]{64}$/.test(token)) return null;
      const [worker] = await db.select({
        id: agentPoolWorkers.id, companyId: agentPools.companyId, poolName: agentPools.name,
        executionId: agentPoolWorkers.hostedExecutionId,
      }).from(agentPoolWorkers).innerJoin(agentPools, eq(agentPoolWorkers.poolId, agentPools.id))
        .where(and(eq(agentPoolWorkers.id, workerId),
          eq(agentPoolWorkers.clientTokenHash, hashAgentPoolToken(token)), isNull(agentPoolWorkers.revokedAt)));
      return worker ?? null;
    },
    async revoke(companyId: string, poolId: string, workerId: string) {
      const pool = await get(companyId, poolId);
      if (pool.type !== "devbox") {
        throw conflict("Only Devbox pools support manual worker revocation.");
      }
      const [worker] = await db.update(agentPoolWorkers).set({
        revokedAt: new Date(), clientTokenHash: null, pairingTokenHash: null, pairingExpiresAt: null,
      }).where(and(eq(agentPoolWorkers.id, workerId), eq(agentPoolWorkers.poolId, poolId))).returning();
      if (!worker) throw notFound("AgentPool worker not found");
      return worker;
    },
  };
}
