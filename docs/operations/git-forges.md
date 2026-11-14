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
sandboxes :
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
