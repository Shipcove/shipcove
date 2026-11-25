# ADR 0013 — Accès autonome aux forges depuis la sandbox (git, gh, glab)

- Statut : accepté — 2026-11-14
- Remplace en partie : ADR 0007 (points 1, 2 et 4)

## Contexte

L'ADR 0007 interdisait tout accès réseau aux forges depuis la sandbox : chaque push, PR/MR ou
fusion passait par une approbation humaine. En pratique, cela empêche Pi d'être autonome :
- il ne peut ni suivre la CI ni lire les journaux ;
- il ne peut ni répondre aux revues ni ouvrir une PR sans intervention.

Le besoin est que `git`, `gh` et `glab` fonctionnent normalement dans la sandbox, **sans** y faire
entrer le jeton de l'utilisateur.

## Décision

1. **Interception TLS des seules forges.**
   - Le proxy d'egress de la gateway termine le TLS des connexions vers les forges : github.com,
     api.github.com, uploads.github.com, codeload.github.com, gitlab.com, ainsi que les hôtes GitHub
     Enterprise et GitLab auto-hébergés déclarés.
   - Il utilise une **autorité de certification propre à l'installation**.
   - Elle est générée par la gateway au premier démarrage, avec un verrou consultatif PostgreSQL
     entre instances.
   - Sa clé privée est stockée dans Vault (`infra/forge-ca`) et n'est lisible que par la gateway.
   - Son certificat public est servi sur `GET /forge/ca.pem`.
   - Le worker l'ajoute au magasin de confiance de la sandbox (`/run/cap/ca-bundle.pem`, désigné par
     `SSL_CERT_FILE`, `GIT_SSL_CAINFO`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE` et
     `NODE_EXTRA_CA_CERTS`).
   - Le reste du trafic n'est pas intercepté : il reste soumis à la liste blanche.
   - Les certificats feuilles sont en ECDSA P-256, valables 7 jours, avec le nom d'hôte en SAN.

2. **Jeton de run côté sandbox, jeton OAuth côté gateway.**
   - `gh`, `glab` et `git` reçoivent le jeton de run :
     - par `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` et `GITLAB_TOKEN` ;
     - par la configuration de glab ;
     - par l'assistant d'identification de git.
   - La gateway reconnaît le jeton de run dans `Authorization` (Bearer, token ou Basic),
     `PRIVATE-TOKEN` ou `JOB-TOKEN`, et authentifie la sandbox.
   - Elle remplace ce jeton par le jeton OAuth de l'utilisateur, lu dans Vault et renouvelé si besoin.
   - Sans jeton de run, une requête Git reçoit un 401, ce qui déclenche l'assistant
     d'identification. Les lectures d'API sans jeton sont relayées de façon anonyme.
   - **Le jeton de la forge n'entre jamais dans la sandbox.** Le jeton de run ne vaut que depuis le
     réseau des sandboxes et tant que la sandbox existe.

3. **Portée : tous les dépôts accessibles à l'utilisateur** (choix produit), et pas seulement celui
   de la conversation.

4. **Garde-fous appliqués par la gateway**, sans dépendre de l'outil utilisé.
   Les opérations suivantes sont refusées :
   - **Push** sur la branche par défaut, sur une branche protégée (lue sur la forge) ou sur une
     référence hors `refs/heads` et `refs/tags`. La section de commandes du push est lue au fil de
     l'eau, et le refus est renvoyé au format `report-status` (`! [remote rejected] … (raison)`).
   - **Suppression** de branche ou de tag, par push ou par l'API.
   - **Commits directs par l'API** (Contents API, Repository Files ou Commits API) sur la branche par
     défaut ou une branche protégée. Le GraphQL `createCommitOnBranch` est refusé.
   - **Fusion** de PR/MR : REST, GraphQL, auto-merge et merge queue.
   - **Réglages du dépôt**, protections, membres, webhooks, environnements, suppression, archivage
     et transfert.
   - **Accès durables** : clés SSH ou GPG, clés et jetons de déploiement, jetons d'accès, runners,
     secrets et variables de CI, Codespaces.
   - **Écritures dans l'interface web** de la forge, hors API, Git et LFS.
   - **Approbations et déploiements** : approbation d'une PR/MR (revue `APPROVE`, `approve` GitLab),
     approbation de déploiements, déclenchement de workflows ou de pipelines, statuts de CI,
     publications (releases), rejet des revues d'autrui.
   - **Réécriture d'un tag existant** (création de tag autorisée).

   Depuis la revue de sécurité de novembre 2026, les écritures d'API sont une **liste blanche**
   (`apps/gateway/src/forge/forge-allowlist.ts`) : toute écriture qui n'y figure pas est refusée,
   y compris une API nouvelle de la forge. Les chemins sont entièrement décodés avant les règles
   (`m%65rge` = `merge`) ; les mutations GraphQL sont analysées champ par champ (alias, fragments).
   Une écriture n'est relayée que **pendant un run en cours** : un processus resté en arrière-plan
   ne publie plus rien une fois le run terminé. Les corps compressés ne sont pas acceptés sur les
   écritures d'API.

   Ces actions restent possibles par les outils de la plateforme, avec approbation humaine :
   `platform_git_push`, `platform_merge_pull_request` et `platform_delete_remote_branch`.

5. **Traçabilité.**
   - Chaque écriture relayée et chaque refus produit un événement d'audit `git.agent_write`, avec
     l'hôte, la méthode et le chemin.
   - La gateway journalise aussi `forge_write`, `forge_denied` et `forge_push_denied`.

6. **Remote `origin`.**
   - Le clone initial passe toujours par le proxy de lecture.
   - L'`origin` est ensuite redirigé vers l'URL réelle de la forge, pour que gh et glab
     reconnaissent le dépôt.

7. Les noms `GH_*`, `GLAB_*`, `GITHUB_TOKEN`, `GITLAB_TOKEN` et `GIT_SSL_*` sont réservés : une
   variable de dépôt ne peut pas les redéfinir.

## Conséquences

- Pi est autonome :
  - push de branches de travail ;
  - PR/MR, commentaires et revues ;
  - CI : journaux et relances ;
  - tickets.
- Une injection de prompt réussie peut agir sur la forge au nom de l'utilisateur pendant un run :
  pousser des branches, ouvrir des PR, commenter. Elle ne peut ni toucher la branche par défaut, ni
  fusionner, ni approuver, ni déployer, ni supprimer, ni obtenir un accès durable, ni emporter le
  jeton.
- Risque résiduel : une branche poussée déclenche la CI de la forge. Sur GitLab, un
  `.gitlab-ci.yml` modifié s'exécute avec les variables CI **non protégées** : marquez « protégées »
  les variables sensibles (elles ne sont alors fournies qu'aux branches protégées). Sur GitHub, la
  portée OAuth `workflow` n'est pas demandée : un push qui modifie `.github/workflows` est refusé.
- Les écritures autorisées sont dans `apps/gateway/src/forge/forge-allowlist.ts`, les refus
  explicites (avec leur message) dans `forge-policy.ts`.
- Les protections propres à la forge (branches protégées, règles) restent appliquées par la forge
  elle-même.

## Vérification

- Tests unitaires et d'intégration de la gateway : `forge-policy.spec.ts` et `forge-proxy.spec.ts`.
  Ils couvrent le TLS réel avec l'autorité, git réel en HTTPS et en HTTP, et le refus de push lisible.
- `tests/e2e/git.test.mjs`, contre un vrai GitLab CE :
  - push direct et MR sans approbation ;
  - main, fusion, suppression et clé de déploiement refusées ;
  - glab opérationnel ;
  - audit.
- `tests/e2e/stack.test.mjs` :
  - certificat de l'autorité des forges ;
  - jeton de run ;
  - refus balisé `X-Cap-Forge-Denied` ;
  - accès direct, registre et réseau interne toujours bloqués.
