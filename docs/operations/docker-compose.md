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

## Configuration par variables d'environnement

Le service `api` lit aussi `.env` : la connexion LiteLLM et les modèles (création, découverte au
démarrage, activation, modèle par défaut), les fournisseurs SSO, les forges Git, le SMTP et les
paramètres plateforme peuvent y être déclarés et sont appliqués à chaque démarrage. Toutes ces
variables sont facultatives ; liste complète dans [`environment.md`](environment.md), modèle commenté
en fin de `.env.example`. Un LiteLLM existant remplace celui fourni avec `CAP_LITELLM_URL` et
`LITELLM_MASTER_KEY`.

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
- `cap-sbx-net-<instance>` : réseau **interne et privé** de chaque sandbox, créé par le garde dans
  la plage `CAP_SANDBOX_SUBNET_POOL` (un `/28` par sandbox, `10.231.0.0/16` par défaut) et supprimé
  avec elle. Le garde y branche la gateway et la preview (étiquette `cap.sandbox-peer`), et les
  rebranche toutes les 15 s si elles ont été recréées. Deux sandboxes ne peuvent donc pas se joindre,
  même quand un serveur de développement écoute sur `0.0.0.0`. La plage ne doit chevaucher aucun
  réseau de l'hôte ni de l'entreprise ; vide, on revient à l'ancien réseau partagé `cap-sandbox`
  (déconseillé).

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
- Documentation de l'API (`/api/docs`) : désactivée en production ; `API_DOCS=true` pour la publier.
- Adresse IP des clients : l'API ne croit l'en-tête `X-Forwarded-For` que de `web` et `edge`
  (`CAP_TRUST_PROXY`, défaut `loopback, web, edge` ; noms de services résolus toutes les 30 s).
  Les autres conteneurs du réseau interne ne peuvent donc pas usurper l'adresse utilisée pour le
  verrouillage après échecs de connexion et l'audit. Ajoutez votre propre reverse proxy s'il précède
  `web` (nom, adresse ou plage).
- LiteLLM : interface d'administration désactivée (`DISABLE_ADMIN_UI`) ; la plateforme n'utilise
  que son API, avec la clé maître.
- Images téléchargeables par le garde : `CAP_GUARD_PULL_ALLOWLIST` (préfixes, ex.
  `ghcr.io/shipcove/,harbor.example.com/`).
- Antivirus : `CLAMAV_HOST` ; sans lui, les pièces jointes ne sont pas analysées (signalé dans la vue
  d'ensemble de l'administration).
- Ne pas activer le profil `dev`.
- Voir les limites connues dans le README (trafic interne, sauvegardes, observabilité).
