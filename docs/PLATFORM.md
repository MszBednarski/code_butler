# Instant teams

The product direction and acceptance demo are tracked in [issue #9](https://github.com/MszBednarski/code_butler/issues/9).

Pocket Butler gives a lead one place to connect GitHub, Railway and an existing Codex subscription. Teammates open an invitation, choose a name and start asking for website changes. They need no provider accounts or repository permissions.

## Run the new platform

Build from the repository root:

```sh
docker build -f platform/Dockerfile -t butler-platform .
docker volume create butler-platform-data
docker run --rm -p 3000:3000 -v butler-platform-data:/data \
  -e PUBLIC_URL=http://localhost:3000 \
  -e GITHUB_OAUTH_CLIENT_ID -e GITHUB_OAUTH_CLIENT_SECRET \
  -e RAILWAY_OAUTH_CLIENT_ID -e RAILWAY_OAUTH_CLIENT_SECRET \
  butler-platform
```

For development, start the backend with `DATA_DIR=/tmp/butler-dev PUBLIC_URL=http://localhost:5173 npm --prefix platform start`, then `npm --prefix app run dev`. Vite proxies `/api` and `/auth` to port 3000. Install dependencies with `npm ci` in each package first. Validate with `./scripts/check.sh` on Node 22.13 or later. Node's built-in SQLite module may print its experimental-feature notice.

## Deploy Butler itself on Railway

Create a **separate** Railway project called `butler-platform`, with one service `web` and a persistent volume mounted at `/data`. Use the repo root as the build context. The root `Dockerfile` builds the platform; `platform/Dockerfile` is the equivalent explicit build path. `platform/railway.json` documents the equivalent build settings. Configure one replica, healthcheck `/healthz`, and sleeping off. Generate a public domain and set `PUBLIC_URL=https://<domain>` with no trailing slash. `PORT=3000` is a safe default; set the generated domain's target port to match.

The platform keeps its database and encryption key on `/data`. Both must survive redeploys. Its mount guard refuses to start on Railway without that volume. Back up the complete volume, including `master.key` and the SQLite/WAL files. Do not copy keys into git or deployment logs.

A deployment can serve the landing page before provider integrations have been configured. The API reports which connections are available; unavailable connections are disabled in the interface.

## Register the integrations once, as the operator

These steps are performed once for the Butler installation, never by each team. The operator provisions an opaque `SETUP_TOKEN` and opens `PUBLIC_URL/setup#token=<token>`. The token stays out of URLs sent to the server; setup API calls require it plus the correct browser origin. The setup page has clickable registration links, copyable callback URLs and two credential forms. Its settings persist encrypted across restarts. The operator can revoke the link through `/api/setup/finish`; changing `SETUP_TOKEN` deliberately enables a new link. GitHub/Railway OAuth client environment variables remain supported for automated installations.

### GitHub

1. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.
2. Homepage URL: the Butler `PUBLIC_URL`.
3. Authorization callback URL: `PUBLIC_URL/auth/github/callback`.
4. Generate a client secret. Paste the client ID and secret into the GitHub card on Butler’s private installation page and click Save GitHub.

The lead's project setup requests `read:user repo`; teammates who optionally save access with GitHub request only `read:user`. Repository creation, hooks and PRs happen through the backend. The current MVP uses an OAuth app; the `repo` scope is broad. Tokens are encrypted in the platform database, never returned to browsers or copied into project workers. A GitHub App with repository-scoped grants remains a future hardening path; teammates must never be asked for PATs.

### Railway

1. Railway → workspace settings → Developer → New OAuth App.
2. Add redirect URI `PUBLIC_URL/auth/railway/callback`.
3. Paste the client ID and secret into the Railway card on Butler’s private installation page and click Save Railway.

Butler requests `openid email profile offline_access workspace:admin`. During consent the lead selects the workspace Butler may manage. Offline access allows remembered connections and refresh-token rotation. If multiple workspaces are granted, the lead chooses one in project creation.

The private installation page encrypts the credentials on the persistent volume and applies them immediately. No Railway variable editing or redeployment is needed to save these connections. No existing teammate host needs to restart.

Optional email sign-in uses `RESEND_API_KEY` and `EMAIL_FROM`. Without it, teammates can save their durable private sign-in link or optionally use GitHub. No email-provider setup is required for the primary experience.

## What happens for each team

1. The lead signs into Butler with GitHub, connects Railway and describes a new project.
2. Butler creates a private GitHub repo containing the web-app template. It creates separate Railway **app** and **agents** projects. The agent service has its own persistent volume; only the app project receives preview environments.
3. The lead can share the QR immediately. Requests are durably queued while infrastructure is building.
4. In the project, the lead clicks **Connect Codex**. The worker runs `codex login --device-auth`; Butler shows its authorization link and code. The lead completes sign-in in their browser. If necessary, enable device-code login in ChatGPT Settings → Security first.
5. The login is stored under the worker's persistent `/data/codex`. Coding and reviewing use that project host's subscription login, not an OpenAI API key. GitHub and Railway connections are remembered at the account level; Codex is authorized for each newly provisioned host and retained across visits/redeploys.
6. Each member has a persistent identity, home, git worktree and explicit Codex conversation ID. The small MVP worker runs coding and review jobs sequentially within a project. This keeps subscription use bounded by one active coding/review task and avoids conversation/auth-refresh races.
7. The controller builds the app, commits and opens a PR. A separate reviewer conversation checks the proposed merge into current main, builds it, publishes the tested merge candidate to the PR without force-pushing, waits for a working preview and other checks, and squash-merges.
8. Butler stages clean app copies from exact commits, strips source-controlled Railway IaC/configuration before invoking its credentialed uploader from a trusted directory, and uploads snapshots to Railway for PR previews and production. It adds preview URLs to the PR and project interface. Main publishing uses a GitHub webhook and the controller's durable deployment queue. This does not depend on GitHub Actions or Railway's separate GitHub App connection.

## Recovery and access

Accepted requests, messages, memberships and background tasks are stored in SQLite. Requests have idempotency keys; worker leases allow interrupted requests to be claimed again. Task records and explicit conversation IDs are persisted before publishing. Existing teammate worktrees are never reset or cleaned; only the reviewer's disposable checkout is reset. A failed request preserves its branch, edits and conversation for a follow-up.

Team invitations create a different member identity for each browser/person, not a shared terminal. Cookies restore the same workspace on that browser. **Save access** supplies a private sign-in link that restores the account on another device. Email/GitHub linking keeps the existing member work. Replacing the team invitation prevents new joins with the old invitation and retains current members.

Only the lead can retrieve team invitations or start/view device authentication. All browser writes require the configured origin. Worker APIs require a project-specific credential. The git bridge is restricted to that project's repository and keeps the owner's GitHub token in the platform. Coding/build subprocesses receive a small environment without the worker credential or GitHub/Railway tokens.

Project workers are separate containers and volumes for different teams. Within one team, agents run as root in a shared container and are suitable for trusted teammates, not hostile users. Separate worktrees are not an OS security boundary. All coding/review usage shares the signed-in subscription's applicable limits; exhausted limits or revoked authentication may require the lead to reconnect or wait. No claim of unlimited subscription use is made.

Where the GitHub plan permits it, Butler installs strict/up-to-date validation protection on `main`. For private repos on plans without that feature, Butler still serializes its merges and rechecks head/base, but cannot atomically prevent an external manual push to main racing a merge. Keep main changes through Butler.

## Verification

`platform/test` checks tenant/member access, OAuth state, email-link binding, origin protection, invite revocation, private recovery links, request idempotency and persistent storage. Its pipeline test uses real Git smart-HTTP clone/push, real npm/TypeScript/Vite builds, a model fixture, and simulated provider endpoints to exercise request → PR → review → merge → resumed conversation. `project-worker/test` checks head/base merge guards, device-code parsing, worker authentication and subprocess credential separation.

Real GitHub consent, Railway OAuth permissions/provisioning, Codex subscription authorization, production previews and publishing must also be exercised against the deployed installation after its integration apps are registered. Fixture tests do not establish that these external account connections are configured.

The old `agent-host/` gateway remains operational for the existing team. Its credentials, sessions, worktrees and deployment are separate from this platform.
