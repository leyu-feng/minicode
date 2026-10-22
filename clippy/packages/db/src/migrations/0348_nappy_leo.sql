ALTER TABLE "agent_pools" ADD COLUMN "type" text DEFAULT 'freelance' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_pools" ADD COLUMN "hosted_api_url" text;--> statement-breakpoint
ALTER TABLE "agent_pools" ADD COLUMN "hosted_audience" text;--> statement-breakpoint
ALTER TABLE "agent_pools" ADD COLUMN "hosted_pool_id" uuid;