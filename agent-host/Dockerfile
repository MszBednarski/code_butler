FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive IS_SANDBOX=1
RUN apt-get update && apt-get install -y --no-install-recommends \
      git tmux curl ca-certificates procps jq ripgrep less nano \
    && mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod a+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

ARG TTYD_VERSION=1.7.7
RUN test "$(dpkg --print-architecture)" = amd64 \
    && curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.x86_64" -o /usr/local/bin/ttyd \
    && chmod +x /usr/local/bin/ttyd \
    && ttyd --version

RUN npm i -g @anthropic-ai/claude-code @google/gemini-cli @openai/codex \
    && npm cache clean --force

# Fail the build if a CLI update removes a flag used by our launcher. Keep the
# help output in the image so deployments can be inspected without logging in.
RUN mkdir -p /usr/local/share/butler-agent-help \
    && claude --help > /usr/local/share/butler-agent-help/claude.txt \
    && gemini --help > /usr/local/share/butler-agent-help/gemini.txt \
    && codex --help > /usr/local/share/butler-agent-help/codex.txt \
    && codex login --help > /usr/local/share/butler-agent-help/codex-login.txt \
    && codex resume --help > /usr/local/share/butler-agent-help/codex-resume.txt \
    && grep -q -- '--dangerously-skip-permissions' /usr/local/share/butler-agent-help/claude.txt \
    && grep -q -- '--continue' /usr/local/share/butler-agent-help/claude.txt \
    && grep -q -- '--yolo' /usr/local/share/butler-agent-help/gemini.txt \
    && grep -q -- '--resume' /usr/local/share/butler-agent-help/gemini.txt \
    && grep -q -- '--dangerously-bypass-approvals-and-sandbox' /usr/local/share/butler-agent-help/codex.txt \
    && grep -q -- '--device-auth' /usr/local/share/butler-agent-help/codex-login.txt \
    && grep -q -- '--last' /usr/local/share/butler-agent-help/codex-resume.txt

RUN git config --system credential.https://github.com.helper '!gh auth git-credential'
COPY tmux.conf /etc/tmux.conf
WORKDIR /srv/gateway
COPY gateway/package.json gateway/package-lock.json ./
RUN npm ci --omit=dev
COPY gateway/ ./
COPY --chmod=755 start.sh /usr/local/bin/start.sh
COPY --chmod=755 run-agent.sh /usr/local/bin/run-agent

CMD ["/usr/local/bin/start.sh"]
