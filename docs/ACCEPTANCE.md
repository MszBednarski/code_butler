# Acceptance checks

Record PASS, FAIL, or PENDING with evidence when deploying. Automated local checks use isolated test accounts and a fake coding agent; actual GitHub OAuth, account login, Railway preview generation, and phone interaction need live checks.

| Check | Status | Evidence |
| --- | --- | --- |
| App builds and TypeScript checks | PASS | `npm run typecheck` and `npm run build`, Node 22 |
| Railway key names and values match the live JSON schema | PASS | Both configs validated against the fetched schema with Draft202012Validator, including an explicit check for unknown keys |
| Image builds; all three agent flags and Codex device login are supported | PASS | Built image: Claude 2.1.309, Gemini 0.65.0, Codex 0.164.0, ttyd 1.7.7, tmux 3.3a; all `--help` assertions pass |
| HTTP and WebSocket authentication, allowlist, Origin, session expiry, and terminal routing | PASS | Eight gateway tests, including mocked GitHub OAuth and real HTTP/WebSocket proxies to separate UNIX sockets |
| Real tmux sessions, worktrees, safe simultaneous paste, ttyd respawn, disk persistence | PASS | `agent-host/test/runtime-check.mjs` passed in a disposable built-image container before and after restart; used a mock terminal agent and simulated credential file |
| APP_URL loads on a phone, displays commit SHA, and adds to home screen | PENDING | Human phone check after deployment |
| AGENTS_URL → GitHub login → agent in `/data/wt/<name>` | PENDING | Live OAuth and Codex account login |
| Non-team GitHub account receives 403 | PENDING | Live login with another GitHub account |
| Unauthenticated `/term/` and WebSocket are rejected | PENDING | Live HTTP and upgrade requests |
| Two teammates see separate sessions; URL edits cannot switch sessions | PENDING | Two live browsers/accounts |
| Dictated text reaches the agent and submits from a phone | PENDING | Human dictation check |
| “change the heading to Hello Team” creates `<name>/…` PR, preview comment, and agent relays URL | PENDING | Live agent request |
| Merging that PR updates APP_URL without restarting agent-host | PENDING | Merge with reconciler or human; compare deployment timestamps |
| Redeploying agent-host preserves worktree, agent login, and resumes conversation | PENDING | Redeploy after first login and reopen |
