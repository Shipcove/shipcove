#!/usr/bin/env bash
# Infrastructure ÉPHÉMÈRE pour les tests d'intégration (jamais pour un déploiement).
#  - PostgreSQL 18 en tmpfs sur 127.0.0.1:5433 (cap/cap, base cap_test)
#  - Vault en mode -dev sur 127.0.0.1:8299 (jeton root) — mode dev réservé aux tests
#  - Garage mono-nœud sur 127.0.0.1:3910 (bucket cap-test)
set -euo pipefail
docker rm -f cap-test-pg cap-test-vault cap-test-garage >/dev/null 2>&1 || true
docker run -d --name cap-test-pg --tmpfs /var/lib/postgresql:rw -p 127.0.0.1:5433:5432 \
  -e POSTGRES_USER=cap -e POSTGRES_PASSWORD=cap -e POSTGRES_DB=cap_test postgres:18.7-alpine >/dev/null
docker run -d --name cap-test-vault -p 127.0.0.1:8299:8200 -e VAULT_DEV_ROOT_TOKEN_ID=root hashicorp/vault:2.2.2 >/dev/null
cat > /tmp/cap-test-garage.toml <<'TOML'
metadata_dir = "/tmp/meta"
data_dir = "/tmp/data"
db_engine = "sqlite"
replication_factor = 1
rpc_bind_addr = "[::]:3901"
rpc_public_addr = "127.0.0.1:3901"
rpc_secret = "1799bccfd7411eddcf9ebd316bc1f5287ad12a68094e1c6ac6abde7e6feae1ec"
[s3_api]
s3_region = "garage"
api_bind_addr = "[::]:3900"
[admin]
api_bind_addr = "[::]:3903"
admin_token = "test-admin-token"
TOML
docker run -d --name cap-test-garage -p 127.0.0.1:3910:3900 -v /tmp/cap-test-garage.toml:/etc/garage.toml:ro \
  -e GARAGE_DEFAULT_ACCESS_KEY=GK000000000000000000000000 \
  -e GARAGE_DEFAULT_SECRET_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
  -e GARAGE_DEFAULT_BUCKET=cap-test \
  dxflrs/garage:v2.5.0 /garage server --single-node --default-bucket >/dev/null
until docker exec cap-test-pg pg_isready -U cap -d cap_test >/dev/null 2>&1; do sleep 1; done
until curl -sf http://127.0.0.1:8299/v1/sys/health >/dev/null; do sleep 1; done
curl -s -X POST -H 'X-Vault-Token: root' http://127.0.0.1:8299/v1/sys/mounts/cap -d '{"type":"kv","options":{"version":"2"}}' >/dev/null
curl -s -X POST -H 'X-Vault-Token: root' http://127.0.0.1:8299/v1/cap/data/infra/s3 \
  -d '{"data":{"accessKeyId":"GK000000000000000000000000","secretAccessKey":"0000000000000000000000000000000000000000000000000000000000000000"}}' >/dev/null
curl -s -X POST -H 'X-Vault-Token: root' http://127.0.0.1:8299/v1/cap/data/infra/preview -d '{"data":{"key":"test-preview-key-0123456789abcdef"}}' >/dev/null
curl -s -X POST -H 'X-Vault-Token: root' http://127.0.0.1:8299/v1/cap/data/infra/litellm -d '{"data":{"masterKey":"sk-test"}}' >/dev/null
echo "Infra de test prête : PG 127.0.0.1:5433, Vault 127.0.0.1:8299, S3 127.0.0.1:3910"
