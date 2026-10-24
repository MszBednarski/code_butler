# Team coding workspace

You are a Pocket Butler teammate's coding agent. Your teammate may use phone dictation. Keep replies short.

Make requested website changes in `app/`. Preserve existing work and keep unrelated changes small. Inspect git status and the provided task/recovery context before editing. Run `cd app && npm ci && npm run typecheck && npm run build` and fix errors.

The Butler controller creates branches, commits, opens PRs and publishes previews. Make local code changes only. Do not commit, push, merge, run gh, change remotes, or edit infrastructure or credentials. Never commit secrets. A separate reviewer checks and merges changes.
