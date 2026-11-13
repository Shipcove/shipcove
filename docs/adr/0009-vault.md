# ADR 0009 — Vault et SecretProvider

- Statut : accepté — 2026-11-13

- Interface `SecretProvider` (référencer, lire, écrire, révoquer, rotation, santé) ;
  implémentation officielle `VaultSecretProvider` via l'API HTTP de Vault (KV v2 monté sur `cap/`).
- Authentification machine : **AppRole** en Docker Compose (role_id/secret_id distincts par
  service, fichiers montés en lecture seule), **Kubernetes auth** en Helm (ServiceAccount).
- Politiques minimales : `api` (lecture/écriture des secrets de configuration et des connexions),
  `worker` (lecture des credentials Git et SMTP), `gateway` (lecture de la clé LiteLLM maîtresse,
  des credentials Git en lecture et MCP). Aucune politique ne permet de lister l'ensemble.
- PostgreSQL ne stocke que des références `vault:cap/data/<chemin>#<clé>` et des métadonnées.
- Compose : Vault en mode serveur, stockage raft persistant, script d'initialisation qui produit
  les clés de descellement dans `infrastructure/docker/.secrets` (à déplacer hors de l'hôte en
  production ; auto-unseal recommandé). Le mode `-dev` n'est utilisé que dans les tests.
