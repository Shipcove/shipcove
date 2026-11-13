# Plan d'implémentation

Source de vérité : `SPEC.md` (v1.2). Décisions structurantes : `docs/adr/`.
Légende : ☐ à faire · ◐ en cours · ☑ fait et testé · ⚠ partiel (voir « Limites »).

## Exigences complémentaires du product owner

- **PO-1 (2026-11-13)** — Dans l'écran workspace, un **panneau latéral droit « Modifications »**
  liste les fichiers modifiés par l'IA (ajoutés / modifiés / supprimés, avec compteurs +/−),
  propose une recherche de fichiers et affiche pour chaque fichier un **diff de type git**
  (unifié ou côte à côte, Monaco DiffEditor), avec bascule vers la vue du fichier complet.
  Portées : « depuis le début de la conversation », « dernier run » et « Git (vs HEAD) ».

## Lot 1 — Socle
- ☐ Monorepo pnpm, TS 6, ESM, scripts racine, lint, tests
- ☐ `contracts` (Zod), `database` (Drizzle + migrations), `server-core`
- ☐ Infra dev Compose : PostgreSQL, Vault (serveur), Garage, LiteLLM, Mailpit
- ☐ API : IAM locale (inscription, vérification email, login, sessions, CSRF, reset, MFA TOTP)
- ☐ Équipes, membres, rôles, projets, permissions côté API, audit

## Lot 2 — Moteur
- ☐ Image sandbox officielle (Pi 0.73.1, git, gh, glab, python, uv, node 26, npm)
- ☐ `SandboxProvider` Docker (+ Kubernetes)
- ☐ `PiAgentRuntime` (RPC JSONL), extension platform-bridge
- ☐ Worker : orchestrateur de runs, lease + fencing, idle reaper
- ☐ Gateway : proxy LLM + réservation crédits, egress proxy filtrant
- ☐ SSE persistant (`agent_events`, Last-Event-ID, LISTEN/NOTIFY)
- ☐ Checkpoints S3 incrémentaux + restauration

## Lot 3 — Produit utilisateur
- ☐ Projets Git / vierges, workspaces multiples, conversation unique
- ☐ UI Angular : layout, conversation, outils repliables, explorateur, éditeur Monaco (RO par défaut)
- ☐ PO-1 panneau Modifications / diff
- ☐ Pièces jointes, consommation

## Lot 4 — Contrôles
- ☐ Ledger, coefficients versionnés, fenêtres 5 h / 7 j, plafonds équipe, exemptions
- ☐ Git Broker, approbations, GitHub / GitLab (PR/MR, CI)

## Lot 5 — Entreprise
- ☐ OIDC/Keycloak, SAML, LDAP, OAuth GitHub/GitLab
- ☐ Skills, MCP (3 portées), previews, notifications + emails, partage nominatif

## Lot 6 — Administration & production
- ☐ Console admin complète, rétention/purge, audit/export
- ☐ Observabilité (logs JSON, OpenTelemetry, métriques), sauvegarde/restauration
- ☐ Helm chart, Compose production, tests sécurité/résilience/charge

## Journal
- 2026-11-13 : cadrage, ADR 0001–0011.
