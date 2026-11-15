-- Conversations autonomes (sans équipes ni projets). Données de portée « équipe » ou « projet »
-- effacées (environnement de développement) avant de recréer les index sans la colonne équipe.
DELETE FROM "skill_installations" WHERE "scope" = 'team';--> statement-breakpoint
DELETE FROM "skills" WHERE "scope" = 'team';--> statement-breakpoint
DELETE FROM "mcp_installations" WHERE "scope" = 'team';--> statement-breakpoint
DELETE FROM "mcp_permissions" WHERE "scope" = 'team';--> statement-breakpoint
DELETE FROM "mcp_servers" WHERE "scope" = 'team';--> statement-breakpoint
DELETE FROM "environment_variables" WHERE "scope" <> 'repository';--> statement-breakpoint
DELETE FROM "quota_policies" WHERE "scope" = 'team';--> statement-breakpoint
ALTER TABLE "project_members" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "projects" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_members" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "teams" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "project_members" CASCADE;--> statement-breakpoint
DROP TABLE "projects" CASCADE;--> statement-breakpoint
DROP TABLE "team_members" CASCADE;--> statement-breakpoint
DROP TABLE "teams" CASCADE;--> statement-breakpoint
ALTER TABLE "workspaces" DROP CONSTRAINT IF EXISTS "workspaces_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "workspaces" DROP CONSTRAINT IF EXISTS "workspaces_team_id_teams_id_fk";
--> statement-breakpoint
ALTER TABLE "llm_requests" DROP CONSTRAINT IF EXISTS "llm_requests_team_id_teams_id_fk";
--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP CONSTRAINT IF EXISTS "mcp_servers_team_id_teams_id_fk";
--> statement-breakpoint
ALTER TABLE "skills" DROP CONSTRAINT IF EXISTS "skills_team_id_teams_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "workspaces_project_id_index";--> statement-breakpoint
DROP INDEX IF EXISTS "credit_ledger_team_id_occurred_at_index";--> statement-breakpoint
DROP INDEX IF EXISTS "credit_reservations_open_team_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "mcp_servers_scope_name_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "skills_scope_name_uq";--> statement-breakpoint
ALTER TABLE "environment_variables" ALTER COLUMN "scope" SET DEFAULT 'repository';--> statement-breakpoint
CREATE INDEX "workspaces_repository_id_index" ON "workspaces" USING btree ("repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_scope_name_uq" ON "mcp_servers" USING btree ("scope",coalesce("owner_id", '00000000-0000-0000-0000-000000000000'::uuid),"name");--> statement-breakpoint
CREATE UNIQUE INDEX "skills_scope_name_uq" ON "skills" USING btree ("scope",coalesce("owner_id", '00000000-0000-0000-0000-000000000000'::uuid),"name");--> statement-breakpoint
ALTER TABLE "invitations" DROP COLUMN "team_id";--> statement-breakpoint
ALTER TABLE "invitations" DROP COLUMN "role";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "project_id";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "team_id";--> statement-breakpoint
ALTER TABLE "credit_ledger" DROP COLUMN "team_id";--> statement-breakpoint
ALTER TABLE "credit_reservations" DROP COLUMN "team_id";--> statement-breakpoint
ALTER TABLE "llm_models" DROP COLUMN "allowed_team_ids";--> statement-breakpoint
ALTER TABLE "llm_requests" DROP COLUMN "team_id";--> statement-breakpoint
ALTER TABLE "run_tokens" DROP COLUMN "team_id";--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP COLUMN "team_id";--> statement-breakpoint
ALTER TABLE "skills" DROP COLUMN "team_id";