-- Invariants renforcés au niveau base de données.

-- 1. Ledger de crédits immuable : aucun UPDATE ; DELETE uniquement lors d'une purge de rétention
--    explicitement autorisée dans la transaction (SET LOCAL cap.allow_ledger_purge = 'on').
CREATE OR REPLACE FUNCTION cap_credit_ledger_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'credit_ledger est immuable (UPDATE interdit)' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' AND coalesce(current_setting('cap.allow_ledger_purge', true), 'off') <> 'on' THEN
    RAISE EXCEPTION 'credit_ledger est immuable (DELETE hors purge de rétention interdit)' USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER credit_ledger_immutable
  BEFORE UPDATE OR DELETE ON credit_ledger
  FOR EACH ROW EXECUTE FUNCTION cap_credit_ledger_immutable();
--> statement-breakpoint

-- 2. Approbations Git : transitions contrôlées, usage unique, décision immuable.
CREATE OR REPLACE FUNCTION cap_git_approval_transitions() RETURNS trigger AS $$
BEGIN
  IF OLD.status = NEW.status THEN
    -- Les champs liant l'action ne peuvent jamais changer.
    IF OLD.action_digest <> NEW.action_digest OR OLD.commit_sha IS DISTINCT FROM NEW.commit_sha THEN
      RAISE EXCEPTION 'approbation : action liée non modifiable' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT (
       (OLD.status = 'pending'  AND NEW.status IN ('approved', 'rejected', 'expired'))
    OR (OLD.status = 'approved' AND NEW.status IN ('consumed', 'expired'))
  ) THEN
    RAISE EXCEPTION 'approbation : transition % -> % interdite', OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  IF OLD.action_digest <> NEW.action_digest OR OLD.commit_sha IS DISTINCT FROM NEW.commit_sha THEN
    RAISE EXCEPTION 'approbation : action liée non modifiable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER git_approval_transitions
  BEFORE UPDATE ON git_approval_requests
  FOR EACH ROW EXECUTE FUNCTION cap_git_approval_transitions();
--> statement-breakpoint

-- 3. Coefficients de modèle immuables (nouvelle version = nouvelle ligne).
CREATE OR REPLACE FUNCTION cap_model_coefficients_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'model_coefficients est versionné et immuable' USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER model_coefficients_immutable
  BEFORE UPDATE ON model_coefficients
  FOR EACH ROW EXECUTE FUNCTION cap_model_coefficients_immutable();
