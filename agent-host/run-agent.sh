#!/bin/bash
set -u

# One shared GitHub authorization for repository pushes and PRs. Each person's
# Codex account remains separate under their own HOME/CODEX_HOME.
if ! gh auth status --hostname github.com >/dev/null 2>&1; then
  if [ "${BUTLER_USER:-}" = "${BUTLER_TEAM_LEAD:-msz}" ]; then
    printf '\nConnect the team GitHub account once. Open the link and enter the code in your browser.\n'
    GH_BROWSER=echo gh auth login --hostname github.com --git-protocol https --web --insecure-storage || exit 1
  else
    printf '\nThe team lead still needs to connect GitHub before agents can push and open PRs.\n'
  fi
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
