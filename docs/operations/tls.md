# TLS : point d'entrée intégré (Caddy)

Le profil Compose `tls` ajoute un service `edge` (Caddy) qui écoute sur les ports 80 et 443. Il
obtient et renouvelle automatiquement les certificats (ACME, Let's Encrypt par défaut) pour :
- l'application, sur `CAP_DOMAIN` ;
- les previews, sur `*.CAP_PREVIEW_DOMAIN`.

Vous pouvez aussi garder votre propre reverse proxy (voir le site de documentation, page
*Installation*).

## Configuration (`infrastructure/docker/.env`)

```bash
CAP_DOMAIN=code.exemple.com
CAP_PREVIEW_DOMAIN=preview.exemple.com      # DNS : *.preview.exemple.com → l'hôte
CAP_TLS_EMAIL=admin@exemple.com
CAP_PUBLIC_URL=https://code.exemple.com
CAP_PREVIEW_SCHEME=https
CAP_PREVIEW_PORT=443
CAP_COOKIE_SECURE=true
```

```bash
docker compose --profile tls up -d
```

L'application et les previews restent aussi joignables en HTTP sur `127.0.0.1` (ports 8080 et
8090), pour l'administration locale uniquement.

## Certificats des previews

| `CAP_TLS_PREVIEW` | Fonctionnement | Quand l'utiliser |
|---|---|---|
| `on-demand` (défaut) | Un certificat par preview, émis à la première connexion. Caddy demande d'abord à la plateforme si la preview existe et est ouverte (`/__cap_tls_ask`) : aucun certificat n'est émis pour un nom inventé. | Peu de previews. Let's Encrypt limite le nombre de certificats par domaine et par semaine. |
| `files` | Certificat wildcard fourni dans `edge/certs/preview.crt` et `preview.key`, par exemple obtenu par défi DNS, à renouveler par vos soins. | Nombreuses previews. |

## Autorité interne

`CAP_TLS_ISSUER=internal` remplace ACME par l'autorité locale de Caddy. C'est utile en recette ou
sur un réseau privé sans accès ACME. Les postes doivent alors faire confiance à son certificat
racine : `docker compose exec edge cat /data/caddy/pki/authorities/local/root.crt`.

## En-têtes

- HSTS d'un an sur l'application.
- En-tête `Server` retiré.
- Flux temps réel (SSE) relayés sans mise en tampon.

## Trafic interne

Le trafic entre services Compose (PostgreSQL, Vault, S3, API) circule en clair sur des réseaux
Docker internes à l'hôte. Pour un déploiement multi-hôte, chiffrez ces liaisons : TLS de
PostgreSQL et de Vault, ou un maillage de services.

## Vérification

`tests/e2e/tls.test.mjs` (autorité interne) vérifie :
- l'application en HTTPS avec HSTS ;
- un certificat émis à la demande pour une preview ouverte, et aucun pour un nom inconnu.
