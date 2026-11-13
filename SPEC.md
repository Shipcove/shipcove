# Coding Agent Platform — Cahier des charges

**Version : 1.2 — Spécification consolidée**  
**Destinataire : agent IA de développement autonome**  
**Produit : plateforme web de coding agents pour équipes et entreprises**  
**Statut : exigences fonctionnelles validées ; choix d'implémentation complémentaires confiés à l'IA**

## 1. Mission et règles d'exécution

Développer, tester, documenter et livrer une plateforme web auto-hébergeable offrant une expérience de coding agent comparable, dans ses usages, à Claude Code. La plateforme doit utiliser **Pi** comme harness agentique et **LiteLLM** comme passerelle vers les modèles. Elle est conçue pour les équipes et entreprises, avec une administration centralisée, des workspaces individuels, des projets d'équipe, des environnements d'exécution isolés et une API réplicable.

Le présent document est la **source de vérité**. L'IA de développement prend de façon autonome les décisions d'implémentation non tranchées : bibliothèques, structure précise des modules, stratégie de tests, index, schémas internes, ergonomie et configurations par défaut. Documenter les décisions structurantes dans `docs/adr/` et maintenir un plan d'implémentation dans `IMPLEMENTATION_PLAN.md`. Ne demander une clarification que si plusieurs interprétations incompatibles empêchent effectivement de respecter le cahier des charges.

En cas de conflit, privilégier dans cet ordre : sécurité et isolation ; intégrité et confidentialité des données ; exigences explicites ; maintien de la compatibilité ; simplicité et maintenabilité. Ne jamais supprimer silencieusement une fonctionnalité. Ne pas présenter comme terminés des mocks, écrans factices ou intégrations non opérationnelles. Vérifier la documentation officielle des dépendances et leurs compatibilités avant de les installer. Les versions stables retenues doivent être verrouillées et reproductibles.

## 2. Stack technique obligatoire

| Domaine | Exigence |
| --- | --- |
| Frontend | **Angular**, dernière version stable compatible au début du développement |
| Styles | **Tailwind CSS**, dernière version stable compatible |
| Backend métier | **NestJS**, dernière version stable compatible |
| Langage | **TypeScript** sur frontend, backend et packages partagés |
| Gestionnaire JS/TS | **pnpm exclusivement**, avec **pnpm workspaces** |
| Runtime | **Node.js dernière branche LTS** compatible avec Angular, NestJS, Pi et pnpm |
| Harness | **Pi** et ses interfaces officielles d'intégration |
| Passerelle LLM | **LiteLLM** pour tous les appels LLM de Pi |
| Base de données | **PostgreSQL** |
| Secrets | **HashiCorp Vault** comme première implémentation officielle, obligatoire |
| Persistance des workspaces | **Stockage objet compatible S3**, restauration au démarrage |
| Déploiement | **Docker Compose et Kubernetes** officiellement supportés |

**Interdictions de stack :** ne pas utiliser React ou Next.js pour le frontend applicatif ; ne pas remplacer NestJS par un autre framework backend ; ne pas utiliser npm ou Yarn pour gérer les dépendances du monorepo. L'image sandbox contient toutefois npm pour que **les projets des utilisateurs** puissent exécuter des commandes npm. Cette présence n'autorise pas npm comme gestionnaire du monorepo de la plateforme.

Privilégier Angular standalone components, Angular Router, Signals lorsque adaptés, HttpClient pour les flux. Choisir un éditeur de code compatible Angular, de préférence Monaco. Utiliser Tailwind CSS pour l'interface utilisateur et l'administration. Côté NestJS, utiliser modules, injection de dépendances, guards, validation des DTO, gestion commune des erreurs, OpenAPI et traitements asynchrones..

### 2.1 Monorepo pnpm

Le dépôt doit posséder **un seul `pnpm-lock.yaml`** et un `pnpm-workspace.yaml` à la racine. Définir `packageManager` avec une version exacte de pnpm dans le `package.json` racine ; utiliser Corepack ou une méthode équivalente de provisionnement. Les packages internes utilisent `workspace:`. Les commandes CI utilisent `pnpm install --frozen-lockfile`.

Structure indicative (modifiable si justifié dans un ADR) :

```text
coding-agent-platform/
├── apps/
│   ├── web/                # Angular + Tailwind CSS
│   ├── api/                # NestJS API
│   └── worker/             # Workers NestJS
├── packages/
│   ├── contracts/          # Schémas et types partageables
│   ├── database/           # PostgreSQL et migrations
│   ├── agent-runtime/      # Adaptateur Pi
│   ├── sandbox/            # SandboxProvider
│   └── shared/
├── infrastructure/
│   ├── docker/
│   ├── kubernetes/
│   └── helm/
├── docs/adr/
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── package.json
├── tsconfig.base.json
├── IMPLEMENTATION_PLAN.md
└── SPECIFICATIONS.md
```

