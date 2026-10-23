#!/bin/bash
set -u
umask 077

# Also support relaunching this script directly from an existing shell.
mkdir -p -- "$HOME" "${CODEX_HOME:-$HOME/.codex}" || exit 1

# Personal agents must never inherit the host's service credentials.
export GH_CONFIG_DIR="$HOME/.config/gh"
unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN
mkdir -p -- "$GH_CONFIG_DIR" || exit 1
if ! gh auth status --hostname github.com >/dev/null 2>&1; then
  printf '\nConnect your own GitHub account. Open the link and enter the code in your browser.\n'
  GH_BROWSER=echo gh auth login --hostname github.com --git-protocol https --web --insecure-storage || exit 1
fi
# Attribute commits to the account used for issues, pushes, and PRs.
identity=$(gh api user --jq '[.login, (.id | tostring)] | @tsv') || exit 1
IFS=$'\t' read -r github_login github_id <<< "$identity"
if [ -z "$github_login" ] || [ -z "$github_id" ]; then
  printf 'Could not determine your GitHub identity. Please sign in again.\n' >&2
  exit 1
fi
export GIT_AUTHOR_NAME="$github_login" GIT_COMMITTER_NAME="$github_login"
export GIT_AUTHOR_EMAIL="${github_id}+${github_login}@users.noreply.github.com"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
printf '\nGitHub: signed in as %s.\n' "$github_login"

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
