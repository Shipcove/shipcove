# Déploiement Docker Compose

Pile de référence : `infrastructure/docker/compose.yml`. Guide complet (reverse proxy, mises à jour,
sauvegardes) : site de documentation, pages *Installation* et *Exploitation* (`pnpm docs:dev`).

## Démarrage

```bash
cd infrastructure/docker
cp .env.example .env              # CAP_REGISTRY, CAP_VERSION, CAP_SANDBOX_IMAGE, admin, CAP_DOCKER_GID…
./scripts/init-secrets.sh         # secrets d'amorçage dans .secrets/ (jamais versionnés, à sauvegarder)
docker compose pull               # images ghcr.io/shipcove/shipcove-* (ou `pnpm images:build` depuis les sources)
docker pull "$CAP_SANDBOX_IMAGE"
docker compose up -d              # --profile dev : Mailpit + LLM factice
```

## Ordre de démarrage

1. `postgres`, `vault`, `garage` ;
2. `bootstrap` : initialisation de Vault selon `CAP_VAULT_UNSEAL_MODE` (voir `vault.md`), AppRoles et
   politiques, buckets S3, secrets d'infrastructure ;
3. `vault-unsealer` : redéverrouille Vault en mode `file`, et ne fait que surveiller dans les autres
   modes ;
4. `migrate` (migrations Drizzle) ;
5. `docker-guard`, puis `api` (×`CAP_API_REPLICAS`), `worker`, `gateway`, `preview`, `litellm` et
   `web` ;
6. `edge` (Caddy, TLS) avec le profil `tls` (voir `tls.md`).

Le service `sandbox` ne démarre pas : il sert seulement à construire l'image de sandbox.

## Réseaux

- `backend` : services de la plateforme et dépendances.
- `sandbox` : réseau **interne** des sandboxes ; seules la gateway et la preview y sont aussi.
- `dockerctl` : réseau **interne** entre le worker et le garde Docker, seul détenteur du socket
  (ADR 0014).

## Opérations courantes

| Besoin | Commande |
|---|---|
| État | `docker compose ps` |
| Journaux | `docker compose logs -f api worker gateway` |
| Politiques Vault après mise à jour | `docker compose run --rm bootstrap` puis redémarrage des services |
| Plus de workers | `docker compose up -d --scale worker=2` |
| Sauvegarde PostgreSQL | `docker compose exec -T postgres pg_dump -U cap -Fc cap > cap.dump` |

## Production

- TLS : profil `tls` (Caddy, `tls.md`) ou votre reverse proxy ; `CAP_COOKIE_SECURE=true`.
- Vault : `CAP_VAULT_UNSEAL_MODE=manual` ou `auto` **avant** la première initialisation (`vault.md`).
- Domaine des previews distinct de l'application.
- Ne pas activer le profil `dev`.
- Voir les limites connues dans le README (trafic interne, sauvegardes, observabilité).
