# Démarrage des sandboxes

**Administration → Sandboxes & previews → Script de démarrage**, réservé à l'administrateur
plateforme. Un **script unique**, commun à toutes les sandboxes de la plateforme, avec ou sans
dépôt, quel que soit l'utilisateur. Un changement s'applique **à partir du run suivant** de chaque
conversation.

Réglages : `sandbox.startupScript` (vide = aucun script) et `sandbox.setupTimeoutMinutes`
(20 minutes par défaut), via `PATCH /admin/settings`.

## Usage type

Configurer les registres et miroirs de l'entreprise, installer des outils communs :

```bash
npm config set registry https://npm.example.corp/
pip config set global.index-url https://pypi.example.corp/simple
mkdir -p ~/.m2 && cat > ~/.m2/settings.xml <<'XML'
<settings><mirrors><mirror><id>corp</id><mirrorOf>*</mirrorOf><url>https://maven.example.corp/</url></mirror></mirrors></settings>
XML
npm install -g pnpm@10
```

Les hôtes contactés doivent figurer dans le réseau sortant autorisé (`sandbox.egressAllowlist`,
même page), sinon les commandes échouent au proxy de sortie.

## Exécution

- **Où** : en bash (`set -e`, `pipefail`), dans `/workspace`, avec `HOME=/home/agent`, sans droits
  root. `npm install -g` installe dans `~/.local` (`NPM_CONFIG_PREFIX`, déjà dans le `PATH`).
- **Quand** : avant le premier message traité par Pi dans **chaque nouvelle sandbox**, et à nouveau
  quand le script ou l'image par défaut change. Il doit donc être **idempotent**.
- **Ce qui est conservé** : ce qu'il produit dans `/workspace` est conservé par un checkpoint. Le
  reste (`~/.npmrc`, `~/.config/pip`, `~/.m2`, outils globaux) vit avec la sandbox et est refait à
  la suivante.
- **Affichage** : sa sortie apparaît dans la conversation (« Préparation de l'environnement… »).
- **En cas d'échec** : le run continue et Pi est informé, avec la fin de la sortie.

## Identifiants

Le script est stocké en clair dans les réglages de la plateforme et s'exécute dans la sandbox :
l'agent peut lire les fichiers qu'il écrit (`~/.npmrc`…). N'y mettez que des identifiants **en
lecture seule**, à portée minimale (jeton de lecture d'un registre privé, par exemple).

## Image de sandbox

Toutes les sandboxes utilisent l'image **par défaut** déclarée dans **Administration → Sandboxes &
previews → Images officielles**. Changer l'image par défaut recrée chaque sandbox active, après un
checkpoint, au run suivant ; le script de démarrage est alors rejoué.