Configurer les scripts racine et les noms de packages pour que les commandes `pnpm install`, `pnpm -r build`, `pnpm -r test`, `pnpm -r lint`, `pnpm --filter web dev`, `pnpm --filter api dev` et `pnpm --filter worker dev` fonctionnent réellement ou disposent d'équivalents documentés. Isoler les dépendances de production dans les images. Les packages partagés ne doivent pas coupler Angular et NestJS à leurs environnements d'exécution respectifs.

## 3. Architecture et disponibilité

La plateforme doit accepter **plusieurs instances de l'API NestJS derrière un load balancer**. Les requêtes d'un même utilisateur peuvent atteindre des instances différentes sans perdre de session, de conversation, de quota ou d'état agentique. L'API est stateless autant que possible ; les états durables vivent dans les services partagés.

Définir les responsabilités logiques suivantes, sans imposer un microservice distinct pour chacune : IAM, équipes et permissions, projets, workspaces, orchestrateur, runtime Pi, modèles LiteLLM, quotas, checkpoints, Git Broker, approbations, skills, MCP, notifications, previews, administration, audit. Privilégier un backend NestJS modulaire avec workers déployés séparément, plutôt que des microservices artificiels.

Les tâches asynchrones, retries et verrous doivent être coordonnés entre instances. PostgreSQL reste source de vérité pour les états critiques. Redis peut servir à la coordination, aux files et aux caches, mais pas comme seule source des crédits, sessions ou checkpoints. Utiliser idempotence, lease avec fencing token, outbox transactionnelle lorsque nécessaire et suivi des opérations longues. Une reconnexion ne doit pas doubler une exécution.

### 3.1 Docker Compose

Fournir un déploiement officiel **non haute disponibilité**, complet et documenté : application Angular, API NestJS, workers, LiteLLM, PostgreSQL, Redis ou équivalent retenu, Vault, stockage objet compatible S3, Preview Gateway et services de support nécessaires. Prévoir persistance, initialisation, procédures de sauvegarde/restauration, configuration de sécurité et contrôles de santé. Ne pas présenter un Vault en mode développement comme un déploiement de production.

### 3.2 Kubernetes

Fournir un chart Helm officiel avec API et workers réplicables, policies réseau et de ressources, secrets et configurations externalisables, ingress, probes et migrations contrôlées. **Kubernetes doit être compatible HA** lorsque PostgreSQL, Redis, S3, Vault et les services centraux sont déployés de façon redondante ou fournis comme services externes. Ne pas promettre de HA automatique en l'absence de ces conditions.

## 4. Identités, authentification et emails

La plateforme possède une **IAM intégrée**, utilisable sans Keycloak. Keycloak est un fournisseur externe facultatif. L'administration doit permettre d'activer, désactiver, configurer et tester les mécanismes suivants :

- Connexion locale par login/email et mot de passe.
- OIDC/SSO, dont Keycloak.
- SAML 2.0.
- LDAP et Active Directory via LDAP.
- OAuth GitHub.
- OAuth GitLab.com et GitLab self-hosted.

Prévoir inscription activable/désactivable, vérification d'email, invitations, récupération de mot de passe, réinitialisation, changement de mot de passe, suspension/suppression de compte, sessions et révocation, protection contre la force brute, cookies/session sécurisés, protection CSRF selon le mode de session et journal d'authentification.

Implémenter **2FA/MFA** avec TOTP et codes de récupération, politiques administratives et processus sûr de récupération de compte. Prévoir une architecture compatible WebAuthn/passkeys. Respecter les politiques MFA des fournisseurs fédérés. Utiliser Argon2id ou équivalent éprouvé pour les mots de passe locaux.

Configurer SMTP dans l'administration avec tests et templates d'emails : inscription, vérification, invitation, réinitialisation, alertes de sécurité et notifications. Envoyer les emails de manière asynchrone avec gestion des retries et des erreurs.

### 4.1 Identité de connexion ≠ connexion Git

Un compte utilisateur interne stable peut être authentifié via n'importe quel fournisseur et rattacher **plusieurs comptes GitHub ou GitLab** pour retrouver ses dépôts. Rattachement/détachement, consentement, renouvellement et révocation sont gérés indépendamment de la méthode de login. Ne jamais fusionner automatiquement des utilisateurs sur simple égalité d'adresse email. Conserver les credentials Git via Vault ou un broker, jamais dans le frontend.

