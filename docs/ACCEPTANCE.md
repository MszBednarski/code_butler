# Acceptance checks

Record PASS, FAIL, or PENDING with evidence when deploying. Automated local checks use isolated test accounts and a fake coding agent; actual GitHub device authorization, Codex login, Railway preview generation, and phone interaction need live checks.

| Check | Status | Evidence |
| --- | --- | --- |
| App builds and TypeScript checks | PASS | `npm run typecheck` and `npm run build`, Node 22 |
| Railway key names and values match the live JSON schema | PASS | Both configs validated against the fetched schema with Draft202012Validator, including an explicit check for unknown keys |
| Image builds; all three agent flags and Codex device login are supported | PASS | Built image: Claude 2.1.309, Gemini 0.65.0, Codex 0.164.0, ttyd 1.7.7, tmux 3.3a; all `--help` assertions pass |
| Fresh Codex profiles load before account login | PASS | Real `codex login status` in two fresh persistent homes reaches “Not logged in”, without configuration errors; provisioning and the launcher create CODEX_HOME first |
| Shared GitHub account has repo access | PASS | Live GitHub API returned MszBednarski with push and admin permission on MszBednarski/code_butler |
| HTTP and WebSocket invite authentication, revocation, Origin, session expiry, and terminal routing | PASS | Eight gateway tests, including invite rotation/revocation, secure cookies, and real HTTP/WebSocket proxies to separate UNIX sockets |
| Real tmux sessions, worktrees, safe simultaneous paste, ttyd respawn, disk persistence | PASS | Deleted the first container and ran a fresh one on the same named volume: sessions restored before page access, dirty work/branch/credential/conversation/task-note files preserved; used a mock agent and simulated account files |
| APP_URL loads on a phone, displays commit SHA, and adds to home screen | PENDING | Human phone check after deployment |
| AGENTS_URL → private invite → agent in `/data/wt/<name>` | PASS | Live msz workspace runs Codex 0.164.0 in /data/wt/msz; `codex login status` confirms ChatGPT subscription login |
| Invalid invite receives 403 | PASS | Live POST returned 403; rotation and revocation are also covered by local tests |
| Unauthenticated `/term/` and WebSocket are rejected | PASS | Live terminal HTTP returned 401; live WebSocket upgrade was rejected |
| Two teammates have separate sessions; URL edits cannot switch sessions | PASS | Live msz and teammate1 workspaces and distinct /api/me identities; cookie routing and URL tampering also covered by gateway tests |
| Send box reaches the real Codex agent and submits | PASS | Live /api/send submitted a no-edit prompt; real Codex replied BUTLER_READY |
| Phone dictation works | PENDING | Human native-keyboard dictation check |
| Feature branch pushes, PR creation, and Railway preview | BLOCKED | Cloud host built and pushed msz/setup-preview-check and opened PR #1 as MszBednarski. Railway rejects deployment trigger creation because no project member has contributor access to the repo; preview automation needs access fixed |
| Merging a PR automatically updates APP_URL without restarting agent-host | BLOCKED | Same Railway contributor-access requirement blocks main autodeploy; PR #1 remains open and unmerged for verification |
| Saved Codex login and conversation resume after process restart | PASS | Restarted msz Codex using the normal launcher; login stayed valid and a new prompt recalled the prior BUTLER_READY reply |
| Full-container replacement preserves work and starts active agents | PASS | Docker replacement test preserves dirty branch/work/history/auth storage and recreates both sessions; live Railway redeploy recreated msz automatically and kept the cookie valid. Full host restart with the now-authenticated subscription has not been repeated while teammates are joining |

Persistent-volume startup guard: PASS locally; a container without a /data mount exited with a clear error. The Railway volume is attached at /data.

Live Railway checks: PASS health endpoint, login page, msz and teammate1 invite exchange, separate /api/me identities, and invalid-Origin rejection. Live redeployment 6b874742-e48a-459e-b9a5-b60711e36e62 succeeded and logged “Restored 1 team agent sessions from persistent storage”.

Codex startup fix deployed as 04d0915 in Railway deployment a8e89cc9-0fc8-47b3-9caa-37526f9b9295. Fresh teammate profiles create CODEX_HOME before any Codex command runs.

PR #1: https://github.com/MszBednarski/code_butler/pull/1 . Verification used a separate setup worktree, leaving the personal msz worktree unchanged.

Railway access blocker: the authenticated Railway user is mechanicus, linked to GitHub copiumnicus. That GitHub account currently has read access to the repo. Both deploymentTriggerCreate calls return: “Cannot create deployment trigger for MszBednarski/code_butler because no one in the project has access to it”. The app PR base environment is now explicitly production.
