# Shipcove

> *Build in a safe cove. Ship with confidence.*

Plateforme **auto-hébergeable** de coding agents pour équipes et entreprises.

L'agent [Pi](https://github.com/badlogic/pi-mono) travaille dans une **sandbox éphémère et isolée** :
il lit, modifie et teste le code. Son état est **sauvegardé en continu sur S3**, et les modèles
passent par **LiteLLM**. Les secrets sont dans **Vault**. Pi utilise `git`, `gh` et `glab` en
autonomie, sans jamais voir le jeton de l'utilisateur. Toucher à la branche par défaut, fusionner ou
supprimer exige une **approbation humaine**.

> Documentation complète (démarrage rapide, guides, exploitation) : `pnpm docs:dev`, puis
> <http://localhost:5174>. Le site est dans [`apps/docs-site`](apps/docs-site).

---

## Sommaire

- [Fonctionnalités](#fonctionnalités)
- [Architecture](#architecture)
- [Démarrage rapide](#démarrage-rapide)
- [Configuration](#configuration)
- [Développement](#développement)
- [Tests](#tests)
- [Sécurité](#sécurité)
- [Documentation](#documentation)
- [État du projet et limites](#état-du-projet-et-limites)

## Fonctionnalités

**Pour les développeurs**

- **Workspaces** sur un dépôt Git (GitHub, GitLab, en SaaS ou auto-hébergé) ou vierges, avec une
  conversation par workspace.
- **Conversation avec Pi** :
  - réponses et outils en flux continu ;
  - interruption ;
  - file d'attente des messages envoyés pendant une génération ;
  - choix du modèle et de l'effort de raisonnement ;
  - **mode Plan** (outils en lecture seule).
- **Panneau « Modifications »** : diff de type Git des fichiers modifiés par l'agent (depuis le début
  de la conversation, depuis le dernier run ou par rapport à Git), et explorateur de fichiers avec
  éditeur Monaco.
- **Revenir en arrière** : restaure les fichiers à l'état d'avant un message, à partir des
  checkpoints, et peut s'annuler.
- **Conversations** au centre : l'accueil est une nouvelle conversation, le dépôt Git est
  facultatif (choisi sous la zone de saisie), le titre est généré automatiquement, la barre latérale
  regroupe les conversations par dépôt puis par date.
- **Environnement par dépôt** (partagé par toutes les conversations sur le dépôt) :
  - variables et **secrets** (Vault, masqués partout, y compris vers le LLM) ;
  - **script de préparation** ;
  - **image de sandbox** au choix.
- **Services d'appui à la demande** : l'agent lance lui-même PostgreSQL, Redis, RabbitMQ… sur le
  `localhost` de sa sandbox, parmi un catalogue approuvé par l'administrateur.
- **Git** : comptes rattachés par **OAuth**.
  - Pi pousse ses branches, ouvre des PR/MR, lit la CI et répond aux revues avec `git`, `gh` et
    `glab`.
  - Branche par défaut, branches protégées, fusion et suppression : uniquement après **approbation
    de l'opération exacte** (commit figé).
- **Questions de Pi** : quand une décision vous revient, Pi pose ses questions dans un formulaire
  (choix unique ou multiple, réponse libre), y compris en mode Plan (plugin Pi `ask`).
- **Captures d'écran** : Pi lance le projet et le photographie avec le Chromium de la sandbox
  (plugin Pi `browser`). Les captures s'affichent en miniatures dans la conversation et s'agrandissent
  au clic.
- **Previews** des applications lancées dans la sandbox, sur un domaine distinct et avec jeton.
- **Pièces jointes** :
  - type réel détecté ;
  - archives inspectées sans être extraites ;
  - antivirus ClamAV (si configuré), en échec fermé.
- **Partage** nominatif en lecture seule, révocable.
- **Notifications** dans l'application et par email.
- **Skills** en markdown (dossiers, catégories gérées par les administrateurs, import et export .zip,
  éditeur avec aperçu) et serveurs
  **MCP**, sur deux portées : globale et personnelle.

**Pour les administrateurs**

- **IAM intégrée** : comptes locaux, MFA TOTP, sessions révocables. Également :
  - **OIDC / Keycloak**, **SAML 2.0**, **LDAP / Active Directory** ;
  - **OAuth GitHub / GitLab**, sans jamais fusionner deux comptes par leur email.
- **LiteLLM** : connexion réglable dans l'administration (proxy existant possible), découverte
  automatique des modèles, activation, modèle par défaut, liste blanche d'utilisateurs, coefficients
  versionnés, modèle dédié aux titres automatiques.
- **Quotas personnels** : fenêtres glissantes de 5 h et 7 j, un compteur par personne pour toutes
  ses conversations. Ils sont présentés en **pourcentage** aux utilisateurs, et une réservation est faite
  avant chaque appel.
- **Forges Git** (applications OAuth), **catalogue d'images** et **catalogue de services**.
- **Rétention** des données avec gel légal, **audit** exportable, console d'administration complète.

## Architecture

```
Navigateur ── nginx (web) ──► API NestJS (×N) ──► PostgreSQL (état, files de jobs, LISTEN/NOTIFY)
                                   │                Vault (secrets)   Garage/S3 (checkpoints, pièces jointes)
                                   ▼
                              Worker NestJS ──► sandboxes Docker (Pi en RPC, réseau interne isolé)
                                   │                     │  services d'appui (localhost de la sandbox)
                                   ▼                     ▼
                         Gateway (proxy LLM, egress filtré, lecture Git) ──► LiteLLM ──► fournisseurs
                         Preview gateway (domaine distinct) ──► ports des sandboxes
```

| Composant | Rôle |
|---|---|
| `apps/web` | Interface Angular 22 (signals, zoneless) et Tailwind CSS 4, servie par nginx (CSP stricte). |
| `apps/api` | API REST `/api/v1` (NestJS 12, OpenAPI), authentification, flux SSE, administration. |
| `apps/worker` | Orchestration des runs Pi, sandboxes, checkpoints, broker Git, tâches de maintenance. |
| `apps/gateway` | Proxy LLM (réservation et facturation des crédits), proxy de sortie filtré, lecture Git pour les sandboxes. |
| `apps/preview` | Accès aux ports des sandboxes sur un domaine séparé, avec jeton. |
| `packages/*` | Contrats Zod partagés, schéma Drizzle, sandbox (Docker / Kubernetes), stockage des checkpoints, secrets (Vault), runtime Pi, image de sandbox. |

Les décisions structurantes sont décrites dans [`docs/adr`](docs/adr) (ADR 0001 à 0015), et le
cahier des charges dans [`SPEC.md`](SPEC.md).

## Démarrage rapide

**Prérequis** :
- Docker 24 ou plus, avec Compose v2 ;
- `git` et `openssl` ;
- 4 cœurs, 8 Go de RAM et 30 Go de disque au minimum.

Les images sont publiées sur `ghcr.io/shipcove` (`shipcove-web`, `shipcove-api`, `shipcove-worker`,
`shipcove-gateway`, `shipcove-preview`, `shipcove-docker-guard`, `shipcove-sandbox`).
Elles sont construites par la CI GitHub Actions (`.github/workflows/ci.yml`) :
branche `develop` → étiquettes `develop` et `sha-<commit>` ; tag `vX.Y.Z` → `X.Y.Z` et
`X.Y`. Les pull requests construisent les images sans les publier.

```bash
# 1. Récupération de la pile Compose
git clone https://github.com/Shipcove/shipcove.git
cd shipcove/infrastructure/docker

# 2. Configuration (aucun secret dans ce fichier)
cp .env.example .env
#    → CAP_REGISTRY=ghcr.io/shipcove/
#    → CAP_VERSION=0.1.0
#    → CAP_SANDBOX_IMAGE=ghcr.io/shipcove/shipcove-sandbox:0.1.0
#    → CAP_ADMIN_PASSWORD : mot de passe de l'administrateur initial
#    → CAP_DOCKER_GID     : groupe du socket Docker (stat -c %g /var/run/docker.sock)

# 3. Secrets d'amorçage (générés localement dans .secrets/, jamais versionnés)
./scripts/init-secrets.sh

# 4. Images de la plateforme et de la sandbox
docker compose pull
docker pull ghcr.io/shipcove/shipcove-sandbox:0.1.0

# 5. Démarrage (le profil « dev » ajoute Mailpit et un fournisseur LLM factice)
docker compose --profile dev up -d
```

**Depuis les sources** : avec Node.js 26 et pnpm 12.18, `pnpm install && pnpm images:build`
construit les images localement (laisser `CAP_REGISTRY` vide et `CAP_SANDBOX_IMAGE=shipcove-sandbox:0.1.0`).

Ouvrez <http://localhost:8080> et connectez-vous avec `CAP_ADMIN_EMAIL` / `CAP_ADMIN_PASSWORD`. La
MFA (TOTP) est demandée aux administrateurs dès la première connexion. Ensuite :

1. **Modèles** : déclarez vos modèles dans LiteLLM (interface <http://localhost:4000/ui>, clé maître
   dans `.secrets/litellm_master_key`), ou branchez un proxy LiteLLM existant dans
   **Administration → Modèles → Connexion à LiteLLM**. Cliquez sur **Recharger les modèles**, puis
   activez-en un et choisissez le modèle par défaut. Pour essayer sans fournisseur :
   `openai/mock-model` avec `api_base` = `http://mock-llm:4010/v1` (profil `dev`).
2. **Invitations** : invitez vos collègues par email, ou créez leurs comptes dans **Utilisateurs**.
3. **Accueil** : écrivez votre demande à Pi. Pour travailler sur un dépôt, configurez une forge dans
   **Administration → Forges Git**, rattachez votre compte (**Paramètres → Git**), puis choisissez
   le dépôt sous la zone de saisie.

Mailpit, qui reçoit les emails en développement, est accessible sur <http://localhost:8025>.

## Configuration

| Où | Quoi |
|---|---|
| `infrastructure/docker/.env` | URL publique, ports, domaine des previews, image de sandbox, nombre de répliques API, administrateur initial. |
| `infrastructure/docker/.secrets/` | Secrets d'amorçage (PostgreSQL, Garage, LiteLLM, AppRole Vault), générés par `init-secrets.sh`. |
| **Vault** (`cap/…`) | Secrets applicatifs : clés LLM, SMTP, OAuth, MCP, secrets de dépôt, jetons Git… |
| **Console d'administration** | Tout le reste : connexion et MFA, fournisseurs d'identité, forges Git, modèles, quotas, sandboxes, images, services, skills et MCP, notifications, rétention. |

**Avant une exposition sur un réseau** :
- placez la plateforme derrière TLS et mettez `CAP_COOKIE_SECURE=true` ;
- protégez `.secrets/`, qui contient les clés de déverrouillage de Vault.

Les points à traiter pour la production sont listés dans
[État du projet et limites](#état-du-projet-et-limites).

## Développement

```bash
pnpm dev:infra          # PostgreSQL, Vault, Garage, LiteLLM, Mailpit, LLM factice
pnpm build              # tous les paquets
pnpm typecheck && pnpm lint
pnpm db:generate        # migration Drizzle après modification du schéma
pnpm docs:dev           # site de documentation
```

Le monorepo pnpm est en TypeScript 6 (ESM). Les contrats de l'API sont partagés entre le front et le
back (`@cap/contracts`, Zod 4).

**Politique de dépendances** : seules les versions publiées depuis plus de deux semaines sont
acceptées (`minimumReleaseAge`). Les scripts d'installation sont refusés par défaut (`allowBuilds`).

## Tests

```bash
pnpm test                       # unitaires / intégration (Vitest)
cd tests/e2e && pnpm test       # bout en bout sur la pile Compose réelle (profil dev)
```

La suite de bout en bout compte 41 scénarios :
- pile ;
- interface (Playwright, CSP stricte) ;
- fonctionnels ;
- Git contre un vrai GitLab ;
- SSO contre un vrai Keycloak et un vrai OpenLDAP ;
- résilience : arrêt d'une API, perte du worker, pannes de S3, LiteLLM et Vault.

Fournisseurs de test optionnels :
- `pnpm sso:up` (Keycloak + OpenLDAP) ;
- `pnpm forge:up` (GitLab CE).

Sans eux, les suites concernées s'ignorent.

## Sécurité

- **Sandboxes** :
  - utilisateur non privilégié, `cap-drop ALL`, `no-new-privileges` ;
  - limites de CPU, mémoire et processus ;
  - réseau interne sans route vers Internet ni vers le backend ;
  - sortie uniquement par un proxy à liste blanche.
- **Aucun jeton de forge dans la sandbox** :
  - `git`, `gh` et `glab` présentent un jeton de run. La gateway intercepte le TLS des seules forges
    et le remplace par le jeton OAuth ;
  - garde-fous : pas de push sur la branche par défaut ni sur une branche protégée, pas de fusion,
    de suppression, de réglage du dépôt, ni de clé ou de jeton durable (approbation requise) ;
  - écritures et refus audités.
- **Secrets** :
  - dans Vault, jamais renvoyés par l'API ;
  - masqués dans les sorties, le flux temps réel, la base et les requêtes envoyées au fournisseur LLM.
- **Hôte** :
  - seul le garde Docker (`docker-guard`, ADR 0014) détient le socket. Il n'accepte que des
    sandboxes et services durcis, jamais de conteneur privilégié ni de montage de l'hôte ;
  - Vault est déverrouillé par un service de clés ou par des clés réparties entre opérateurs
    (chiffrées PGP), et le jeton root est révoqué après l'amorçage (`docs/operations/vault.md`) ;
  - TLS automatique avec le profil `tls` (`docs/operations/tls.md`).
- **Navigateur** :
  - sessions serveur, cookies `HttpOnly`, CSRF par double soumission ;
  - CSP stricte sans script inline ;
  - previews sur un domaine distinct.
- **Confidentialité** : une conversation n'est lisible que par son propriétaire et les personnes avec
  qui il l'a partagée nommément, administrateurs compris.

## Documentation

- **Site de documentation** : [`apps/docs-site`](apps/docs-site) (`pnpm docs:dev`).
- **Guides d'exploitation** : [`docs/operations`](docs/operations)
  - Docker Compose ;
  - SSO ;
  - forges Git ;
  - environnement des dépôts ;
  - services.
- **Décisions d'architecture** : [`docs/adr`](docs/adr).
- **Avancement** : [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md).

## État du projet et limites

Le périmètre fonctionnel du cahier des charges est implémenté et testé de bout en bout sur Docker
Compose. Restent à faire **avant une mise en production** :

- **Chiffrement du trafic interne** pour un déploiement multi-hôte (TLS de PostgreSQL et de Vault).
  Le point d'entrée TLS public est fourni (profil `tls`).
- **Sauvegarde et restauration** outillées : PostgreSQL, Vault, S3.
- **Observabilité** : métriques, OpenTelemetry, alertes.
- **Chart Helm** et provider Kubernetes validés sur un cluster (les services d'appui y sont encore
  indisponibles).
- **Images de sandbox** : registre interne, vérification de conformité, caches de dépendances.
- **CI**, tests de charge, audit de sécurité externe (une revue interne a été faite, voir le journal
  d'`IMPLEMENTATION_PLAN.md`).
