FROM node:22-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive IS_SANDBOX=1 CODEX_HOME=/data/codex
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates procps ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @openai/codex@0.164.0 \
    && codex login --help | grep -q -- --device-auth \
    && codex exec --help | grep -q -- --json \
    && git config --system credential.helper '!node /srv/git-credential.mjs' \
    && git config --system user.name 'Pocket Butler' \
    && git config --system user.email 'butler@users.noreply.github.com'
WORKDIR /srv
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY *.mjs verdict.schema.json change.schema.json ./
CMD ["node", "server.mjs"]
