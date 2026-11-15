# Services lancés par l'agent (bases de données, caches, files)

L'agent (Pi) démarre **lui-même**, quand le code ou ses tests en ont besoin, des services d'appui
choisis dans un **catalogue géré par l'administrateur plateforme** : PostgreSQL, Redis, RabbitMQ, etc.
**Rien ne démarre tant que l'agent ne le demande pas**, et l'utilisateur n'a rien à configurer.

## Administration → Sandboxes & previews → « Services lancés par l'agent »

Pour chaque service du catalogue :
- **clé** (ex. `postgres`) et **nom** ;
- **image** : choisissez des images de confiance, idéalement verrouillées par digest ;
- **port** documenté ;
- **sonde de santé** : commande exécutée dans le conteneur ;
- **variables par défaut** ;
- **mémoire** par défaut et maximale ;
- **proposé ou non** à l'agent.

Le catalogue initial contient PostgreSQL 17, Redis 8 et RabbitMQ 4. Le nombre de services par sandbox
est limité (`sandbox.maxServicesPerWorkspace`, 4 par défaut).

Désactiver ou supprimer un service ne coupe pas les instances déjà lancées : elles s'arrêtent avec
leur sandbox. Le service n'est simplement plus proposé.

## Miroir de registre

Pour un déploiement sans accès direct aux registres publics, **Administration → Sandboxes &
previews → Miroir de registre** fait télécharger les images des services depuis votre miroir
(Harbor, Nexus, Artifactory, `registry:2` en cache…).

- **Correspondance** : chaque registre d'origine est servi sous un préfixe du miroir. Avec
  `docker.io` → `harbor.corp/dockerhub`, `redis:7.4-alpine` devient
  `harbor.corp/dockerhub/library/redis:7.4-alpine` (règles de Docker : registre implicite
  `docker.io`, préfixe `library/`). Tags et digests sont conservés. Une image d'un registre sans
  correspondance est téléchargée depuis son origine ; une référence déjà écrite sur le miroir est
  utilisée telle quelle.
- **Identifiants** facultatifs (compte robot en lecture), stockés dans Vault (`infra/registry`) et
  jamais renvoyés. Ils ne sont présentés qu'à l'hôte du miroir.
- **Repli** facultatif : si le miroir échoue, téléchargement depuis le registre d'origine.
- **Prise en compte** immédiate, au prochain démarrage d'un service ; un service déjà lancé avec
  l'ancienne image est recréé à sa prochaine demande. Une image déjà présente sur l'hôte n'est pas
  retéléchargée.
- **Moteur Docker** : c'est lui qui télécharge, pas la sandbox (le proxy de sortie n'intervient
  pas). Un miroir en HTTP ou à certificat interne doit y être déclaré (`insecure-registries`,
  `/etc/docker/certs.d/<hôte>/ca.crt`).
- **Mise à jour** d'une installation existante : la politique Vault (API en écriture, worker en
  lecture sur `infra/registry`) est appliquée par l'amorçage, avec `VAULT_TOKEN` en production.

## Côté agent : l'outil `platform_services`

L'outil n'est proposé à Pi que si le catalogue n'est pas vide. Sa description liste les services
disponibles. Actions :

| Action | Effet |
|---|---|
| `start` | Lance un service (`service` = clé du catalogue, `name` pour une 2e instance, `env`, `memoryMb`) et attend que sa sonde de santé soit au vert. Relancer avec la même configuration est sans effet. |
| `stop` | Arrête et supprime une instance, avec ses données. |
| `status` | État des services lancés et liste des services disponibles. |
| `logs` | Dernières lignes du journal d'un service, secrets masqués. |
| `catalog` | Catalogue complet. |

Dans `env`, `${NOM}` est remplacé côté plateforme par une variable ou un secret du dépôt. L'agent
peut donc configurer `POSTGRES_PASSWORD=${DB_PASSWORD}` sans jamais voir la valeur.

## Isolation et cycle de vie

- **Réseau** : chaque service partage le réseau de **sa** sandbox. Il est joignable sur
  `localhost:<port>` depuis celle-ci, et depuis nulle part ailleurs (ni les autres sandboxes, ni le
  backend). Il n'a pas plus d'accès sortant que la sandbox.
- **Conteneurs durcis** :
  - capacités minimales nécessaires aux images officielles qui abandonnent root au démarrage ;
  - `no-new-privileges` ;
  - limites de mémoire, CPU et nombre de processus.
- **Durée de vie** : un service dure autant que la sandbox, puis est supprimé avec elle. Ses données
  sont **éphémères** : après un redémarrage de sandbox, l'agent relance les services et refait
  migrations et données de test.
- **Script de préparation** : il s'exécute avant que l'agent ne démarre. Les services n'existent
  donc pas encore à ce moment-là. Réservez-le aux dépendances ; l'agent initialise les données après
  avoir lancé ses services.
- **Kubernetes** : pas encore disponible. Le provider Kubernetes doit d'abord être validé sur un
  cluster de référence. Les services y prendront la forme de conteneurs annexes du Pod.
