#!/bin/bash
set -euo pipefail
umask 077
export GH_CONFIG_DIR=/data/github
export GH_BROWSER=echo

# Refuse to serve real users from a container's disposable filesystem.
if [ -n "${RAILWAY_ENVIRONMENT_ID:-}" ] || [ "${REQUIRE_PERSISTENT_VOLUME:-0}" = 1 ]; then
  if ! awk '$5 == "/data" { found=1 } END { exit !found }' /proc/self/mountinfo; then
    echo 'Agent host requires a persistent volume mounted at /data; refusing to start without it.' >&2
    exit 1
  fi
fi

node /srv/gateway/server.js --check-env
mkdir -p /data/repo /data/wt /data/home /run/ttyd
mkdir -p "$GH_CONFIG_DIR"
node /srv/gateway/invites.js bootstrap

if [ ! -d /data/repo/.git ]; then
  git clone "https://github.com/${GITHUB_REPO}" /data/repo
else
  git -C /data/repo fetch --prune origin
  git -C /data/repo worktree prune
fi

# Existing worktrees may contain uncommitted work. Never reset or check them out.
exec node /srv/gateway/server.js
