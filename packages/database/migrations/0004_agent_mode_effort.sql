ALTER TABLE "agent_runs" ADD COLUMN "agent_mode" text DEFAULT 'autonomous' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "thinking_level" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "thinking_level" text DEFAULT 'medium' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "agent_mode" text DEFAULT 'autonomous' NOT NULL;