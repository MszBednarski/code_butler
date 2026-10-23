# Pocket Butler deployment

This deployment uses private invite links, as requested for the simplest team setup. A teammate does not need a GitHub OAuth app or a personal access token. They authorize their own Codex subscription using its device-code flow.

- Repository: https://github.com/MszBednarski/code_butler
- Agent project: https://railway.com/project/a2204e4a-b82d-4c9e-8f42-552d96295ed1
- Agent URL: https://agent-host-production-1fb3.up.railway.app
- App project: https://railway.com/project/7b8fbb73-f78f-437f-aa06-cb562c092e11
- App URL: https://web-production-0846c.up.railway.app

## Architecture

`butler-agents` contains one always-on root container, `agent-host`, with one persistent volume at `/data`. PR environments are off. Each teammate has a separate HOME, git worktree, tmux session, ttyd UNIX socket, and Codex subscription login.

`butler-app` contains only `web`. PR environments are on. Both services are connected to the GitHub repository on main. Initial deployments were uploaded through the CLI. End-to-end PR previews and main autodeploys remain to be verified after the shared GitHub account is authorized.

Service settings are `/agent-host` and `/app` root directories respectively. Watch patterns are `/agent-host/**` and `/app/**`. The checked-in railway.json files match Railway's schema. The Railway API currently rejects setting legacy config-file paths, so equivalent settings are applied directly to the services instead.

## Persistent state and restarts

The host refuses to start in Railway without an actual mount at `/data`. The checked-in deployment config also declares `requiredMountPath: /data`.

- `/data/repo`: shared git repository and worktree metadata.
- `/data/wt/<name>`: each person's branch, tracked and uncommitted work.
- `/data/home/<name>/.codex`: each person's Codex login and conversations.
- `/data/home/<name>/.butler-task.md`: the agent's current goal, branch, PR, and next step.
- `/data/home/<name>/.butler-session`: marks a session to recreate automatically at boot.
- `/data/github`: the shared GitHub CLI login for pushes and PRs.
- `/data/invites.json`: hashed invite secrets and member identities.
- `/data/invite-links.json`: private links for the team lead to distribute.

A restart terminates running processes. Boot recreates previously active tmux sessions and launches `codex resume --last`; it never resets a worktree. Interrupted tools may need another request to continue. The volume must be retained across deployments; deleting the volume deletes its data.

## First login

Read `/data/invite-links.json` privately through Railway SSH. Open the `msz` link. The terminal first runs GitHub's device login: open the displayed GitHub URL, enter the code, and authorize as **MszBednarski**. This saves one shared GitHub login for repository pushes and PR creation. An optional `GH_TOKEN` can override this if preferred.

Next, Codex starts its device login. Open its displayed URL and enter the code in the browser using your own ChatGPT account. Codex credentials remain in that user's HOME. See the [official Codex device-login documentation](https://learn.chatgpt.com/docs/auth#login-on-headless-devices).

## Invites

The first boot prepares `msz` plus `teammate1` through `teammate4`. The generic slots work immediately; creating a named invite with a real GitHub login gives clearer commit attribution. Bootstrap runs only once and never recreates a revoked invite.

Using Railway SSH in `agent-host`:

```sh
# List member names; this does not print secrets.
node /srv/gateway/invites.js list

# Create or rotate an invite and print its private link.
node /srv/gateway/invites.js add alice AliceGitHubLogin

# Revoke access, including existing HTTP sessions and future WebSocket connections.
node /srv/gateway/invites.js revoke alice
```

Invites use 32 random bytes. The browser exchanges the secret from the URL fragment for a seven-day HttpOnly Secure SameSite cookie and removes the fragment from its address. Secrets are not sent as URL paths or query strings. Adding or revoking an invite does not redeploy the container.

## Variables

Required: `PORT=3000`, `PUBLIC_URL`, `GITHUB_REPO=MszBednarski/code_butler`, `APP_URL`, `SESSION_SECRET` (generated once, retained across redeploys), and `IS_SANDBOX=1`.

Also configured: `REQUIRE_PERSISTENT_VOLUME=1`, `BUTLER_TEAM_LEAD=msz`, `OWNER_LOGIN=MszBednarski`, and `AGENT_CMD=/usr/local/bin/run-agent codex`. GitHub CLI configuration uses `/data/github`. No GitHub OAuth app is needed. Do not commit secrets or invite links.

All three agents remain installed. Alternate launchers are `/usr/local/bin/run-agent claude` and `/usr/local/bin/run-agent gemini`. Docker build checks their required flags against actual `--help` output.

## GitHub autodeploy connection

The repo source and main branch are configured on both services, with PR environments enabled only in butler-app. If GitHub integration needs authorization, open the service → Settings → Source → Connect Repo. Authorize/install the Railway GitHub app for `MszBednarski/code_butler` if it is not visible, then select that repo and `main`. Preserve the configured root directory and watch paths. Only the app project has PR environments on; its Railway domain supplies preview domains. The token owner must be a project member for automatic PR deployments.

## Verification

```sh
cd app && npm ci && npm run typecheck && npm run build
cd ../agent-host/gateway && npm ci && npm test
cd .. && docker build -t pocket-butler-agents .
```

`test/runtime-check.mjs` is intended only for a disposable built-image container with `BUTLER_RUNTIME_TEST=1` and a named volume at `/data`. Run it in one container, remove that container, then run it in a fresh container on the same volume to check restoration. It uses a mock agent and simulated login/conversation files; actual subscription login is a live human check.

See [acceptance results](ACCEPTANCE.md).

## Known limits

Everyone shares a root container and can potentially read each other's files and account credentials. Use it only for a trusted team. Infrastructure changes restart the host. PRs appear under the shared GitHub account, with branch prefixes and commit authors identifying the requesting teammate. A reconciler is outside this setup.
