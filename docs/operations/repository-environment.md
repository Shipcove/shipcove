# Environnement des sandboxes par dépôt

**Administration → Dépôts & environnements**, réservé à l'administrateur plateforme. Un dépôt y
apparaît dès qu'une conversation l'utilise. Son environnement est **partagé par toutes les
conversations sur ce dépôt**, quel que soit l'utilisateur. Un changement s'applique **à partir du
run suivant** de chaque conversation. Une conversation sans dépôt n'a ni variables ni script.

API : `GET /admin/repositories`, `GET|PUT /admin/repositories/:id/environment`,
`PUT /admin/repositories/:id/environment/variables`,
`DELETE /admin/repositories/:id/environment/variables/:varId`.

## Variables et secrets

- **Portée** : le dépôt (une seule portée).
- **Injection** : dans l'environnement du processus de l'agent, donc dans ses commandes et dans le
  script de préparation. La plateforme ne les écrit jamais sur disque : ils n'entrent ni dans les
  fichiers ni dans les checkpoints.
- **Secrets** :
  - stockés dans Vault (`env/repository/<id>/<nom>`), jamais renvoyés par l'API ni affichés ;
  - au moins 6 caractères : une valeur plus courte ne peut pas être masquée sans faux positifs ;
  - masqués (`***`) partout ailleurs : sorties d'outils, réponses de l'agent (y compris en flux
    continu, même coupés entre deux fragments), arguments d'outils, journaux de préparation, flux
    temps réel ;
  - retirés aussi des requêtes envoyées au fournisseur LLM.
- **Noms réservés refusés** : `PATH`, `HOME`, `*_PROXY`, `LD_*`, `CAP_*`, `PI_*`, certificats,
  `GIT_SSH*` / `GIT_CONFIG*`, etc. Ils permettraient de contourner les contrôles réseau ou de charger
  du code.
- **Limite inhérente**, comme pour les secrets de CI : l'agent de toute conversation sur le dépôt
  peut *utiliser* un secret. Il pourrait donc l'écrire dans un fichier ou l'envoyer vers un hôte autorisé
  en sortie. Réservez les secrets à des identifiants de développement ou de test, à portée minimale.

## Script de préparation

- **Exécution** : en bash (`set -e`, `pipefail`), dans `/workspace`, avec les variables du dépôt.
  Délai maximal : `sandbox.setupTimeoutMinutes`, 20 minutes par défaut.
- **Quand il est rejoué** : dans **chaque nouvelle sandbox** et **à chaque modification** du script
  ou de l'image. Il doit donc être **idempotent**, comme une étape de CI : `npm ci`,
  `pip install -r requirements.txt`, etc.
- **Ce qui est conservé** : ce qu'il produit dans `/workspace` est conservé par un checkpoint. Le
  reste (outils globaux, `~/.local`) vit avec la sandbox et sera réinstallé à la suivante.
- **Affichage** : sa sortie (secrets masqués) apparaît dans la conversation.
- **En cas d'échec** : le run continue et l'agent est informé, avec la fin de la sortie.

## Image de sandbox

Le dépôt peut utiliser une des images **actives** déclarées par l'administrateur plateforme
(**Administration → Sandboxes**). Une image se rend disponible sans devenir l'image par défaut via
`POST /admin/sandbox-images/:id/activate` avec `{ "makeDefault": false }`. Changer d'image recrée la
sandbox, après un checkpoint, au run suivant. Le script de préparation est alors rejoué.
