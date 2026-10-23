#!/bin/bash
set -u

case "${1:-claude}" in
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
