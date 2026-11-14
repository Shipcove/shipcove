# ADR 0014 — Garde du moteur Docker

- Statut : accepté — 2026-11-14

## Contexte

Le worker créait les sandboxes en accédant directement au socket Docker de l'hôte. Ce socket
équivaut à un accès root sur la machine : un worker compromis aurait pu lancer un conteneur
privilégié, monter `/` de l'hôte ou rejoindre ses espaces de noms. Les causes possibles sont
nombreuses : une dépendance vulnérable, une désérialisation, ou une faille de l'orchestration
exploitée depuis une sandbox.

## Décision

Un service dédié, **`docker-guard`** (`apps/docker-guard`, Node sans dépendance), est le **seul**
détenteur du socket. Le worker l'appelle comme un démon Docker, via `DOCKER_GUARD_URL`.

1. **Canal** : réseau Compose interne `dockerctl`, partagé uniquement par le worker et le garde.
   Chaque appel porte un secret partagé (`X-Cap-Guard-Token`, `.secrets/docker_guard_token`), comparé
   en temps constant.
2. **Liste blanche des appels** :
   - ping et version ;
   - liste des conteneurs, avec filtre `cap.sandbox=true` ou `cap.service=true` obligatoire ;
   - création ;
   - inspect, start, stop, kill, wait, logs (sans suivi) et suppression d'un conteneur géré ;
   - exec (création, démarrage, inspection) dans un conteneur géré ;
   - inspect et téléchargement d'image.

   Tout le reste est refusé : volumes, réseaux, build, archive, attach, update, swarm, plugins,
   système.
3. **Conteneur géré** : ses étiquettes (`cap.sandbox=true` ou `cap.service=true`) sont relues sur
   le moteur à chaque opération. Une exécution est rattachée à son conteneur par `ContainerID`.
4. **Création validée champ par champ**, sur liste blanche des clés (toute clé inconnue est refusée).
   - **Sandbox** :
     - utilisateur `10001:10001` et réseau `cap-sandbox` ;
     - système de fichiers racine en lecture seule, `CapDrop ALL` sans `CapAdd`, `no-new-privileges`
       seul (aucun `seccomp`/`apparmor=unconfined`), non privilégié ;
     - limites mémoire, CPU et processus obligatoires et plafonnées ;
     - montages limités à des volumes **anonymes** sur `/workspace`, `/workspace-state` et
       `/home/agent`, avec pilote `local` sans options (le pilote `local` avec
       `type=none,o=bind,device=/` monterait l'hôte) ;
     - tmpfs limités à `/tmp` et `/run/cap`, avec `nosuid,nodev` ;
     - runtime absent ou explicitement autorisé (`GUARD_ALLOWED_RUNTIMES`, ex. `runsc`) ;
     - nom `cap-sbx-*`.
   - **Service d'appui** :
     - réseau `container:<id>` d'une sandbox gérée, et étiquette `cap.sandbox` cohérente ;
     - capacités limitées à `CHOWN SETUID SETGID DAC_OVERRIDE FOWNER` ;
     - aucun montage ;
     - mêmes limites et options de sécurité que les sandboxes ;
     - nom `cap-svc-*`.
5. **Exécution avec flux** (`exec/start` détourné) : relais brut après contrôle.
   - Le corps de la requête (remis par Node sur la requête et non sur la connexion) est retransmis.
   - La connexion est mise en pause pendant les contrôles.
6. Chaque refus est journalisé (`docker_denied`).
7. Le conteneur du garde est en lecture seule, sans capacité, avec `no-new-privileges`.

## Conséquences

- Un worker compromis peut créer, arrêter ou exécuter des commandes dans les sandboxes et services
  de la plateforme, ce qui est son rôle. Il ne peut plus en sortir vers l'hôte, ni toucher aux
  autres conteneurs (base de données, Vault…).
- Le garde reste un composant de confiance avec accès root effectif à l'hôte. Il est petit, sans
  dépendance, et n'écoute que sur un réseau interne.
- Toute évolution des appels Docker du provider doit être reflétée dans `policy.ts` (test
  d'intégration contre le vrai moteur dans `guard.spec.ts`).
- Les sandboxes peuvent en plus tourner sous gVisor (`CAP_SANDBOX_RUNTIMES=runsc`, `SANDBOX_RUNTIME`),
  qui protège contre les évasions depuis la sandbox elle-même.
