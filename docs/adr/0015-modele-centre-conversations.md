# ADR 0015 — Modèle centré sur les conversations (suppression des équipes et projets)

- Statut : accepté
- Date : 2026-11-15
- Remplace : les notions d'équipe et de projet des ADR 0001 et 0005

## Contexte

Le modèle initial imposait une hiérarchie équipe → projet → workspace avant la première demande à
Pi : créer une équipe, y ajouter des membres, créer un projet (vierge ou lié à un dépôt), puis un
workspace. Cette hiérarchie portait les droits sur les modèles, les plafonds de quota, les portées
de skills et de MCP, le partage et l'environnement des sandboxes. À l'usage, elle ralentit le
démarrage sans apporter de cloisonnement utile : les quotas sont déjà strictement personnels, et le
partage du code passe par Git.

## Décision

1. **La conversation est l'unique objet de travail** (table `workspaces`, une conversation et une
   sandbox chacune). L'accueil de l'application est une nouvelle conversation ; elle est créée au
   premier envoi.
2. **Dépôt Git facultatif**, choisi sous la zone de saisie parmi les dépôts accessibles avec les
   connexions Git de l'utilisateur. Le dépôt est vérifié avec la connexion de l'utilisateur (même
   hôte que la connexion), puis inscrit au catalogue partagé `repositories` (unique par hôte et nom
   complet). La conversation référence `repository_id` et `git_connection_id`.
3. **Environnement par dépôt, partagé** : image de sandbox, script de préparation, variables et
   secrets (`environment_variables` de portée `repository`, secrets Vault
   `env/repository/<id>/<nom>`) sont gérés par l'administrateur plateforme et s'appliquent à toutes
   les conversations sur ce dépôt.
4. **Tout simplifier** :
   - tout modèle activé est proposé à tous les utilisateurs ;
   - skills et MCP : portées globale (administrateur) et personnelle ;
   - partage en lecture seule avec n'importe quel utilisateur actif (annuaire `/users/search`, sans
     emails) ;
   - invitations à la plateforme par l'administrateur (`/admin/invitations`) ;
   - plus de rôle d'administrateur d'équipe ni de mainteneur.
5. **Titres automatiques** : après le premier message, un modèle choisi par l'administrateur
   (`conversations.titleModelId`) propose un titre court, sinon le début du message sert de titre.
   Ces appels, émis par l'API directement auprès de LiteLLM, ne sont pas décomptés des quotas. Un
   titre renommé par l'utilisateur (`title_source = 'user'`) n'est jamais remplacé. L'événement
   `workspace.renamed` met à jour l'interface en direct.
6. **Barre latérale** : conversations regroupées par dépôt, les dépôts les plus récemment actifs
   d'abord, puis les conversations sans dépôt par tranche de date.

## Conséquences

- Migrations 0013–0014 : suppression des tables `teams`, `team_members`, `projects`, `project_members` et des colonnes
  `team_id` / `project_id`. Les lignes de portée équipe (skills, MCP, variables, politiques de
  quota) sont supprimées : projet en développement, sans données à reprendre.
- Les droits se réduisent à deux cas : propriétaire de la conversation, ou destinataire d'un
  partage actif (lecture seule). L'administrateur ne lit toujours pas les conversations privées.
- Un secret de dépôt est utilisable par l'agent de toute conversation sur ce dépôt, comme un secret
  de CI : il ne faut y mettre que des identifiants de développement à droits minimaux.
- La gestion des membres et des rôles par groupe (y compris via SSO) pourra revenir plus tard sous
  forme de groupes d'accès aux dépôts, sans réintroduire la hiérarchie.
