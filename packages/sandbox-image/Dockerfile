# Image officielle des sandboxes — versionnée, verrouillée, testée (SPEC §10).
# Contient : Pi (harness), Git, gh, glab, Bash, Python, pip, uv, Node.js LTS, npm, Playwright + Chromium, utilitaires.
# npm est présent pour les PROJETS DES UTILISATEURS uniquement (la plateforme utilise pnpm).
ARG NODE_IMAGE=node:26-bookworm-slim
FROM ${NODE_IMAGE}

ARG PI_VERSION=0.73.1
ARG GH_VERSION=2.104.0
ARG GLAB_VERSION=1.130.0
ARG UV_VERSION=0.13.8
ARG PLAYWRIGHT_VERSION=1.64.1
ARG TARGETARCH=amd64

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PI_OFFLINE=1 \
    PI_SKIP_VERSION_CHECK=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    UV_CACHE_DIR=/home/agent/.cache/uv \
    PLAYWRIGHT_BROWSERS_PATH=/opt/cap/browsers \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NODE_PATH=/usr/local/lib/node_modules \
    npm_config_cache=/home/agent/.npm

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git git-lfs jq less make g++ openssh-client procps \
      python3 python3-pip python3-venv ripgrep fd-find unzip xz-utils zip file tini \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*

# gh (GitHub CLI) et glab (GitLab CLI) — binaires officiels, versions épinglées.
RUN curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz" -o /tmp/gh.tgz \
 && tar -xzf /tmp/gh.tgz -C /tmp && install -m 0755 /tmp/gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh /usr/local/bin/gh \
 && curl -fsSL "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_${TARGETARCH}.tar.gz" -o /tmp/glab.tgz \
 && mkdir -p /tmp/glab && tar -xzf /tmp/glab.tgz -C /tmp/glab && install -m 0755 /tmp/glab/bin/glab /usr/local/bin/glab \
 && UV_ARCH=$([ "$TARGETARCH" = "arm64" ] && echo aarch64 || echo x86_64) \
 && curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${UV_ARCH}-unknown-linux-gnu.tar.gz" -o /tmp/uv.tgz \
 && tar -xzf /tmp/uv.tgz -C /tmp && install -m 0755 /tmp/uv-${UV_ARCH}-unknown-linux-gnu/uv /tmp/uv-${UV_ARCH}-unknown-linux-gnu/uvx /usr/local/bin/ \
 && rm -rf /tmp/*

# Navigateur pour les captures d'écran et les tests d'interface : Playwright (épinglé) et son
# Chromium headless, avec polices et dépendances système. Utilisé par le plugin Pi « browser »
# (/opt/cap/pi-extension/browser.ts) et disponible pour les scripts de l'agent (NODE_PATH).
RUN npm install -g "playwright@${PLAYWRIGHT_VERSION}" \
 && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD= playwright install --with-deps --only-shell chromium \
 && apt-get install -y --no-install-recommends fonts-noto-color-emoji fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/* /root/.npm \
 && chmod -R a+rX /opt/cap/browsers

# Harness Pi (version épinglée).
RUN npm install -g --omit=dev "@mariozechner/pi-coding-agent@${PI_VERSION}" && npm cache clean --force

# Utilisateur non privilégié.
# (le cache npm de l'installation globale, créé en root dans /home/agent, est supprimé)
RUN rm -rf /home/agent/.npm \
 && groupadd -g 10001 agent && useradd -u 10001 -g 10001 -m -d /home/agent -s /bin/bash agent \
 && mkdir -p /workspace /workspace-state /opt/cap /home/agent/.pi/agent \
 && chown -R agent:agent /workspace /workspace-state /home/agent

# Composants plateforme (lecture seule pour l'agent : rootfs read-only à l'exécution).
COPY --chown=root:root bin/ /opt/cap/bin/
COPY --chown=root:root pi-extension/ /opt/cap/pi-extension/
COPY --chown=root:root config/gitconfig /etc/gitconfig
RUN chmod 0755 /opt/cap/bin/* && chmod -R a+rX /opt/cap

USER 10001:10001
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/opt/cap/bin/sandbox-init"]

LABEL org.opencontainers.image.title="cap-sandbox" \
      org.opencontainers.image.description="Image officielle des sandboxes Shipcove" \
      cap.pi.version="${PI_VERSION}"