## 5. Équipes, rôles et confidentialité

La plateforme sert aux **équipes internes et entreprises**. Un utilisateur peut appartenir à plusieurs équipes ; une équipe possède plusieurs projets. Prévoir au minimum : administrateur plateforme, administrateur d'équipe, membre. Les droits de projet et d'administration doivent être vérifiés côté API, pas seulement dans les composants Angular.

Les **projets sont partagés** au sein de leur équipe, mais les **workspaces sont individuels**. Chaque personne possède ses fichiers et sa conversation ; le partage du code s'effectue par Git, et non par montage d'un même dossier entre utilisateurs.

Les **conversations sont privées par défaut**, y compris vis-à-vis de l'administrateur d'équipe. Le propriétaire peut partager **en lecture seule** sa conversation avec des **membres nommément identifiés de l'équipe**, au moyen d'une autorisation révocable. Le destinataire ne peut pas lancer Pi, modifier le workspace, approuver des opérations Git ni transférer le partage. Vérifier l'appartenance à l'équipe à chaque accès ; son retrait révoque l'accès effectif. Éviter toute exposition involontaire de pièces jointes, secrets, sorties d'outils ou URLs signées.

## 6. Projets, workspaces et conversations

L'utilisateur peut créer un projet lié à un dépôt Git ou un **projet vierge sans dépôt**. Un dépôt peut être ajouté ultérieurement. Il peut créer plusieurs workspaces personnels sur un même projet.

**Un workspace possède une seule conversation fonctionnelle**, composée de plusieurs messages et de plusieurs runs successifs. Une seule exécution Pi peut être active à la fois par workspace. Pour démarrer un contexte indépendant, créer un autre workspace. Les conversations persistent après fermeture du navigateur ou destruction de la sandbox.

Gérer création, démarrage, mise en veille logique, restauration, archivage et suppression du workspace. Ses fichiers et son état Git sont propres à son propriétaire. Lier les consommations de crédits à **l'équipe propriétaire du projet**, même si l'utilisateur appartient à plusieurs équipes.

## 7. Harness Pi et exécution agentique

**Pi est le harness obligatoire.** L'intégrer via SDK, RPC ou API officielle adaptée ; éviter un fork sans nécessité démontrée. Isoler un adaptateur `PiAgentRuntime` des contrats publics de l'application. Pi doit pouvoir explorer, lire, créer, modifier, déplacer et supprimer des fichiers, exécuter des commandes, installer des dépendances, lancer des tests, utiliser Git, des skills et des MCP, et démarrer des serveurs de développement.

**Pi est autonome par défaut dans les limites de sa sandbox.** Les actions locales ordinaires ne nécessitent pas d'approbation. Les contrôles d'infrastructure et les approbations Git restent obligatoires ; ils ne peuvent pas dépendre uniquement d'un prompt ou d'un hook Pi.

Prévoir streaming des réponses/outils, interruption, gestion des erreurs, changement de modèle, contexte et compaction, support des fichiers `AGENTS.md`, sauvegarde de l'état de session et reprise après sandbox éphémère. Chaque appel outil est visible dans l'historique avec son statut, sorties, durée et fichiers touchés.

**Pas de terminal interactif direct pour l'utilisateur.** L'utilisateur voit les commandes et leurs sorties **uniquement via Pi**. Aucun endpoint générique d'exécution shell ne doit être accessible aux utilisateurs ; les API internes d'orchestration sont séparées et protégées.

## 8. LiteLLM, sélection des modèles et consommation

**Tous les appels LLM de Pi passent par LiteLLM.** Les administrateurs configurent les providers, modèles, permissions, capacités, limites, disponibilités et modèle par défaut. Chaque utilisateur peut choisir parmi les modèles autorisés ; les changements de modèle doivent être gérés proprement par la session.

Afficher au minimum : tokens d'entrée, de sortie, de cache lu et de cache écrit lorsque disponibles, consommation par requête, conversation, modèle, fenêtre de contexte, crédits consommés et crédits disponibles. Distinguer clairement **taille de contexte**, **consommation de tokens**, **coût provider** et **quotas internes**. Gérer timeouts, erreurs, streaming, retries contrôlés et données de consommation manquantes ou différées.

## 9. Quotas en crédits pondérés

