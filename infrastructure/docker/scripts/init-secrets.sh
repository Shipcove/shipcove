#!/usr/bin/env bash
# Génère les secrets d'amorçage locaux de l'installation Docker Compose (idempotent).
# Ils sont lus par Docker (secrets montés en fichiers) ; les secrets applicatifs vivent dans Vault.
# En production : stocker ce répertoire chiffré / hors de l'hôte, ou le remplacer par un gestionnaire externe.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)/.secrets"
mkdir -p "$DIR/approle"
chmod 700 "$DIR"

gen() { # gen <fichier> <commande>
  local f="$DIR/$1"
  if [[ ! -s "$f" ]]; then
    eval "$2" > "$f"
    chmod 600 "$f"
    echo "généré : $1"
  fi
}
gen postgres_password      "openssl rand -hex 24"
gen garage_rpc_secret      "openssl rand -hex 32"
gen garage_admin_token     "openssl rand -base64 32 | tr -d '\n'"
gen garage_metrics_token   "openssl rand -base64 32 | tr -d '\n'"
gen s3_access_key_id       "echo GK\$(openssl rand -hex 12)"
gen s3_secret_access_key   "openssl rand -hex 32"
gen litellm_master_key     "echo sk-cap-\$(openssl rand -hex 24)"
gen litellm_salt_key       "echo sk-salt-\$(openssl rand -hex 24)"
gen docker_guard_token     "openssl rand -hex 32"

PG="$(cat "$DIR/postgres_password")"
for svc in api worker gateway; do
  gen "database_url_$svc" "echo postgres://cap:${PG}@postgres:5432/cap"
done
gen litellm_database_url "echo postgresql://cap:${PG}@postgres:5432/litellm"

# Fichier d'environnement pour LiteLLM (n'accepte pas *_FILE).
ENVF="$DIR/litellm.env"
if [[ ! -s "$ENVF" ]]; then
  {
    echo "LITELLM_MASTER_KEY=$(cat "$DIR/litellm_master_key")"
    echo "LITELLM_SALT_KEY=$(cat "$DIR/litellm_salt_key")"
    echo "DATABASE_URL=$(cat "$DIR/litellm_database_url")"
  } > "$ENVF"
  chmod 600 "$ENVF"
fi
echo "Secrets d'amorçage prêts dans $DIR"
