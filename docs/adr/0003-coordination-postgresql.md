# ADR 0003 — PostgreSQL comme unique service de coordination (pas de Redis en v1)

- Statut : accepté — 2026-11-13

## Contexte
Le SPEC autorise « Redis ou équivalent retenu » pour files, verrous et caches, mais exige que
PostgreSQL reste la source de vérité des crédits, sessions et checkpoints.

## Décision
Aucun Redis en v1. PostgreSQL fournit :
- **File de jobs** durable (`jobs`) consommée via `SELECT … FOR UPDATE SKIP LOCKED`, avec retries,
  backoff, clé d'idempotence et lease (`locked_until`).
- **Outbox transactionnelle** (`outbox_events`) : les effets (emails, notifications, jobs) sont
  écrits dans la même transaction que le changement d'état.
- **Diffusion temps réel** entre instances via `LISTEN/NOTIFY` (canal `agent_events`) : les
  événements sont persistés dans `agent_events` (identifiant monotone par workspace) puis notifiés ;
  chaque instance API relit la table à partir du dernier id servi.
- **Verrous/leases** : tables avec fencing token (`workspace_leases`, `run` lease).
- **Rate limiting** auth : compteurs en base (fenêtres fixes).

## Conséquences
Une dépendance d'infrastructure en moins (mémoire, HA, sauvegarde). Si la charge l'exige, un
adaptateur Redis pourra être ajouté pour la diffusion SSE sans changer les invariants.
