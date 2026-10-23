# Automatic PR reviewer

The team lead authorized the reviewer to review, fix straightforward conflicts, and merge pull requests. It runs on the existing Railway agent host and checks for work every 30 seconds. Its build-only check service is in the separate butler-checks Railway project; it has no agent secrets or volume and stops after the image check.

The controller uses GitHub account `copiumnicus`; AI reviews use the team lead's already authenticated Codex subscription. Reviews are ephemeral and do not become the personal agent's latest conversation. Its checkout, verdicts, test logs, and processed revisions are stored separately under `/data/reconciler`.

For each non-draft PR targeting `main`, it:

1. Combines the PR with current main in its own checkout.
2. Asks Codex to inspect the diff and surrounding code. Straightforward bugs or conflicts may be fixed; ambiguity or blocking findings leave the PR open.
3. Runs app dependency installation, TypeScript/build, and gateway/reviewer tests.
4. Pushes the tested candidate back to the PR using a normal fast-forward push. Concurrent author changes cannot be overwritten; the reviewer never force-pushes.
5. Builds the agent-host Docker image on Railway (cached by the exact agent-host tree), then checks any other GitHub statuses. It publishes butler/validated-merge only after these checks pass. GitHub Actions is not required; the account currently has an Actions billing lock.
6. Rechecks the head, base, draft status, and open state; posts a review and squash-merges only if they still match the tested candidate.

If main or the author changes the code during review, it retries. If tests or review fail, it leaves an explanation on the PR and waits for changes. Transient service failures retry automatically. Successful review/build checkpoints persist, so retrying external checks does not create duplicate commits or consume another AI review. PRs labelled `hold` or `do-not-merge`, and current commits with an outstanding changes-requested review, stay open. Fork PRs require a human review before executing their code on the shared host.

Configure Railway's agent-host variables:

```text
RECONCILER_ENABLED=1
RECONCILER_CODEX_HOME=/data/home/msz/.codex
RECONCILER_INTERVAL_SECONDS=30
RECONCILER_GITHUB_TOKEN=<copiumnicus GitHub credential with repo write access>
RECONCILER_RAILWAY_TOKEN=<project token scoped to butler-checks production>
RECONCILER_CI_PROJECT=55b39467-0aa4-4893-9998-42f0e88e7ed7
RECONCILER_CI_SERVICE=62fcbafb-b46c-417f-88cb-dd1e6fd6c8b9
RECONCILER_CI_ENVIRONMENT=5bdf8c2e-8689-4882-a80c-5ec77f713f2a
```

Set the token through Railway's secret editor or CLI stdin, never in git or chat. The gateway removes both reviewer token variables from its child environment before starting personal agents. The Codex review subprocess and test commands are not passed the reviewer's GitHub token.

To pause merges without restarting the host, use Railway SSH:

```sh
touch /data/reconciler/paused
```

To resume, remove that file. Set `RECONCILER_ENABLED=0` to disable the worker on the next deployment. Logs have a `[reviewer]` prefix in Railway; detailed per-PR logs and state are on the volume. Removing a PR's cached entry from `/data/reconciler/state.json` requests another review of the same revision after a reviewer restart.

This is a trusted-team automation. Tests and AI review reduce mistakes but cannot guarantee that every product requirement or runtime bug is caught. Main requires a PR and the strict/up-to-date butler/validated-merge status, including for administrators. This server-side rule rejects a merge if main moves after the client checks it. GitHub protections still apply; the reviewer does not bypass required approvals or failed checks.
