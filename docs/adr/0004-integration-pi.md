# ADR 0004 — Intégration de Pi : mode RPC dans la sandbox

- Statut : accepté — 2026-11-13

## Décision
- Pi (`pi --mode rpc`) s'exécute **dans la sandbox** du workspace, lancé par le worker via
  `exec` (Docker / Kubernetes) en reliant stdin/stdout. Le protocole est le JSONL officiel de Pi
  (`docs/rpc.md`), découpé uniquement sur `\n`.
- `PiAgentRuntime` (package `agent-runtime`) encapsule ce protocole derrière l'interface
  `AgentRuntime` ; aucun type Pi ne fuit dans les contrats publics.
- Configuration générée par le worker à chaque démarrage : `~/.pi/agent/models.json` (un provider
  unique `platform`, API `openai-completions`, `baseUrl` = gateway LLM), `settings.json`
  (télémétrie et vérifications de version désactivées, `PI_OFFLINE=1`), skills autorisés,
  session dans `/workspace-state/pi-sessions` (inclus dans les checkpoints).
- Une **extension Pi « platform bridge »** (préinstallée dans l'image, non modifiable par Pi car
  hors des répertoires inscriptibles) :
  - hook `tool_result` : demande un checkpoint au worker et attend sa confirmation avant de rendre
    la main à Pi (le canal est le sous-protocole officiel `extension_ui_request/response` du mode
    RPC — aucun accès réseau n'est nécessaire) ;
  - outils plateforme : `platform_git_push`, `platform_create_pull_request`, etc. qui créent des
    demandes d'approbation (Pi ne détient aucun credential de publication) ;
  - pont MCP (Pi ne gère pas MCP nativement).
- Les contrôles de sécurité ne dépendent **pas** de cette extension : approbations Git et quotas
  sont imposés hors de Pi (gateway, réseau, absence de credentials).
- Reprise : le fichier de session Pi est restauré depuis le checkpoint puis passé via `--session`.

## Alternatives écartées
- SDK `createAgentSession` dans le worker : Pi exécuterait ses outils dans le worker, hors sandbox.
- Fork de Pi : non nécessaire.
