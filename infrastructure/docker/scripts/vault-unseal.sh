#!/usr/bin/env bash
# Déverrouillage manuel de Vault (CAP_VAULT_UNSEAL_MODE=manual).
# Chaque détenteur exécute ce script et saisit SA clé (non affichée) ; le seuil atteint, Vault s'ouvre.
# Clé chiffrée PGP : jq -r '.["clés de déverrouillage"][N]' .secrets/vault-unseal-keys.pgp.json | base64 -d | gpg -d
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose exec vault vault operator unseal
docker compose exec vault vault status | grep -E "^(Sealed|Unseal Progress|Unseal Nonce)" || true
