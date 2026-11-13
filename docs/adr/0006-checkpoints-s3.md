# ADR 0006 — Checkpoints incrémentaux sur S3 (Garage)

- Statut : accepté — 2026-11-13

## Décision
- Objets **adressés par contenu** : `objects/<sha256>` (dédupliqués entre checkpoints).
- **Manifeste** JSON versionné par workspace : `workspaces/<id>/manifests/<generation>.json`
  listant pour chaque racine (`/workspace`, `/workspace-state`) : chemin, type (fichier, lien,
  dossier), mode, taille, mtime, sha256. Le dépôt Git (`.git` : index, objets, refs) et les
  changements non commités sont des fichiers comme les autres, donc capturés fidèlement.
- Détection des écritures **réelles** du système de fichiers : un utilitaire dans l'image
  (`cap-snapshot`) parcourt l'arborescence, réutilise le hash si (taille, mtime, inode) sont
  inchangés par rapport au manifeste précédent, sinon recalcule ; il renvoie la liste et un tar des
  fichiers modifiés. Les écritures via shell sont donc couvertes, pas seulement `write`/`edit`.
- Déclenchement : après **chaque** résultat d'outil de Pi (hook bloquant de l'extension), après
  chaque sauvegarde de l'éditeur, en fin de run et périodiquement si des processus de fond écrivent.
- Publication : upload des objets manquants → vérification (HEAD + taille, sha recalculé à
  l'upload) → écriture du manifeste → `UPDATE workspaces SET current_snapshot … WHERE
  lease_token = :fencing`. Un writer périmé échoue sur le fencing token.
- Échec : état `unsynced` visible, retry avec backoff, notification ; la destruction de la sandbox
  est refusée tant qu'un checkpoint réussi ne couvre pas les dernières écritures.
- Restauration : lease exclusif → dernier manifeste validé → téléchargement + vérification sha256
  → extraction dans la sandbox → lancement de Pi avec la session restaurée.
- Pas d'UI de navigation des versions (exigence) ; le panneau « Modifications » compare
  uniquement des manifestes pour afficher des diffs.
