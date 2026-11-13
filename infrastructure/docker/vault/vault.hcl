# Vault en mode serveur (stockage raft persistant). Ce n'est PAS le mode -dev.
# TLS : désactivé sur le réseau interne Compose par défaut ; activer `tls_cert_file`/`tls_key_file`
# en production (voir docs/operations/vault.md).
ui            = true
disable_mlock = true

storage "raft" {
  path    = "/vault/file"
  node_id = "vault-1"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true
}

api_addr     = "http://vault:8200"
cluster_addr = "http://vault:8201"
