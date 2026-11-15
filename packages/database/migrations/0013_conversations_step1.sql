ALTER TABLE "repositories" ADD COLUMN "sandbox_image_id" uuid;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "setup_script" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "repository_id" uuid;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "git_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "title_source" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_git_connection_id_git_connections_id_fk" FOREIGN KEY ("git_connection_id") REFERENCES "public"."git_connections"("id") ON DELETE set null ON UPDATE no action;