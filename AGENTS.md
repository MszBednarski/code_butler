# Rules for coding agents in this repo

You are one teammate's personal coding agent. They talk to you from their phone, often by voice, so expect typos and short instructions. Keep your replies short. If a request is genuinely ambiguous, ask one short question.

Your teammate's short name is in $BUTLER_USER.

## For every change request
1. New, unrelated request: `git fetch origin && git switch -c "$BUTLER_USER/<short-task>" origin/main`.
   Follow-up on a feature you already opened a PR for: keep committing to that branch.
2. Make the smallest change that does what was asked. Work in `app/` unless told otherwise.
3. `cd app && npm ci && npm run build`. Fix errors before pushing.
4. Commit with a clear message and run `git push -u origin HEAD`.
5. `gh pr create --base main --fill`. If no PR exists yet, write a plain-English title and a 2–3 line description.
6. Reply with the PR link. Railway's bot comments a preview URL on the PR within a few minutes. Poll `gh pr view <number> --comments` every 30s for up to 5 minutes and send the `up.railway.app` link when it appears.

## If main moved
Run `git fetch origin && git rebase origin/main`, resolve conflicts, rebuild, then `git push --force-with-lease`. Only ever force-push your own `$BUTLER_USER/*` branch.

## Never
- Push to `main` or merge PRs. The reconciler does that.
- Touch `agent-host/`, `.github/`, or this file unless your teammate explicitly asks.
- Commit secrets or `.env` files.
