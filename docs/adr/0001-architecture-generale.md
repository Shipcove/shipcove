# ADR 0001 — Architecture générale et découpage du monorepo

- Statut : accepté
- Date : 2026-11-13

## Contexte

Le cahier des charges (`SPEC.md`) impose Angular + Tailwind, NestJS, pnpm workspaces, Pi, LiteLLM,
PostgreSQL, Vault, un stockage S3 et des sandboxes éphémères. Il demande un backend modulaire plutôt
que des microservices artificiels, une API réplicable et des workers séparés.

## Décision

Monorepo pnpm unique (un seul `pnpm-lock.yaml`), tout en TypeScript ESM.

| Chemin | Rôle | Exposition |
| --- | --- | --- |
| `apps/web` | Angular 22 + Tailwind 4 (utilisateur + administration) | public |
| `apps/api` | NestJS 12 : REST `/api/v1`, SSE, OpenAPI, IAM, permissions | public (derrière LB, N répliques) |
| `apps/worker` | NestJS 12 (contexte applicatif) : orchestrateur Pi, sandboxes, checkpoints, Git Broker (exécution), emails, rétention | interne, N répliques |
| `apps/gateway` | NestJS 12 : **frontière des sandboxes** — proxy LLM vers LiteLLM avec réservation de crédits, proxy d'egress filtrant, Git read-proxy | réseau sandbox uniquement |
| `apps/preview` | Preview Gateway : proxy HTTP/WebSocket vers les ports des sandboxes, origine distincte | public, domaine séparé |
| `packages/contracts` | Schémas Zod + types partagés navigateur/serveur, événements SSE versionnés | navigateur + serveur |
| `packages/database` | Schéma Drizzle, migrations SQL, client | serveur |
| `packages/server-core` | Modules NestJS partagés (DB, config, secrets, audit, quotas, jobs, notifications) | serveur |
| `packages/agent-runtime` | `AgentRuntime` + `PiAgentRuntime` (client RPC JSONL de Pi) | serveur |
| `packages/sandbox` | `SandboxProvider` + implémentations Docker et Kubernetes | serveur |
| `packages/storage` | `WorkspaceStorage` : checkpoints incrémentaux S3, manifestes, fencing | serveur |
| `packages/secrets` | `SecretProvider` + `VaultSecretProvider` | serveur |
| `packages/sandbox-image` | Image officielle de sandbox + extension Pi « platform bridge » | image |

Le découpage logique (IAM, équipes, projets, workspaces, orchestrateur, quotas, checkpoints, Git
Broker, approbations, skills, MCP, notifications, previews, admin, audit) est réalisé par **modules
NestJS** dans `apps/api`/`apps/worker`, pas par microservices.

`apps/gateway` est séparé de l'API pour des raisons de **sécurité** (frontière de confiance) :
les sandboxes ne peuvent joindre que ce service sur le réseau interne ; elles ne voient ni l'API
publique, ni PostgreSQL, ni Vault, ni LiteLLM.

## Conséquences

- Les packages partagés chargés par Angular (`contracts`) n'importent ni NestJS ni Node.
- Toutes les apps serveur sont stateless ; l'état durable est dans PostgreSQL / S3 / Vault.
- La structure diffère légèrement de la structure indicative du SPEC (ajout de `gateway`, `preview`,
  `server-core`, `storage`, `secrets`, `sandbox-image`) ; c'est le présent ADR qui le justifie.
