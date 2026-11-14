ALTER TABLE "attachments" ADD COLUMN "source" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD COLUMN "images" jsonb DEFAULT '[]'::jsonb NOT NULL;