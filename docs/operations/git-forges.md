# Forges Git (GitHub, GitLab)

Les utilisateurs rattachent leurs comptes dans **Paramètres → Connexions Git**, par OAuth ou par jeton
d'accès personnel. Les jetons sont stockés dans Vault. Ils ne quittent jamais le serveur et
n'atteignent jamais les sandboxes :
- Pi lit le dépôt à travers la passerelle (`/git/…`), avec un jeton de run ;
- toute publication (push, PR/MR, fusion, suppression de branche) passe par le broker, après
  approbation humaine de l'opération exacte (commit, cible).

## Forges auto-hébergées

- GitHub Enterprise Server : fournisseur `github_enterprise`. L'API est appelée sur `https://<hôte>/api/v3`.
- GitLab self-managed : fournisseur `gitlab_self_managed`. L'API est appelée sur `https://<hôte>/api/v4`.
- **HTTPS est obligatoire.** Une forge interne en HTTP (par exemple de recette) n'est joignable que
  si l'administrateur liste `hôte[:port]` dans **Administration → Plateforme → Forges Git**
  (`git.insecureHttpHosts`). Les jetons transitent alors en clair sur ce réseau : réservez cette option
  aux réseaux de confiance.
- L'URL de clonage renvoyée par la forge doit désigner **le même hôte** que la connexion, sinon le
  projet est refusé : un jeton n'est jamais présenté à un autre hôte.

## Garanties vérifiées par les tests (`tests/e2e/git.test.mjs`, GitLab CE réel)

- Rien n'est publié avant la décision humaine.
- L'opération approuvée est figée : si la branche a changé depuis l'approbation, l'exécution est
  refusée et une nouvelle demande est nécessaire.
- Une approbation n'est utilisable qu'une fois. Une demande refusée ne publie rien.
- Les commandes `git push`, `gh` et `glab`, ainsi que les appels HTTP directs vers les forges depuis
  la sandbox, sont bloqués par le réseau (`tests/e2e/stack.test.mjs`).
