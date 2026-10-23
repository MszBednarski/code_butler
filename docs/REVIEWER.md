# Automatic PR reviewer

The team lead authorized the reviewer to review, fix straightforward conflicts, and merge pull requests. It runs on the existing Railway agent host and checks for work every 30 seconds. No extra service or volume is needed.

The controller uses GitHub account `copiumnicus`; AI reviews use the team lead's already authenticated Codex subscription. Reviews are ephemeral and do not become the personal agent's latest conversation. Its checkout, verdicts, test logs, and processed revisions are stored separately under `/data/reconciler`.

For each non-draft PR targeting `main`, it:

1. Combines the PR with current main in its own checkout.
2. Asks Codex to inspect the diff and surrounding code. Straightforward bugs or conflicts may be fixed; ambiguity or blocking findings leave the PR open.
3. Runs app dependency installation, TypeScript/build, and gateway/reviewer tests.
4. Pushes the tested candidate back to the PR using a normal fast-forward push. Concurrent author changes cannot be overwritten; the reviewer never force-pushes.
5. Waits for GitHub CI, including the full agent-host Docker build. It recognizes checks on both the head and GitHub's temporary merge commit.
6. Rechecks the head, base, draft status, and open state; posts a review and squash-merges only if they still match the tested candidate.

If main or the author changes the code during review, it retries. If tests or review fail, it leaves an explanation on the PR and waits for changes. PRs labelled `hold` or `do-not-merge`, and current commits with an outstanding changes-requested review, stay open. Fork PRs require a human review before executing their code on the shared host.

Configure Railway's agent-host variables:

```text
RECONCILER_ENABLED=1
RECONCILER_CODEX_HOME=/data/home/msz/.codex
RECONCILER_INTERVAL_SECONDS=30
RECONCILER_GITHUB_TOKEN=<copiumnicus GitHub credential with repo write access>
```

Set the token through Railway's secret editor or CLI stdin, never in git or chat. The gateway removes this variable from its child environment before starting personal agents. The Codex review subprocess and test commands are not passed the reviewer's GitHub token.

To pause merges without restarting the host, use Railway SSH:

```sh
touch /data/reconciler/paused
```

To resume, remove that file. Set `RECONCILER_ENABLED=0` to disable the worker on the next deployment. Logs have a `[reviewer]` prefix in Railway; detailed per-PR logs and state are on the volume. Removing a PR's cached entry from `/data/reconciler/state.json` requests another review of the same revision after a reviewer restart.

This is a trusted-team automation. Tests and AI review reduce mistakes but cannot guarantee that every product requirement or runtime bug is caught. GitHub protections still apply; the reviewer does not bypass required approvals or failed checks.