Les quotas sont des **crédits internes**, avec coefficients **distincts par modèle** pour entrée, sortie, cache lu et cache écrit. Versionner les coefficients ; les nouvelles valeurs ne modifient pas les consommations passées. La formule doit éviter le double comptage des tokens cache. Définir explicitement l'unité des coefficients (par token ou par millier de tokens) et utiliser des décimaux exacts.

Appliquer simultanément :

- **5 heures glissantes**.
- **7 jours glissants**.

Prévoir plafonds globaux par défaut, quotas individuels, plafonds d'équipe **optionnels**, exemptions individuelles, désactivation globale, modification des seuils, ajustements administratifs et consultation historique. L'utilisateur et l'équipe propriétaire du projet sont débités de façon cohérente.

Avant **chaque appel LLM**, réserver atomiquement un montant estimé en tenant compte des appels concurrents sur toutes les instances. À réception de l'usage, régulariser et libérer les excédents. Conserver un **ledger durable et idempotent** dans PostgreSQL ; Redis ne peut être qu'une optimisation. Réconcilier les usages inconnus ou incomplets sans inventer de consommation.

**Quota atteint :** terminer l'appel LLM déjà engagé, puis **suspendre proprement l'agent avant le prochain appel LLM**. Conserver le contexte et permettre la reprise lorsque les deux fenêtres et les éventuels plafonds d'équipe le permettent. Ne pas répéter automatiquement une action externe ambiguë.

Les limites de crédits sont distinctes des quotas CPU/RAM/disque et du nombre de sandboxes.

## 10. Sandboxes et images officielles

Chaque workspace actif possède une sandbox isolée. Implémenter une abstraction interchangeable `SandboxProvider`, avec **conteneurs au départ** (Docker et Kubernetes) et possibilité de **microVM plus tard**, sans imposer leur implémentation en v1.

Fournir une **image officielle versionnée**, contenant Pi, Git, `gh`, `glab`, Bash, Python, pip, uv, Node.js **dernière branche LTS compatible**, npm et utilitaires essentiels. Les projets utilisateurs peuvent installer leurs propres dépendances. Les images officielles sont maintenues centralement, verrouillées par digest, vérifiées, testées et mises à jour de manière contrôlée. **Pas d'images personnalisées par équipe dans la v1.**

Durcir l'exécution : utilisateur non privilégié, limites CPU/RAM/disque/processus, restrictions de capacités Linux, seccomp ou équivalent, restrictions réseau, accès aux services internes interdit par défaut, pas de socket Docker hôte, pas d'accès aux workspaces voisins ni aux secrets des autres utilisateurs.

**Détruire la sandbox après 15 minutes d'inactivité.** Une tâche réellement en cours peut maintenir l'activité, avec durée maximale configurable. Une page web ouverte n'est pas une activité suffisante. Préserver d'abord les données et l'état de Pi ; une erreur de persistance interdit la destruction normale si celle-ci ferait perdre des écritures uniques.

## 11. Stockage objet et checkpoints

Les sandboxes sont **éphémères** ; l'état durable du workspace réside dans un **stockage objet compatible S3**. Au démarrage : prendre un lease exclusif, restaurer le dernier snapshot validé, vérifier son intégrité, restaurer Git et l'état Pi, puis lancer l'agent. Pour un projet neuf : répertoire vierge ou clone du dépôt choisi.

**Effectuer un checkpoint après chaque action d'écriture de Pi**, y compris les modifications déclenchées par une commande shell. Si l'édition manuelle Angular est autorisée, chaque sauvegarde utilisateur déclenche aussi un checkpoint. Une simple observation des outils `write`/`edit` de Pi est insuffisante : prendre en compte les écritures réelles du système de fichiers et garantir un état cohérent.

Utiliser des checkpoints **incrémentaux** lorsque possible, avec objets, manifestes versionnés, checksums, état Git (index et changements non commitées compris), idempotence par événement d'écriture et protection contre les writers périmés via **fencing tokens**. Un manifeste n'est publié comme courant qu'après vérification de ses objets. En cas d'échec, signaler un état non synchronisé et réessayer sans annoncer une sauvegarde réussie.

**Les snapshots sont restaurés automatiquement uniquement.** Ne pas fournir d'interface de navigation/restauration manuelle des anciennes versions. La restauration technique normale au démarrage reste obligatoire, et la reprise après panne utilise le dernier état confirmé. Une opération externe à résultat inconnu ne doit pas être réexécutée sans réconciliation.

## 12. Vault et secret management

Utiliser **HashiCorp Vault** comme première implémentation officielle obligatoire et définir `SecretProvider` pour permettre d'autres systèmes ultérieurement. Protéger notamment les credentials SSO/LDAP, OAuth GitHub/GitLab, LiteLLM/providers, SMTP, MCP et variables sensibles. PostgreSQL conserve les références et métadonnées, pas les secrets en clair.

