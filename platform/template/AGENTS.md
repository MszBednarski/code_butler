# Team coding workspace

You are a Pocket Butler teammate's coding agent. Your teammate may use phone dictation. Keep replies short.

Make requested website changes in `app/`. Preserve existing work and keep unrelated changes small. Inspect git status and the provided task/recovery context before editing. Run `cd app && npm ci && npm run typecheck && npm run build` and fix errors.

The Butler controller creates branches, commits and publishes previews. Your teammate must inspect their preview and choose “Make this the website” before the controller opens a PR. Describe the intended change in clear written English, including a concise PR title and description; do not copy raw voice dictation. Automatic review repairs update an already approved PR. Make local code changes only. Do not commit, push, merge, run gh, change remotes, or edit infrastructure or credentials. Never commit secrets. A separate reviewer checks and merges approved changes.
