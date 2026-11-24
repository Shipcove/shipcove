# Déploiement Kubernetes (chart Helm)

Le chart `infrastructure/helm/shipcove` déploie l'application (API, worker, gateway, proxy des
previews, interface web) et le **namespace des sandboxes**. Les dépendances restent externes :
PostgreSQL, Vault, un stockage S3 et LiteLLM (services managés ou charts dédiés).

Une recette complète sur un cluster local (kind) est fournie : `infrastructure/kubernetes/dev/`.

## Architecture

| Composant | Objet | Rôle |
|---|---|---|
| `api` | Deployment (2 répliques) + Service | API REST / SSE, sous `/api` via l'interface web |
| `worker` | Deployment + Role dans le namespace des sandboxes | Runs de Pi, Pods des sandboxes et des services, checkpoints |
| `gateway` | Deployment + Service (8081, 3128) | Relais LLM et Git des sandboxes, proxy d'egress filtré |
| `preview` | Deployment + Service (8090) | Previews sur une origine distincte (`*.preview.<domaine>`) |
| `web` | Deployment + Service (8080) | Interface Angular, relais de l'API |
| `migrate` | Job (hook `pre-install`, `pre-upgrade`) | Migrations de la base avant les services |
| `vault-setup` | Job (hook, facultatif) | Configuration de Vault (voir plus bas) |

Le worker n'a **aucun** droit sur le cluster en dehors du namespace des sandboxes : Pods (création,
exécution interne, journaux, suppression), Secrets de registre des services, NetworkPolicies des
services. Il n'existe aucun ClusterRole applicatif.

### Sandboxes

Une sandbox est un Pod du namespace `sandbox.namespace` (défaut `shipcove-sandboxes`) :

- aucun jeton de ServiceAccount monté, `enableServiceLinks: false` ;
- utilisateur 10001, `runAsNonRoot`, système de fichiers racine en lecture seule, aucune capacité,
  `allowPrivilegeEscalation: false`, seccomp `RuntimeDefault` (compatible profil `restricted`) ;
- zones inscriptibles en `emptyDir` bornés (`/workspace`, `/home/agent`, `/tmp`, `/run/cap` en
  mémoire) ; un conteneur d'initialisation recopie le `/home/agent` de l'image ;
- RuntimeClass facultative (`sandbox.runtimeClassName` : gVisor, Kata) pour un isolement renforcé ;
- `sandbox.nodeSelector` et `sandbox.imagePullSecrets` pour des nœuds et un registre dédiés.

L'état durable n'est jamais dans le Pod : les checkpoints partent vers S3, et un Pod détruit est
recréé à l'identique au run suivant.

### Services d'appui (PostgreSQL, Redis…)

Un Pod en cours d'exécution ne peut pas recevoir de nouveau conteneur : chaque service lancé par
Pi tourne dans **son propre Pod**, durci comme sous Docker (capacités minimales des images
officielles, limites CPU et mémoire, aucun jeton monté). Dans la sandbox, un relais TCP
(`/opt/cap/bin/cap-port-relay`) l'expose sur `localhost:<port>` : Pi l'utilise exactement comme
avec Docker Compose (`psql -h 127.0.0.1 …`).

Isolation : une NetworkPolicy par sandbox (`cap-svc-<instance>`, créée et supprimée par le
worker) n'accepte vers ses services que le trafic de cette sandbox. Les services n'ont aucune
sortie réseau. Les identifiants d'un registre miroir sont placés dans un Secret propre au service,
supprimé avec lui.

Les services des images officielles démarrent en root puis abandonnent ces droits : le namespace
des sandboxes applique donc le profil Pod Security **`baseline`** (avertissement et audit
`restricted`). Les sandboxes elles-mêmes respectent `restricted`.

### Réseau