Utiliser authentification machine/identité de workload adaptée à Compose et Kubernetes, politiques minimales, rotation, révocation, chiffrement et audit. **Ne jamais injecter de tokens permanents donnant à Pi la capacité de contourner une approbation Git.** Préférer un broker et des credentials temporaires. Les secrets ne doivent pas apparaître dans le frontend, les conversations, les logs ou SSE.

## 13. GitHub, GitLab et opérations Git

Supporter GitHub.com, GitHub Enterprise compatible, GitLab.com et GitLab self-hosted. Fournir listing/clonage des dépôts, branches, commits, staging, diff, fetch, pull, push, résolution de conflits, pull requests, merge requests, commentaires et états CI/CD selon les capacités disponibles.

**Approbation obligatoire pour chaque `git push`, création de PR et création de MR.** Une approbation explicite est également requise pour les opérations distantes sensibles/destructrices selon la politique de sécurité, notamment fusion et suppression de branche distante. Chaque approbation est liée à une action exacte, dépôt, cible, refs/contenu, expiration et décideur autorisé ; elle est non réutilisable et auditée. Montrer clairement le diff ou les commits et proposer approuver/refuser.

Implémenter un **Git Credential Broker** et le contrôle réseau adéquat pour empêcher Pi de publier directement via `git`, `gh`, `glab`, Python, Node.js ou HTTP sans approbation. Un hook d'outil ou une détection textuelle des commandes ne constituent pas une garantie suffisante. Réconcilier les résultats distants incertains avant tout retry.

## 14. Skills

Fournir un **catalogue administré** de skills : ajout, validation, publication, activation/désactivation, versionnement, permissions, révocation. Autoriser les **skills personnels** dans les limites fixées par l'administration. Identifier source, version, empreinte, portée, auteur/propriétaire et état. Le chargement doit être compatible avec Pi ; l'installation d'un skill ne doit jamais conférer de privilèges supplémentaires par défaut. Prévoir analyse des sources et restrictions d'exécution appropriées.

## 15. MCP

Gérer les MCP à **trois portées : globale, équipe et personnelle**. Administration des serveurs, transports compatibles (notamment stdio et Streamable HTTP), URL/commande, outils exposés, versions, santé, secrets Vault, activation, permissions **par outil** et héritage. Une politique globale ne peut être contournée par une portée inférieure. Isoler les MCP locaux et contrôler réseau/authentification des MCP distants. Intégrer à Pi via un bridge/extension si Pi n'apporte pas les fonctionnalités nécessaires nativement.

## 16. Interface Angular et UX

Créer une interface web moderne, responsive et accessible, inspirée des **principes ergonomiques** de Claude Code sans copier son identité visuelle. Utiliser **Angular + TypeScript + Tailwind CSS**, un design system cohérent, des composants réutilisables et un éditeur de code de type Monaco compatible Angular.

Écrans minimum : authentification/MFA, accueil, équipes, projets, workspaces, conversation Pi, fichiers/code/diff, Git/PR/MR, consommation, notifications, paramètres utilisateur, connexions Git, skills/MCP et administration.

### 16.1 Workspace

Présenter navigation projet, explorateur arborescent, conversation centrale, outils/commandes repliables, état Pi, sélecteur de modèle, contexte/tokens, crédits 5 h et 7 jours, statut Git, approbations et prévisualisation. Permettre interruption, reconnexion SSE, copie de logs et accès aux fichiers. Plusieurs workspaces peuvent exister, mais **une conversation par workspace**.

### 16.2 Éditeur

**Lecture seule par défaut.** L'administrateur peut activer l'édition manuelle. Lorsque l'édition est autorisée, contrôler les droits, versions de fichiers et conflits de concurrence avec Pi ; ne jamais écraser silencieusement les changements. Chaque sauvegarde réussie déclenche un checkpoint.

### 16.3 Pièces jointes

Supporter upload multiple, images, glisser-déposer, collage, prévisualisation, association à un message et retrait. Contrôler taille, type réel, permissions, décompression d'archives, malwares et rétention. Tenir compte des capacités du modèle LiteLLM sélectionné. Conserver les pièces jointes selon des permissions distinctes de celles des snapshots.

### 16.4 Prévisualisation

Autoriser les applications web démarrées par Pi via **proxy de ports sécurisé**, support HTTP/WebSocket. **3 ports simultanés par workspace par défaut**, limite configurable. Utiliser une **origine distincte** de l'application principale et contrôler l'authentification, les destinations et l'accès réseau. La prévisualisation ne doit pas recevoir les cookies ou privilèges de l'administration. Un partage de conversation ne donne pas implicitement accès aux previews.

