CREATE TABLE "agent_pool_workers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pool_id" uuid NOT NULL,
	"name" text NOT NULL,
	"pairing_token_hash" text,
	"pairing_expires_at" timestamp with time zone,
	"client_token_hash" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_pool_workers" ADD CONSTRAINT "agent_pool_workers_pool_id_agent_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."agent_pools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_pools" ADD CONSTRAINT "agent_pools_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_pool_workers_pool_idx" ON "agent_pool_workers" USING btree ("pool_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_pools_company_name_idx" ON "agent_pools" USING btree ("company_id","name");