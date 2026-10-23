# Acceptance checks

Record PASS, FAIL, or PENDING with evidence when deploying. Automated local checks use isolated test accounts and a fake coding agent; actual GitHub device authorization, Codex login, Railway preview generation, and phone interaction need live checks.

| Check | Status | Evidence |
| --- | --- | --- |
| App builds and TypeScript checks | PASS | `npm run typecheck` and `npm run build`, Node 22 |
| Railway key names and values match the live JSON schema | PASS | Both configs validated against the fetched schema with Draft202012Validator, including an explicit check for unknown keys |
| Image builds; all three agent flags and Codex device login are supported | PASS | Built image: Claude 2.1.309, Gemini 0.65.0, Codex 0.164.0, ttyd 1.7.7, tmux 3.3a; all `--help` assertions pass |
| HTTP and WebSocket invite authentication, revocation, Origin, session expiry, and terminal routing | PASS | Eight gateway tests, including invite rotation/revocation, secure cookies, and real HTTP/WebSocket proxies to separate UNIX sockets |
| Real tmux sessions, worktrees, safe simultaneous paste, ttyd respawn, disk persistence | PASS | Deleted the first container and ran a fresh one on the same named volume: sessions restored before page access, dirty work/branch/credential/conversation/task-note files preserved; used a mock agent and simulated account files |
| APP_URL loads on a phone, displays commit SHA, and adds to home screen | PENDING | Human phone check after deployment |
| AGENTS_URL → private invite → agent in `/data/wt/<name>` | PENDING | Live invite exchange and Codex account login |
| Invalid or revoked invite receives 403 | PENDING | Live invalid-invite request |
| Unauthenticated `/term/` and WebSocket are rejected | PENDING | Live HTTP and upgrade requests |
| Two teammates see separate sessions; URL edits cannot switch sessions | PENDING | Two live invite sessions |
| Dictated text reaches the agent and submits from a phone | PENDING | Human dictation check |
| “change the heading to Hello Team” creates `<name>/…` PR, preview comment, and agent relays URL | PENDING | Live agent request |
| Merging that PR updates APP_URL without restarting agent-host | PENDING | Merge with reconciler or human; compare deployment timestamps |
| Redeploying agent-host preserves worktree, agent login, and resumes conversation | PENDING | Redeploy after first login and reopen |

Persistent-volume startup guard: PASS locally; a container without a /data mount exited with a clear error. The Railway volume is attached at /data.