## 17. Notifications et emails

Centre de notifications persistantes, état lu/non lu, liens contextuels, préférences individuelles et canaux imposés par politique globale. Événements : fin/échec de run, approbation Git requise, quota atteint/disponible, échec de checkpoint, invitation, événement de sécurité. Envois emails configurables via SMTP et templates. Les emails partent par jobs asynchrones avec retries/idempotence ; les notifications de sécurité obligatoires ne peuvent pas être désactivées individuellement.

## 18. Rétention et suppression

**Seul l'administrateur plateforme** fixe les durées de rétention par type de données : conversations, messages, événements Pi, logs outils, pièces jointes, notifications, checkpoints, workspaces archivés et audit. Mettre en place purge, suppression logique si adaptée, suppression définitive, gestion des dépendances, audit et blocage de purge pour obligation de conservation lorsque nécessaire. Ne pas purger des informations indispensables à la reprise d'une conversation conservée. Les équipes ne configurent pas leurs propres durées.

## 19. Console d'administration

Fournir une vraie interface Angular, sécurisée, avec audit des modifications et possibilité de tester les configurations :

1. **Vue d'ensemble :** utilisateurs, équipes, workspaces, sandboxes, appels LLM, coûts, erreurs, santé.
2. **Utilisateurs :** profils, rôles, sessions, MFA, quotas, suspension et suppression.
3. **Équipes :** membres, permissions, projets, plafonds de crédits optionnels.
4. **IAM :** login local, inscriptions, OIDC, SAML, Keycloak, LDAP, GitHub/GitLab, SMTP.
5. **Modèles :** LiteLLM, disponibilité, droits, défaut, coefficients entrée/sortie/cache.
6. **Quotas :** plafonds globaux/individuels/équipe, exemptions, désactivation, ajustements, historiques.
7. **Sandboxes :** images officielles, instances, CPU/RAM, durée, arrêt forcé, checkpoints.
8. **Skills/MCP :** catalogue, versions, permissions, portées, sources, révocation.
9. **Secrets :** état Vault, références et politiques sans divulgation des valeurs.
10. **Stockage :** S3, consommation, erreurs, synchronisation, rétention.
11. **Previews :** limite de ports, règles de proxy et réseaux.
12. **Notifications :** SMTP, templates, canaux et politiques.
13. **Audit et rétention :** recherche, export, purges et conservation.

Ne pas donner à l'administrateur d'équipe un accès implicite au contenu des conversations privées.

## 20. PostgreSQL et contrats de données

Créer un schéma normalisé, migrable et indexé couvrant au minimum :

- `users`, `local_credentials`, `auth_providers`, `auth_identities`, `user_sessions`, `mfa_factors`, `invitations`, `git_connections`.
- `teams`, `team_members`, `projects`, `project_members`, `repositories`.
- `workspaces`, `conversations`, `conversation_shares`, `messages`, `agent_runs`, `agent_events`, `tool_calls`, `attachments`.
- `sandbox_images`, `sandbox_instances`, `workspace_leases`, `workspace_snapshots`, `checkpoint_jobs`, `preview_ports`.
- `llm_models`, `model_coefficients`, `quota_policies`, `credit_reservations`, `credit_ledger`, `llm_requests`.
- `git_operations`, `git_approval_requests`.
- `skills`, `skill_versions`, `skill_installations`, `mcp_servers`, `mcp_tools`, `mcp_installations`, `mcp_permissions`.
- `notifications`, `notification_preferences`, `email_deliveries`, `retention_policies`, `deletion_jobs`, `audit_events`, `outbox_events`, `idempotency_keys`.

Noms indicatifs : l'IA peut les adapter en conservant les invariants. Utiliser identifiants robustes, timestamps UTC, clés étrangères, contraintes d'unicité, index et transitions d'état contrôlées. **Unicité de la conversation par workspace**. **Pas de runs concurrents actifs sur la même conversation**. **Un seul lease en écriture par workspace, avec fencing token**. **Ledger de crédits immuable et idempotent**. **Approbations Git à usage unique**. Versionner les coefficients, snapshots et configurations sensibles.

Les secrets durables sont stockés dans Vault, pas en clair dans PostgreSQL. Un partage de conversation est nominatif, limité à `READ`, révocable et conditionné à l'appartenance courante à l'équipe.

## 21. API NestJS et streaming

