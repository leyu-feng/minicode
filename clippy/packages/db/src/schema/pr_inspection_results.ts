import type { PrInspectionResult } from "@paperclipai/shared";
import { jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const prInspectionResults = pgTable(
  "pr_inspection_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    inspectionIssueId: uuid("inspection_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    result: jsonb("result").$type<PrInspectionResult>().notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    inspectionUq: unique("pr_inspection_results_company_inspection_uq").on(table.companyId, table.inspectionIssueId),
  }),
);
