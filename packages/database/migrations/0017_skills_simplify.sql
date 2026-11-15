-- Skills simplifiés : plus de révocation ni de brouillon/suspension, plus d'historique de versions.
DELETE FROM "skills" WHERE "status" = 'revoked';--> statement-breakpoint
UPDATE "skills" SET "status" = 'published' WHERE "status" IN ('draft', 'disabled');--> statement-breakpoint
ALTER TABLE "skills" ALTER COLUMN "status" SET DEFAULT 'published';--> statement-breakpoint
DELETE FROM "skill_versions" v USING "skills" s WHERE v."skill_id" = s."id" AND v."version" <> s."latest_version";--> statement-breakpoint
UPDATE "skill_installations" SET "pinned_version" = NULL WHERE "pinned_version" IS NOT NULL;
