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
- ☑ Retour en arrière des fichiers (« Revenir avant ce message », annulable)
- ☑ Environnement par projet : variables et secrets (équipe / projet, Vault, masquage y compris
  vers le LLM), script de préparation, image de sandbox (docs/operations/project-environment.md)
- ☑ Services lancés par l'agent à la demande (catalogue administrateur : PostgreSQL, Redis, RabbitMQ…),
  sur localhost de la sandbox, isolés (docs/operations/services.md) · ⚠ Docker uniquement

## Lot 4 — Contrôles
- ☑ Ledger, coefficients versionnés, fenêtres 5 h / 7 j, plafonds équipe, exemptions, pause/reprise
- ☑ Git Broker, approbations, GitHub / GitLab (PR/MR)
- ☑ PO-5 (2026-11-14) : comptes Git rattachés par OAuth via des forges configurées par l'administrateur
  (PKCE, renouvellement verrouillé des jetons) ; jetons personnels désactivés par défaut

## Lot 5 — Entreprise
- ☑ OIDC/Keycloak, SAML 2.0, LDAP/AD (testés contre Keycloak et OpenLDAP réels) ·
  ⚠ OAuth GitHub/GitLab (tests unitaires ; pas d'instance de test)
- ☑ Skills, MCP (3 portées), previews, notifications + emails, partage nominatif

## Lot 6 — Administration & production
- ☑ Console admin, rétention/purge, audit + export
- ☑ Résilience : pannes API, worker, S3, LiteLLM, Vault testées de bout en bout
- ◐ Observabilité : logs JSON + correlation IDs + health/readiness ☑ ; métriques / OpenTelemetry ☐
- ☐ Sauvegarde / restauration documentées et outillées
- ☐ Helm chart + manifestes Kubernetes ; tests résilience / charge

## Tests
- `tests/e2e` (`pnpm test`, pile Compose réelle, 41 scénarios) :
  - pile (8) et interface Playwright (1) ;
  - SSO contre Keycloak + OpenLDAP (7) ;
  - fonctionnels (13) : services à la demande, retour en arrière, variables et secrets, préparation et image par projet, édition manuelle et conflits, skills, MCP, pièces jointes, notifications
    email, rétention, limite de sandboxes, appels LLM concurrents (plafond, facturation unique),
    utilisateur de plusieurs équipes ;
  - Git contre GitLab CE (7) : forges administrées, rattachement OAuth dans le navigateur,
    renouvellement des jetons sous concurrence, clone, publication et MR après approbation, refus,
    révocation à la suppression d'une forge ;
  - résilience (5) : arrêt brutal de chaque instance API pendant un run (SSE repris sans trou ni
    doublon), perte du worker, pannes S3, LiteLLM et Vault avec reprise automatique.
  Les suites SSO et Git s'ignorent si leurs fournisseurs de test ne sont pas démarrés
  (`pnpm sso:up`, `pnpm forge:up`).
- Unitaires / intégration : `apps/api`, `apps/gateway`, `packages/server-core`, `packages/agent-runtime`, `packages/secrets`.

## Limites connues
- Pas de déconnexion unique (SLO SAML / logout OIDC), ni de mappage groupes → rôles, ni SCIM.
- Provider Kubernetes et chart Helm non validés sur un cluster de référence.

## Journal
- 2026-11-13 : cadrage, ADR 0001–0011 ; socle, moteur, produit, contrôles ; pile Compose + e2e.
- 2026-11-14 : PO-2/3/4, file d'attente durable, quotas en %, fédération d'identité (ADR 0012) ;
  e2e SPEC §25 n°9, 13, 15 et parcours Git complet — 9 défauts corrigés (cache des paramètres
  entre instances, skills révoqués actifs, permissions MCP lisibles par tous, archives non
  inspectées, antivirus en échec ouvert, en-têtes dupliqués, message d'erreur perdu, jeton Git
  présentable à un autre hôte, suppression de compte en collision).
- 2026-11-14 : résilience (SPEC §25 n°6, 16) et critères n°2, n°10 couverts ; fenêtre de quota
  exacte lors d'une suspension (équipe vs personnel), libellés sans crédits ; nginx : répliques API
  résolues à chaque requête et bascule rapide (une instance redémarrée ne recevait plus de trafic,
  et l'arrêt d'une instance provoquait des 502/504).
- 2026-11-14 : PO-5, connexions Git par OAuth administré (docs/operations/git-forges.md).
- 2026-11-14 : retour en arrière, variables / secrets et préparation par projet.
- 2026-11-14 : services d'appui lancés par l'agent ; correctif : les erreurs des outils de la
  plateforme étaient affichées comme des succès (Pi ignore `isError`, seule une exception compte).
- 2026-11-14 : README et site de documentation ; accès autonome aux forges (ADR 0013) : git, gh,
  glab dans la sandbox via la gateway (TLS intercepté, jeton OAuth substitué, garde-fous, audit) ;
  correctif : un refus de push restait sans réponse si la requête s'était terminée pendant la
  lecture des branches protégées.
- 2026-11-14 : sécurité de production — garde Docker (ADR 0014, le worker n'a plus le socket),
  déverrouillage de Vault manual (PGP) / auto (KMS, transit) avec jeton root révoqué, point
  d'entrée TLS Caddy (certificats de preview à la demande validés par la plateforme). Revue
  interne du proxy des forges : 5 contournements corrigés (chemin LFS dans la requête et en-tête
  Host imposé par la sandbox, chemins non canoniques, GraphQL groupé / brut / persisté / GET,
  surcharge de méthode, commentaire entre nom de mutation et arguments).
- 2026-11-15 : renommage Shipcove (marque, images `shipcove-*` ; préfixe interne `cap` conservé) ;
  captures d'écran par Pi (plugin `browser` : Chromium de la sandbox, actions avant capture),
  miniatures et visionneuse dans la conversation ; correctif : « Connection error » intermittent de
  Pi vers la gateway (délai keep-alive du serveur plus court que celui du client).
- 2026-11-15 : interface (blocs de code et sorties d'outils colorés, explorateur sans boucle,
  arrêt d'un run, ouverture des previews et cookie vide dans la passerelle) ; plugin Pi `ask`
  (questions à choix dans la conversation, réponse rattachée à l'appel, mode Plan).
