# ADR 0007 — Git Credential Broker et approbations

- Statut : accepté — 2026-11-13

## Décision
1. **Aucun credential Git n'entre dans la sandbox.** Ni token, ni helper, ni variable.
2. **Réseau** : la sandbox est sur un réseau interne sans route vers Internet. Son seul accès
   sortant est le proxy d'egress de `apps/gateway`, qui applique une liste de domaines autorisés
   (registres de paquets par défaut, administrable) et **refuse** les forges (github.com,
   gitlab.com, hôtes GitHub Enterprise / GitLab self-hosted configurés et leurs API).
   Ainsi `git push`, `gh`, `glab`, Python, Node ou HTTP brut ne peuvent atteindre aucune forge,
   indépendamment de toute détection de commande.
3. **Lecture** (clone/fetch/pull) : via le read-proxy Git de la gateway (`/git/<connexion>/<repo>`)
   qui n'accepte que `git-upload-pack` et injecte côté serveur le credential lu dans Vault.
4. **Écriture** (push, PR/MR, merge, suppression de branche distante) : Pi appelle un outil
   plateforme → `git_approval_requests` liée à l'action exacte (dépôt, remote ref, SHA local
   attendu, liste des commits, diff stat, expiration, décideur = propriétaire du workspace).
   Après approbation (usage unique, transition atomique `pending → approved → consumed`), le
   worker exporte un `git bundle` depuis la sandbox, vérifie que le SHA correspond à l'approbation,
   puis pousse depuis un dépôt temporaire côté worker avec le credential Vault (jamais exposé).
5. **Résultat incertain** (timeout réseau) : l'opération passe en `unknown` ; un job de
   réconciliation lit l'état distant (`ls-remote`, API PR) avant tout retry.
