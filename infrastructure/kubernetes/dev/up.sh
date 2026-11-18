#!/usr/bin/env bash
# Recette Kubernetes locale : cluster kind, dépendances de test, images locales et chart Helm.
#   ./infrastructure/kubernetes/dev/up.sh            → cluster + dépendances + chart
#   SKIP_IMAGES=1 ./infrastructure/kubernetes/dev/up.sh   → sans recharger les images
# Prérequis : docker, kind, kubectl, helm ; images construites (tools/build-images.sh).
# Application : http://localhost:28080 (admin@example.test / Admin-Password-123!).
set -euo pipefail
cd "$(dirname "$0")/../../.."
CLUSTER="${KIND_CLUSTER:-shipcove}"
CTX="kind-${CLUSTER}"
NS=shipcove
DEV=infrastructure/kubernetes/dev
K="kubectl --context ${CTX}"

if ! kind get clusters | grep -qx "$CLUSTER"; then
  kind create cluster --name "$CLUSTER" --config "$DEV/kind.yaml" --wait 120s
fi

if [ "${SKIP_IMAGES:-0}" != 1 ]; then
  for i in api worker gateway preview web sandbox; do
    echo "▶ image shipcove-$i:0.1.0"
    kind load docker-image --name "$CLUSTER" "shipcove-$i:0.1.0"
  done
fi

echo "▶ dépendances de recette"
$K apply -f "$DEV/deps.yaml"
$K -n shipcove-deps create configmap mock-llm --from-file=server.mjs=tools/mock-llm/server.mjs --dry-run=client -o yaml | $K apply -f -
$K -n shipcove-deps create configmap garage-init --from-file="$DEV/garage-init.mjs" --dry-run=client -o yaml | $K apply -f -
$K -n shipcove-deps rollout status deploy/postgres deploy/vault deploy/garage --timeout=300s
$K -n shipcove-deps delete job garage-init --ignore-not-found
$K -n shipcove-deps apply -f - <<'YAML'
apiVersion: batch/v1
kind: Job
metadata: { name: garage-init, namespace: shipcove-deps }
spec:
  backoffLimit: 5
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: init
          image: node:26-bookworm-slim
          command: [node, /init/garage-init.mjs]
          env:
            - { name: GARAGE_ADMIN_URL, value: "http://garage:3903" }
            - { name: GARAGE_ADMIN_TOKEN, value: garage-dev-admin-token }
            - { name: S3_ACCESS_KEY_ID, value: GK0123456789abcdef01234567 }
            - { name: S3_SECRET_ACCESS_KEY, value: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef }
          volumeMounts: [{ name: init, mountPath: /init }]
      volumes: [{ name: init, configMap: { name: garage-init } }]
YAML
$K -n shipcove-deps wait --for=condition=complete job/garage-init --timeout=300s

echo "▶ secrets de l'application (recette)"
$K create namespace "$NS" --dry-run=client -o yaml | $K apply -f -
DB=postgres://cap:cap-dev-password@postgres.shipcove-deps.svc.cluster.local:5432/cap
$K -n "$NS" create secret generic shipcove-database --from-literal=api="$DB" --from-literal=worker="$DB" --from-literal=gateway="$DB" --dry-run=client -o yaml | $K apply -f -
$K -n "$NS" create secret generic shipcove-admin --from-literal=email="${CAP_ADMIN_EMAIL:-admin@example.test}" --from-literal=password="${CAP_ADMIN_PASSWORD:-Admin-Password-123!}" --dry-run=client -o yaml | $K apply -f -
$K -n "$NS" create secret generic shipcove-vault-admin --from-literal=token=root --dry-run=client -o yaml | $K apply -f -
$K -n "$NS" create secret generic shipcove-infra \
  --from-literal=s3-access-key-id=GK0123456789abcdef01234567 \
  --from-literal=s3-secret-access-key=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --from-literal=litellm-master-key=sk-dev-master-key --dry-run=client -o yaml | $K apply -f -

echo "▶ chart Helm"
helm --kube-context "$CTX" upgrade --install shipcove infrastructure/helm/shipcove -n "$NS" -f "$DEV/values-kind.yaml" --wait --timeout 10m
$K -n "$NS" get pods
echo "Shipcove : http://localhost:28080"