**Le réseau du cluster doit appliquer les NetworkPolicies** (Calico, Cilium, Antrea…), y compris
pour le trafic vers les adresses des nœuds (API Kubernetes, kubelet). Sans cela, une sandbox joint
tout le cluster. Calico et Cilium filtrent ces adresses ; kindnet (kind, recette) filtre les Pods
et Internet mais **pas** les adresses du nœud : la sandbox y atteint l'API Kubernetes, qui la refuse
faute de jeton (vérifié par `tests/e2e/kubernetes.test.mjs`). N'utilisez pas kindnet en production.
Le chart installe dans le namespace des sandboxes :

- `shipcove-default-deny` : tout interdit, entrées et sorties ;
- `shipcove-sandbox-egress` : sorties des sandboxes vers la gateway (8081, 3128), le DNS du
  cluster et leurs services d'appui uniquement ;
- `shipcove-sandbox-ingress` : entrées vers les sandboxes depuis le proxy des previews uniquement.

Si le namespace de l'application applique ses propres politiques, autorisez l'entrée vers la
gateway (8081, 3128) depuis le namespace des sandboxes, et la sortie du proxy des previews vers
celui-ci.

## Prérequis

1. **PostgreSQL 16 ou plus récent** : une base pour Shipcove. Les URL de connexion sont dans un
   Secret (`database.existingSecret`, défaut `shipcove-database`) avec les clés `api`, `worker` et
   `gateway` (la preview utilise `gateway`). Elles peuvent désigner des rôles distincts.
2. **Vault** avec un montage KV v2 (`vault.kvMount`, défaut `cap`). Les composants s'authentifient
   par leur ServiceAccount (méthode `kubernetes`, recommandée) ou par AppRole
   (`vault.authMethod: approle` et un Secret `<composant>-role-id` / `<composant>-secret-id`).
3. **S3** (AWS, MinIO, Garage, Ceph…) avec deux buckets : `cap-workspaces` et `cap-attachments`.
4. **LiteLLM** joignable depuis la gateway et l'API (`litellm.url`).
5. Un **Ingress controller** et deux noms DNS : l'application et le domaine générique des previews
   (`*.preview.<domaine>`, certificat générique recommandé).

## Configuration de Vault

Avec `vaultSetup.enabled: true`, un Job (hook Helm) configure Vault à chaque installation et mise
à niveau, de façon idempotente :

- montage KV v2 ;
- politiques `cap-api`, `cap-worker`, `cap-gateway`, `cap-preview` (mêmes droits que l'amorçage
  Docker Compose : `files/vault-policies.json`, vérifié par `tests/chart.test.mjs`) ;
- méthode `kubernetes` et un rôle par composant, lié à son ServiceAccount et au namespace de la
  release. La revue des jetons utilise un ServiceAccount dédié (`<release>-vault-reviewer`, lié à
  `system:auth-delegator`). Si Vault est hors du cluster, renseignez
  `vaultSetup.kubernetesAuth.host` avec l'URL de l'API Kubernetes vue depuis Vault ;
- secrets d'infrastructure absents : clés de signature des previews et des sessions (générées),
  identifiants S3 et clé maître LiteLLM (Secret `vaultSetup.infraSecret`, clés
  `s3-access-key-id`, `s3-secret-access-key`, `litellm-master-key`).

Le jeton d'administration (`vaultSetup.tokenSecret`, clé `token`) ne sert qu'à ce Job. Révoquez-le
ou désactivez le Job une fois Vault configuré si votre politique l'exige.

## Installation

```bash
kubectl create namespace shipcove
kubectl -n shipcove create secret generic shipcove-database \
  --from-literal=api='postgres://…' --from-literal=worker='postgres://…' --from-literal=gateway='postgres://…'
kubectl -n shipcove create secret generic shipcove-admin \
  --from-literal=email=admin@example.com --from-literal=password='…'

helm upgrade --install shipcove infrastructure/helm/shipcove -n shipcove \
  --set publicUrl=https://shipcove.example.com \
  --set preview.domain=preview.example.com \
  --set bootstrapAdmin.existingSecret=shipcove-admin \
  --set vault.address=https://vault.example.com \
  --set s3.endpoint=https://s3.example.com --set s3.region=eu-west-1 \
  --set litellm.url=http://litellm.litellm.svc:4000 \
  --set ingress.className=nginx
```