Fournir une **API REST versionnée `/api/v1`**, documentée par OpenAPI avec validation DTO et gestion d'erreurs homogène. Couvrir : auth et SSO, utilisateurs, équipes, projets, workspaces, messages, fichiers, Git, approbations, modèles, quotas, previews, pièces jointes, skills, MCP, notifications et administration.

Exemples de routes :

```text
POST   /api/v1/auth/login
GET    /api/v1/auth/providers
GET    /api/v1/me
GET    /api/v1/teams
POST   /api/v1/projects
POST   /api/v1/workspaces
GET    /api/v1/workspaces/:id
POST   /api/v1/workspaces/:id/start
POST   /api/v1/workspaces/:id/messages
GET    /api/v1/workspaces/:id/events
GET    /api/v1/workspaces/:id/files
PUT    /api/v1/workspaces/:id/files
GET    /api/v1/workspaces/:id/git/status
POST   /api/v1/workspaces/:id/git/operations
POST   /api/v1/approvals/:id/decision
POST   /api/v1/conversations/:id/shares
DELETE /api/v1/conversations/:id/shares/:shareId
GET    /api/v1/models
GET    /api/v1/usage
GET    /api/v1/notifications
```

Utiliser **SSE** pour les événements agentiques, avec événement versionné, identifiant monotone par workspace, persistance et prise en charge `Last-Event-ID`. Exemples : `message.delta`, `tool.started`, `tool.output`, `tool.completed`, `file.changed`, `checkpoint.completed`, `approval.required`, `quota.paused`, `run.completed`, `run.failed`. Une reconnexion reprend le flux, **sans relancer Pi**. Documenter la resynchronisation lorsque des événements anciens ont expiré.

Prévoir pagination, corrélation, validation stricte, permissions systématiques, protection CSRF selon authentification, `Idempotency-Key` pour opérations critiques, contrôle des conflits d'édition (`ETag`/`If-Match` ou équivalent), erreurs métier stables et aucune fuite de secrets. Les appels externes à effet non idempotent ne sont pas rejoués aveuglément.

## 22. Interfaces de services internes

Définir des contrats TypeScript clairement typés pour :

- `SandboxProvider` : créer, inspecter, démarrer, exécuter en interne, attacher Pi, exposer port, arrêter, détruire.
- `AgentRuntime` : initialiser, prompt, streaming, changer modèle, interrompre, persister/reprendre état.
- `WorkspaceStorage` : restaurer, checkpoint, vérifier, nettoyer avec contrôle de génération et fencing.
- `QuotaService` : réserver, régulariser, libérer, lire les fenêtres, appliquer les exemptions.
- `GitApprovalService` : demander, approuver/refuser, exécuter via broker, réconcilier statut incertain.
- `SecretProvider` : référencer, lire pour identité service, révoquer, rotation, santé.
- `McpRegistryService`, `SkillCatalogService`, `PreviewService`, `NotificationService`, `RetentionService`.

Les contrats partagés utilisés par Angular doivent être indépendants du code NestJS exécuté côté serveur. Ne pas exporter de classes contenant de la logique de backend dans des packages chargés par le navigateur.

## 23. Sécurité non négociable

- Vérification des autorisations sur **chaque** ressource et chaque action.
- Isolation stricte entre utilisateurs, équipes et workspaces.
- Protection des conversations privées et des données de pièces jointes.
- Sécurité CSRF/XSS/SSRF, rate limiting, validation des entrées et headers adaptés.
- Sandbox durcie et réseau sortant maîtrisé.
- Vault obligatoire, moindre privilège, rotation et révocation.
- Pas de credential de publication Git réutilisable dans le contexte Pi.
- Approbations Git imposées **hors de Pi**, même pour appels faits par scripts/HTTP.
- MCP/skills non fiables contrôlés par origine, permissions et isolation.
- Previews isolées par origine, sans cookies de l'application principale.
- Uploads contrôlés et archives traitées prudemment.
- Traces, logs et SSE expurgés des secrets.
- Tests de pénétration automatisés ciblant les contournements de droits et de publication.

## 24. Observabilité et fiabilité

Logs structurés, traces et métriques (OpenTelemetry ou équivalent), correlation IDs, health/readiness probes, métriques API/workers/sandboxes, latence LiteLLM, quotas, checkpoints, erreurs Vault, jobs, previews et incidents d'authentification. Configurer alertes utiles. Limiter la collecte de contenu privé.

Prévoir migrations compatibles avec déploiements progressifs, backup/restore de PostgreSQL, Vault et S3, procédures de panne et reprises idempotentes. La disparition d'une instance API ne doit ni faire perdre une conversation ni provoquer un run dupliqué. Un résultat d'action Git incertain doit être réconcilié avant retry.

