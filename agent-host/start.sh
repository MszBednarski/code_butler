#!/bin/bash
set -euo pipefail
umask 077

node /srv/gateway/server.js --check-env
mkdir -p /data/repo /data/wt /data/home /run/ttyd

if [ ! -d /data/repo/.git ]; then
  git clone "https://github.com/${GITHUB_REPO}" /data/repo
else
  git -C /data/repo fetch --prune origin
  git -C /data/repo worktree prune
fi

# Existing worktrees may contain uncommitted work. Never reset or check them out.
exec node /srv/gateway/server.js
