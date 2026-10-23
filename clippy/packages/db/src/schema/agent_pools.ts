import { pgTable, uuid, text, timestamp, uniqueIndex, index, bigint } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";

export const agentPools = pgTable("agent_pools", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  name: text("name").notNull(),
  // Preserve the existing SQL default; pool creation supplies its type explicitly.
  type: text("type").$type<"freelance" | "devbox" | "hosted">().notNull().default("freelance"),
  hostedApiUrl: text("hosted_api_url"),
  hostedAudience: text("hosted_audience"),
  hostedPoolId: uuid("hosted_pool_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  companyNameIdx: uniqueIndex("agent_pools_company_name_idx").on(table.companyId, table.name),
  companyHostedIdx: uniqueIndex("agent_pools_one_hosted_per_company_idx").on(table.companyId).where(sql`${table.type} = 'hosted'`),
}));

export const agentPoolWorkers = pgTable("agent_pool_workers", {
  id: uuid("id").primaryKey().defaultRandom(),
  poolId: uuid("pool_id").notNull().references(() => agentPools.id),
  name: text("name").notNull(),
  pairingTokenHash: text("pairing_token_hash"),
  pairingExpiresAt: timestamp("pairing_expires_at", { withTimezone: true }),
  clientTokenHash: text("client_token_hash"),
  hostedExecutionId: uuid("hosted_execution_id"),
  hostedGeneration: uuid("hosted_generation"),
  hostedActivationVersion: bigint("hosted_activation_version", { mode: "number" }).notNull().default(0),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  poolIdx: index("agent_pool_workers_pool_idx").on(table.poolId),
}));
