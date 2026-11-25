# Forges Git (GitHub, GitLab)

## Configuration par l'administrateur

Les comptes Git des utilisateurs se rattachent **par OAuth**, via les forges déclarées dans
**Administration → Forges Git**. Il faut une forge, avec sa propre application OAuth, pour chacune :

| Forge | Où créer l'application OAuth |
|---|---|
| GitHub.com | Settings → Developer settings → OAuth Apps → New OAuth App |
| GitHub Enterprise Server | Même chemin, sur l'instance |
| GitLab.com | Paramètres utilisateur ou de groupe → Applications, application **confidentielle** |
| GitLab auto-hébergé | Admin Area → Applications → New application, **confidentielle** |

1. **Ajouter** la forge : type, nom affiché, hôte (fixe pour les offres SaaS), Client ID et secret
   client. Le secret est stocké dans Vault (`oauth-apps/<id>`) et n'est jamais renvoyé.
2. **Déclarer chez la forge** l'URL de rappel affichée par la console
   (`<PUBLIC_URL>/api/v1/me/git-connections/oauth/<id>/callback`), ainsi que les portées indiquées :
   - GitHub : `repo read:user user:email read:org` ;
   - GitLab : `api read_user read_repository write_repository`.
3. **Tester** : la console vérifie que la forge est joignable et que l'identifiant et le secret
   client sont acceptés. Un code factice est présenté à la forge, qui doit répondre « code
   invalide » et non « client invalide ».
4. **Activer** : la forge apparaît dans **Paramètres → Connexions Git** des utilisateurs.

Supprimer une forge révoque toutes les connexions des utilisateurs qui en dépendent.

**Par variables d'environnement** : une forge GitLab ou GitHub se déclare aussi avec
`GIT_GITLAB_HOST`, `GIT_GITLAB_CLIENT_ID`, `GIT_GITLAB_CLIENT_SECRET` (et `GIT_GITHUB_*`), ou
plusieurs avec `GIT_FORGES` en JSON ; elle est créée (activée) au démarrage de l'API. Il reste à
déclarer chez la forge l'URL de rappel affichée par la console. Voir
[`environment.md`](environment.md#forges-git).

**Jetons d'accès personnels** : ils sont désactivés par défaut. L'administrateur peut les autoriser
dans **Forges Git → Réglages Git** (`git.allowPersonalTokens`), par exemple pour une forge
dépourvue d'OAuth.

## Côté utilisateur

**Paramètres → Connexions Git → Connecter via <forge>** : autorisation sur la forge, puis retour
automatique.
- **Sécurité du flux** : PKCE (S256), `state` à usage unique lié à l'utilisateur connecté, validité
  de 10 minutes.
- **Renouvellement** : les jetons qui expirent (GitLab : 2 h) sont renouvelés automatiquement,
  avec un verrou par connexion, car les jetons de renouvellement GitLab ne servent qu'une fois.
- **Expiration** : une connexion expirée ou révoquée côté forge affiche « Reconnecter ».

Les jetons sont stockés dans Vault. Ils ne quittent jamais le serveur et n'atteignent jamais les
sandboxes (ADR 0013).
- `git`, `gh` et `glab` fonctionnent dans la sandbox avec un **jeton de run**. La gateway intercepte
  le TLS des forges (autorité propre à l'installation) et remplace ce jeton par le jeton OAuth de
  l'utilisateur.
- Pi est autonome :
  - push de branches de travail ;
  - PR/MR, commentaires et revues ;
  - CI (état, journaux, relance, annulation) ;
  - tickets.
- Les écritures de l'agent sur l'API de la forge sont une **liste blanche** : toute autre écriture
  est refusée. Elles ne sont relayées que pendant un run en cours.
- **Portée** (`git.agentWriteScope`, **Forges Git → Réglages Git**) : par défaut
  `workspace_repository`, l'agent ne pousse et n'écrit par l'API que dans le dépôt de la
  conversation (lecture partout). `any` lui ouvre tous les dépôts de l'utilisateur. Les mutations
  GraphQL autorisées (commentaires, tickets, PR) ne désignent pas leur dépôt dans le chemin : elles
  restent soumises aux seules règles d'opérations.
- La gateway refuse les opérations suivantes, qui passent par les outils de la plateforme
  **après approbation humaine** :
  - push sur la branche par défaut ou sur une branche protégée ;
  - fusion ;
  - suppression de branche ou de tag.
- Elle refuse aussi, sans alternative pour l'agent (réservé à un humain sur la forge) :
  - approbation d'une PR/MR, approbation de déploiements, déclenchement de workflows ou de
    pipelines, statuts de CI, publications (releases) ;
  - réécriture d'un tag existant ;
  - réglages et suppression du dépôt ;
  - clés, jetons, runners et secrets de CI.
- Ce que l'humain approuve (commits et diff d'un push, d'une PR/MR) est calculé par le worker ou
  par la forge, jamais par la sandbox.
- **GitLab** : une branche poussée par l'agent déclenche la CI ; marquez « protégées » les
  variables CI sensibles pour qu'elles ne soient fournies qu'aux branches protégées.
- Chaque écriture et chaque refus sont audités (`git.agent_write`).

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
- `git push` d'une branche de travail et création de MR par l'API, sans approbation ; `glab`
  opérationnel.
- Push sur `main`, suppression de branche, fusion et clé de déploiement refusés par la gateway ;
  `main` inchangée sur la forge.
- Aucun jeton de la forge dans l'environnement de la sandbox ; le certificat présenté pour les forges
  est celui de l'autorité de l'installation (`tests/e2e/stack.test.mjs`).
