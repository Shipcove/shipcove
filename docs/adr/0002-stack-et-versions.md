# ADR 0002 — Stack et versions verrouillées

- Statut : accepté — 2026-11-13

Versions stables vérifiées sur le registre npm / Docker Hub le 2026-11-13 :

| Composant | Version | Remarque |
| --- | --- | --- |
| Node.js | 26.x (LTS depuis 10/2026) | `.nvmrc`, images `node:26-bookworm-slim` |
| pnpm | 12.18.0 | `packageManager` racine. Node 26 ne fournit plus Corepack : provisionner via `npm i -g pnpm@12.18.0` (documenté) |
| TypeScript | 6.0.3 | Angular 22 exige `>=6.0 <6.1` ; TS 7 (natif) non retenu |
| Angular | 22.2.x | standalone, signals, nouveau control flow |
| Tailwind CSS | 4.3.x | via `@tailwindcss/postcss` |
| NestJS | 12.x | ESM uniquement ; validation Standard Schema (Zod) ; OpenAPI via `@nestjs/swagger` 12 |
| Zod | 4.x | schémas partagés + génération OpenAPI native (`~standard.jsonSchema`) |
| Drizzle ORM / drizzle-kit | 0.45 / 0.31 | schéma TS, migrations SQL versionnées dans git |
| Pi (`@mariozechner/pi-coding-agent`) | 0.73.1 | installé dans l'image sandbox, épinglé |
| LiteLLM | `ghcr.io/berriai/litellm:v1.109.1` | |
| PostgreSQL | 18.7 | |
| HashiCorp Vault | 2.2.2 | mode serveur (raft) en Compose |
| Garage (S3) | v2.5.0 | stockage objet compatible S3 |
| Mailpit | latest épinglé par digest en CI | SMTP de développement uniquement |
| Tests | Vitest 4, Playwright (préinstallé) | |
| Lint | oxlint | |

Les images de déploiement sont référencées par tag ; le pipeline de release les épingle par digest
(`infrastructure/images.lock`).
