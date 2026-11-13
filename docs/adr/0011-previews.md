# ADR 0011 — Previews

- Statut : accepté — 2026-11-13

- Origine distincte : `https://<port>-<workspaceShortId>.<PREVIEW_DOMAIN>` (en dev,
  `*.preview.localhost`). Jamais le domaine de l'application → aucun cookie principal envoyé.
- Accès : l'utilisateur obtient depuis l'API un lien contenant un jeton signé court (60 s) ;
  la preview gateway l'échange contre un cookie propre au sous-domaine (`HttpOnly`, `Secure`,
  `SameSite=Lax`), lié à l'utilisateur, au workspace et au port. Le propriétaire seul y a accès
  (un partage de conversation ne donne pas accès aux previews).
- Limite : 3 ports par workspace par défaut, configurable (`preview_ports` + politique admin).
- Destinations : uniquement l'IP de la sandbox du workspace et le port enregistré (pas de SSRF).
