#!/bin/bash
set -u
umask 077

# Also support relaunching this script directly from an existing shell.
mkdir -p -- "$HOME" "${CODEX_HOME:-$HOME/.codex}" || exit 1

# Never inherit a shared or deployment-wide GitHub credential.
unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN
export GH_CONFIG_DIR="$HOME/.config/gh"
mkdir -p "$GH_CONFIG_DIR" || exit 1
pat_file="$GH_CONFIG_DIR/repo-token"
if [ ! -s "$pat_file" ] || [ "${1:-}" = "github-token" ]; then
  printf '\nCreate a fine-grained GitHub PAT for %s only.\n' "$GITHUB_REPO"
  printf 'Grant Contents, Pull requests, and Issues read/write; no account permissions.\n'
  printf 'Paste the token here (hidden, never in chat): '
  IFS= read -r -s pat || exit 1
  printf '\n'
  printf '%s' "$pat" | node /srv/gateway/github-token.js || { unset pat; exit 1; }
  unset pat
fi
export GH_TOKEN="$(cat "$pat_file")"
if [ "${1:-}" = "github-token" ]; then
  printf 'Repository token updated. Restart your agent to use it.\n'
  exit 0
fi

case "${1:-codex}" in
  claude)
    claude --dangerously-skip-permissions --continue || claude --dangerously-skip-permissions
    ;;
  gemini)
    export NO_BROWSER=true
    gemini --yolo --resume latest || gemini --yolo
    ;;
  codex)
    # Device login works on a remote container without a localhost browser callback.
    if ! codex login status >/dev/null 2>&1; then
      codex login --device-auth || exit 1
    fi
    codex resume --last --dangerously-bypass-approvals-and-sandbox || codex --dangerously-bypass-approvals-and-sandbox
    ;;
  *)
    printf 'Unknown agent: %s (choose claude, gemini, or codex)\n' "$1" >&2
    exit 1
    ;;
esac
