# Plan d'implémentation

Source de vérité : `SPEC.md` (v1.2). Décisions structurantes : `docs/adr/` (0001–0012).
Légende : ☐ à faire · ◐ en cours · ☑ fait et testé · ⚠ partiel (voir « Limites »).

## Exigences complémentaires du product owner

- **PO-1 (2026-11-13)** — Panneau latéral droit « Modifications » : fichiers modifiés par l'IA
  (ajoutés / modifiés / supprimés, compteurs +/−), recherche, diff de type git (Monaco
  DiffEditor), bascule vers le fichier complet ; portées « conversation », « dernier run », « Git ».
- **PO-2 (2026-11-13)** — Explorateur de fichiers à droite (onglets, numéros de ligne,
  recherche / arborescence), exclusif avec le panneau latéral.
- **PO-3 (2026-11-14)** — Zone de saisie façon Claude Code : menu « + » (fichiers, commandes
  slash, connecteurs), modèle, effort, mode (Autonome / Plan), anneau de consommation.
  Messages envoyés pendant une génération mis en file d'attente ; pas de dictée vocale.
- **PO-4 (2026-11-14)** — Quotas côté utilisateur **en pourcentage uniquement** (orange ≥ 70 %,
  rouge ≥ 90 %) ; ni crédits ni tokens visibles ni renvoyés par l'API utilisateur.

## Lot 1 — Socle
- ☑ Monorepo pnpm, TS 6, ESM, scripts racine, lint, tests
- ☑ `contracts` (Zod), `database` (Drizzle + migrations), `server-core`
- ☑ Infra Compose : PostgreSQL, Vault (serveur, AppRole), Garage, LiteLLM, Mailpit
- ☑ IAM locale : inscription, vérification email, login, sessions, CSRF, reset, MFA TOTP + codes
- ☑ Équipes, membres, rôles, projets, permissions côté API, audit

## Lot 2 — Moteur
- ☑ Image sandbox (Pi 0.73.1, git, gh, glab, python, uv, node 26, npm)
- ☑ `SandboxProvider` Docker · ⚠ Kubernetes (implémenté, non validé sur cluster)
- ☑ `PiAgentRuntime` (RPC JSONL), extension platform-bridge, mode Plan, effort
- ☑ Worker : orchestrateur de runs, lease + fencing, file d'attente durable des messages
- ☑ Gateway : proxy LLM + réservation de crédits, egress proxy filtrant (forges refusées)
- ☑ SSE persistant (`agent_events`, Last-Event-ID, LISTEN/NOTIFY)
- ☑ Checkpoints S3 incrémentaux + restauration fidèle après destruction de sandbox

## Lot 3 — Produit utilisateur
- ☑ Projets Git / vierges, workspaces multiples, conversation unique
- ☑ UI Angular : conversation, outils repliables, explorateur, Monaco, PO-1 à PO-4
- ☑ Pièces jointes, consommation (pourcentages)

## Lot 4 — Contrôles
- ☑ Ledger, coefficients versionnés, fenêtres 5 h / 7 j, plafonds équipe, exemptions, pause/reprise
- ☑ Git Broker, approbations, GitHub / GitLab (PR/MR)

## Lot 5 — Entreprise
- ☑ OIDC/Keycloak, SAML 2.0, LDAP/AD (testés contre Keycloak et OpenLDAP réels) ·
  ⚠ OAuth GitHub/GitLab (tests unitaires ; pas d'instance de test)
- ☑ Skills, MCP (3 portées), previews, notifications + emails, partage nominatif

## Lot 6 — Administration & production
- ☑ Console admin, rétention/purge, audit + export
- ◐ Observabilité : logs JSON + correlation IDs + health/readiness ☑ ; métriques / OpenTelemetry ☐
- ☐ Sauvegarde / restauration documentées et outillées
- ☐ Helm chart + manifestes Kubernetes ; tests résilience / charge

## Tests
- `tests/e2e` (`pnpm test`, pile Compose réelle) : pile (8), interface Playwright (1), SSO (7).
- Unitaires / intégration : `apps/api`, `apps/gateway`, `packages/server-core`, `packages/agent-runtime`, `packages/secrets`.

## Limites connues
- Pas de déconnexion unique (SLO SAML / logout OIDC), ni de mappage groupes → rôles, ni SCIM.
- Provider Kubernetes et chart Helm non validés sur un cluster de référence.

## Journal
- 2026-11-13 : cadrage, ADR 0001–0011 ; socle, moteur, produit, contrôles ; pile Compose + e2e.
- 2026-11-14 : PO-2/3/4, file d'attente durable, quotas en %, fédération d'identité (ADR 0012).
