# ADR 0010 — Sandboxes, durcissement et réseau

- Statut : accepté — 2026-11-13

- `SandboxProvider` : `DockerSandboxProvider` (Compose / mono-hôte) et
  `KubernetesSandboxProvider` (Pods éphémères). Interface prête pour une implémentation microVM.
- Durcissement : utilisateur `agent` (uid 10001), `no-new-privileges`, `cap-drop ALL`, seccomp par
  défaut du runtime, `pids-limit`, limites CPU/RAM, rootfs en lecture seule sauf `/workspace`,
  `/workspace-state`, `/tmp`, `/home/agent` (volumes éphémères), aucun socket Docker monté.
- Réseau Docker `cap-sandbox` **`internal: true`** : seuls `gateway` (LLM + egress + git read) et
  `preview` y sont attachés. Kubernetes : NetworkPolicy deny-all + egress vers gateway uniquement.
- Seul le **worker** parle au moteur de conteneurs (socket Docker ou API Kubernetes avec un
  ServiceAccount restreint au namespace des sandboxes). Ce privilège est documenté comme risque.
- Inactivité : destruction après 15 min sans activité réelle (run actif, appel LLM, outil en
  cours, sauvegarde éditeur). Une page ouverte ne compte pas. Durée maximale de run configurable.