## 25. Tests et critères d'acceptation

Écrire tests unitaires, intégration, end-to-end, sécurité, charge et résilience. Valider notamment :

1. Login local, mot de passe oublié, MFA, OIDC/Keycloak, LDAP et OAuth GitHub/GitLab.
2. Utilisateur membre de plusieurs équipes avec permissions et quotas propres aux projets.
3. Conversation privée non lisible par un administrateur d'équipe ; partage nominatif révocable.
4. Création d'un workspace Git et d'un workspace vierge.
5. Une seule conversation et un seul run actif par workspace.
6. Deux API traitent la même session ; reconnexion SSE sans duplication du run.
7. Pi modifie des fichiers et un checkpoint est validé après chaque action d'écriture, y compris via shell.
8. Destruction d'une sandbox et restauration fidèle du dernier checkpoint confirmé et de l'état Pi.
9. Mode lecture seule appliqué côté serveur ; édition activable ; conflits détectés.
10. Concurrence de plusieurs appels LLM sans double réservation ou double facturation.
11. Quotas 5 h/7 j appliqués à l'utilisateur et à l'équipe propriétaire ; suspension et reprise.
12. Push Git et création PR/MR impossibles sans approbation ; essais de contournement via `git`, `gh`, `glab`, Python, Node.js et HTTP.
13. Skills/MCP respectant portées, permissions et révocations.
14. Trois previews autorisées par défaut, quatrième refusée ; limite administrable et isolation de domaine.
15. Upload sécurisé, notifications app/email, rétention et purge.
16. Pannes Vault, S3, worker, LiteLLM et instance API sans corruption ni exécution externe en double.
17. Déploiements opérationnels sur Docker Compose et Kubernetes de référence.

Une fonctionnalité n'est pas terminée si seul son écran Angular existe : vérifier API NestJS, persistance, contrôle d'accès, erreurs et tests de bout en bout.

## 26. Livrables exigés

- Code source complet et versionné du monorepo Angular/NestJS/pnpm.
- `pnpm-workspace.yaml`, `pnpm-lock.yaml`, scripts racine et versions verrouillées.
- Schéma PostgreSQL et migrations exécutables.
- Documentation OpenAPI et contrats d'événements SSE.
- Adaptateur Pi, intégration LiteLLM, orchestration sandbox et système de checkpoints.
- Git Broker avec approbations effectives et intégrations GitHub/GitLab.
- Interfaces utilisateur et administration Angular avec Tailwind.
- Dockerfiles, Docker Compose officiel, chart Helm/Kubernetes officiel.
- Configuration Vault/S3/SMTP/SSO documentée avec exemples sans secrets réels.
- Tests automatisés, rapports de validation et procédures de sauvegarde/restauration.
- `README.md`, `IMPLEMENTATION_PLAN.md`, documentation d'exploitation et `docs/adr/`.

## 27. Ordre de travail recommandé

1. **Socle** : monorepo pnpm, Angular, NestJS, PostgreSQL, migrations, IAM locale, équipes, permissions, configuration Vault.
2. **Moteur** : sandboxes, Pi, LiteLLM, conversation, SSE, stockage S3, checkpoints et restauration.
3. **Produit utilisateur** : projets Git/vierges, explorateur, chat, éditeur contrôlé, consommation, uploads.
4. **Contrôles** : ledger, crédits, quotas, Git Broker, approbations et workflows GitHub/GitLab.
5. **Entreprise** : OIDC/SAML/LDAP, MFA avancée, skills/MCP, previews, notifications, partage nominatif.
6. **Administration et production** : UI admin complète, rétention, audit, observabilité, Kubernetes, sécurité, tests de résilience et documentation.

L'IA peut réordonner les lots en documentant la raison, sans reporter indéfiniment la sécurité ni les fonctionnalités obligatoires. Maintenir des builds et tests exécutables à chaque jalon.

## 28. Définition de terminé

La plateforme est livrable lorsque les fonctionnalités ci-dessus sont **réellement opérationnelles**, les chemins critiques sont testés de bout en bout, les secrets sont protégés, les données survivent à la destruction des sandboxes, les quotas sont cohérents en multi-instance, les approbations Git sont impossibles à contourner par les canaux permis à Pi, et les installations Compose/Kubernetes de référence réussissent. Fournir un état des fonctionnalités, tests réalisés, limites et risques résiduels. Ne jamais déclarer « terminé » ce qui ne l'est pas.
