#!/usr/bin/env bash
# Construit toutes les images de la plateforme (applications + sandbox) depuis la racine du dépôt.
#   ./tools/build-images.sh            → étiquette CAP_VERSION (défaut 0.1.0)
#   CAP_REGISTRY=registry.exemple.com/shipcove/ CAP_VERSION=1.2.0 ./tools/build-images.sh
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${CAP_VERSION:-0.1.0}"
REGISTRY="${CAP_REGISTRY:-}"

for target in api worker gateway preview docker-guard; do
  echo "▶ ${REGISTRY}shipcove-${target}:${VERSION}"
  docker build -f infrastructure/docker/Dockerfile.node --target "$target" -t "${REGISTRY}shipcove-${target}:${VERSION}" .
done
echo "▶ ${REGISTRY}shipcove-web:${VERSION}"
docker build -f infrastructure/docker/Dockerfile.web -t "${REGISTRY}shipcove-web:${VERSION}" .
echo "▶ ${REGISTRY}shipcove-sandbox:${VERSION}"
docker build -t "${REGISTRY}shipcove-sandbox:${VERSION}" -t "${REGISTRY}shipcove-sandbox:latest" packages/sandbox-image
echo "Images construites (version ${VERSION})."
