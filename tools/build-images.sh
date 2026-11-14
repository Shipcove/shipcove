#!/usr/bin/env bash
# Construit toutes les images de la plateforme (applications + sandbox) depuis la racine du dépôt.
#   ./tools/build-images.sh            → étiquette CAP_VERSION (défaut 0.1.0)
#   CAP_REGISTRY=registry.exemple.com/cap/ CAP_VERSION=1.2.0 ./tools/build-images.sh
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${CAP_VERSION:-0.1.0}"
REGISTRY="${CAP_REGISTRY:-}"

for target in api worker gateway preview docker-guard; do
  echo "▶ ${REGISTRY}cap-${target}:${VERSION}"
  docker build -f infrastructure/docker/Dockerfile.node --target "$target" -t "${REGISTRY}cap-${target}:${VERSION}" .
done
echo "▶ ${REGISTRY}cap-web:${VERSION}"
docker build -f infrastructure/docker/Dockerfile.web -t "${REGISTRY}cap-web:${VERSION}" .
echo "▶ ${REGISTRY}cap-sandbox:${VERSION}"
docker build -t "${REGISTRY}cap-sandbox:${VERSION}" -t "${REGISTRY}cap-sandbox:latest" packages/sandbox-image
echo "Images construites (version ${VERSION})."
