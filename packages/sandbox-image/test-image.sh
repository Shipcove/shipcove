#!/usr/bin/env bash
# Vérifications de l'image officielle (outils présents, utilisateur non privilégié, Pi épinglé).
set -euo pipefail
IMG="${1:-shipcove-sandbox:latest}"
run() { docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp --tmpfs /run/cap "$IMG" "$@"; }
[[ "$(run id -u)" == "10001" ]] || { echo "utilisateur non 10001"; exit 1; }
for t in git gh glab bash python3 pip3 uv node npm pi rg jq; do run sh -c "command -v $t >/dev/null" || { echo "outil manquant : $t"; exit 1; }; done
run pi --version
run node -e "require('playwright')" || { echo "playwright introuvable"; exit 1; }
run sh -c 'ls /opt/cap/browsers | grep -q chromium' || { echo "Chromium absent"; exit 1; }
for f in browser ask; do run test -f /opt/cap/pi-extension/$f.ts || { echo "plugin $f absent"; exit 1; }; done
[[ "$(run stat -c %U /home/agent)" == "agent" ]] || { echo "/home/agent non possédé par agent"; exit 1; }
run node --version
run sh -c 'mkdir -p /tmp/w/a && echo hi > /tmp/w/a/f && /opt/cap/bin/cap-snapshot scan /tmp/w' | grep -q '"h":"'
echo "Image $IMG : OK"
