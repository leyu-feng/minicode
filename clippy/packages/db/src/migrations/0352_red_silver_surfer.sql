CREATE TABLE "pr_inspection_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"inspection_issue_id" uuid NOT NULL,
	"created_by_run_id" uuid,
	"result" jsonb NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pr_inspection_results_company_inspection_uq" UNIQUE("company_id","inspection_issue_id")
);
--> statement-breakpoint
ALTER TABLE "pr_inspection_results" ADD CONSTRAINT "pr_inspection_results_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_inspection_results" ADD CONSTRAINT "pr_inspection_results_inspection_issue_id_issues_id_fk" FOREIGN KEY ("inspection_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_inspection_results" ADD CONSTRAINT "pr_inspection_results_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;