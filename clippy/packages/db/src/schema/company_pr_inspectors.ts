import { foreignKey, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const companyPrInspectors = pgTable("company_pr_inspectors", {
  companyId: uuid("company_id").primaryKey().references(() => companies.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    columns: [table.companyId, table.agentId],
    foreignColumns: [agents.companyId, agents.id],
  }).onDelete("cascade"),
]);
