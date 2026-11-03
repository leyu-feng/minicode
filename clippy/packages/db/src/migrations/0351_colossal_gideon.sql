CREATE TABLE "company_pr_inspectors" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_pr_inspectors" ADD CONSTRAINT "company_pr_inspectors_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_pr_inspectors" ADD CONSTRAINT "company_pr_inspectors_company_id_agent_id_agents_company_id_id_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;