Pour une mise à niveau, la même commande suffit (migrations jouées avant le déploiement).

Configuration déclarative (facultative) : modèles LiteLLM, SSO, forges Git, SMTP et paramètres
plateforme se déclarent en variables d'environnement de l'API, appliquées à chaque démarrage
([`environment.md`](environment.md)). Le plus simple est un Secret chargé entier :

```bash
kubectl -n shipcove create secret generic shipcove-provisioning \
  --from-literal=LITELLM_ENABLED_MODELS='*' --from-literal=LITELLM_DEFAULT_MODEL=gpt-5 \
  --from-literal=SSO_OIDC_ISSUER=https://keycloak.example.com/realms/acme \
  --from-literal=SSO_OIDC_CLIENT_ID=shipcove --from-literal=SSO_OIDC_CLIENT_SECRET='…' \
  --from-literal=GIT_GITLAB_HOST=gitlab.example.com \
  --from-literal=GIT_GITLAB_CLIENT_ID='…' --from-literal=GIT_GITLAB_CLIENT_SECRET='…'
helm upgrade --install shipcove infrastructure/helm/shipcove -n shipcove … \
  --set 'api.envFrom[0].secretRef.name=shipcove-provisioning'
```

La clé de LiteLLM vient alors de Vault (`vaultSetup.infraSecret`) ou de `LITELLM_MASTER_KEY`.

### Ingress et previews

- L'application (`publicUrl`) pointe vers le Service `web`, qui relaie lui-même l'API (flux SSE
  compris). Désactivez la mise en tampon des réponses sur l'Ingress si votre contrôleur en ajoute
  une (par exemple `nginx.ingress.kubernetes.io/proxy-buffering: "off"`) et prévoyez de longs
  délais de lecture pour le SSE.
- Les previews (`*.preview.<domaine>`) pointent vers le Service `preview`.
- `api.trustProxy` doit couvrir les adresses de l'Ingress controller (IP des clients exactes,
  limitation de débit) et rien d'autre : une plage trop large (`uniquelocal`) laisse tout pod du
  cluster usurper l'adresse d'un client. Valeurs acceptées : mots-clés, adresses, plages CIDR ou
  noms DNS (résolus toutes les 30 s).
- Le worker crée et supprime les NetworkPolicies propres à chaque sandbox. Sur Kubernetes ≥ 1.30,
  une `ValidatingAdmissionPolicy` (`networkPolicies.protectChartPolicies`, activée par défaut)
  l'empêche de modifier ou supprimer celles du chart (deny-all, sortie vers la gateway). Le
  namespace des sandboxes applique le profil Pod Security `baseline` (`restricted` en avertissement).

## Exploitation

- **Suivi** : `kubectl -n shipcove get pods`, `kubectl -n shipcove-sandboxes get pods,networkpolicies`.
- **Quotas du namespace des sandboxes** : `sandbox.quota` (ResourceQuota), en plus des limites par
  sandbox réglées dans l'administration.
- **Arrêt d'un nœud** : les sandboxes sont des Pods sans contrôleur. Un Pod perdu est détecté par
  le worker et recréé au run suivant depuis le dernier checkpoint.
- **Limites connues** : pas de limite de processus par sandbox côté Kubernetes (réglage `pidsLimit`
  du kubelet, global au nœud). Les services exposent uniquement le port déclaré dans le catalogue.

## Recette locale (kind)

```bash
tools/build-images.sh
infrastructure/kubernetes/dev/up.sh          # cluster kind, dépendances de test, chart
CAP_E2E_KUBERNETES=1 CAP_E2E_URL=http://localhost:28080 \
  node --test tests/e2e/kubernetes.test.mjs
```

L'application est servie sur http://localhost:28080 et les previews sur le port 28090. Les
dépendances de `deps.yaml` (Vault en mode dev, mots de passe connus) sont réservées à la recette.
