-- Quotas personnels uniquement : les plafonds d'équipe ne s'appliquent plus. Les politiques
-- d'équipe sont désactivées (conservées pour l'historique), et ne peuvent plus être créées.
UPDATE "quota_policies" SET "active" = false WHERE "scope" = 'team' AND "active" = true;--> statement-breakpoint
ALTER TABLE "quota_policies" ADD CONSTRAINT "quota_policies_personal_only" CHECK ("active" = false OR "scope" IN ('global_user_default', 'user'));
