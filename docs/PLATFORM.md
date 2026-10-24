# Instant teams

The product direction and acceptance demo are tracked in [issue #9](https://github.com/MszBednarski/code_butler/issues/9).

Pocket Butler gives a lead one place to connect GitHub, Boat and an existing Codex subscription. Teammates open an invitation, choose a name and start asking for website changes. They need no provider accounts or repository permissions.

[Boat hosting](BOAT.md) is the default for new projects in the regular guided setup. Existing Railway projects retain their resources. Real-account Boat acceptance is still pending.

## Run the new platform

Build from the repository root:

```sh
docker build -f platform/Dockerfile -t butler-platform .
docker volume create butler-platform-data
docker run --rm -p 3000:3000 -v butler-platform-data:/data \
  -e PUBLIC_URL=http://localhost:3000 \
  -e GITHUB_OAUTH_CLIENT_ID -e GITHUB_OAUTH_CLIENT_SECRET \
  butler-platform
```

For development, start the backend with `DATA_DIR=/tmp/butler-dev PUBLIC_URL=http://localhost:5173 npm --prefix platform start`, then `npm --prefix app run dev`. Vite proxies `/api` and `/auth` to port 3000. Install dependencies with `npm ci` in each package first. Validate with `./scripts/check.sh` on Node 22.13 or later. Node's built-in SQLite module may print its experimental-feature notice.

## Deploy Butler itself on Railway

Create a **separate** Railway project called `butler-platform`, with one service `web` and a persistent volume mounted at `/data`. Use the repo root as the build context. The root `Dockerfile` builds the platform; `platform/Dockerfile` is the equivalent explicit build path. `platform/railway.json` documents the equivalent build settings. Configure one replica, healthcheck `/healthz`, and sleeping off. Generate a public domain and set `PUBLIC_URL=https://<domain>` with no trailing slash. `PORT=3000` is a safe default; set the generated domain's target port to match.

When changing domains, register the new GitHub App callback at `PUBLIC_URL/auth/github/callback` and update its Setup URL to `PUBLIC_URL/auth/github/install/callback` before switching `PUBLIC_URL`. Keep the old callback registered and list the old HTTPS origin in `PUBLIC_URL_ALIASES` (comma-separated) so existing sessions continue working there. Only these explicit origins can submit browser requests; new invitations and recovery links use `PUBLIC_URL`.

The platform keeps its database and encryption key on `/data`. Both must survive redeploys. Its mount guard refuses to start on Railway without that volume. Back up the complete volume, including `master.key` and the SQLite/WAL files. Do not copy keys into git or deployment logs.

A deployment can serve the landing page before provider integrations have been configured. The API reports which connections are available; unavailable connections are disabled in the interface.

## Register the integrations once, as the operator

These steps are performed once for the Butler installation, never by each team. The operator provisions an opaque `SETUP_TOKEN` and opens `PUBLIC_URL/setup#token=<token>`. The token stays out of URLs sent to the server; setup API calls require it plus the correct browser origin. The setup page has clickable registration links, copyable callback URLs and two credential forms. Its settings persist encrypted across restarts. The operator can revoke the link through `/api/setup/finish`; changing `SETUP_TOKEN` deliberately enables a new link. GitHub/Railway OAuth client environment variables remain supported for automated installations.

### GitHub

On Butler’s private operator page, click **Register limited repository app**, then confirm **Create GitHub App** on GitHub. Butler supplies the manifest, callback and webhook URLs, exchanges the returned code, encrypts the app credentials on the persistent volume and applies them immediately. No app key, client secret, or PEM file needs to be copied manually. This registration happens once for the hosted service.

The app requests exactly these repository permissions: Metadata read, Contents write, Pull requests write, Commit statuses write, Checks read, and Repository creation write. It requests no repository administration, organization permissions, Issues permission, Workflows permission, deploy keys or collaborator management. Repository creation is a dedicated permission. If GitHub does not include a newly created repository in the selected installation, Butler saves the repository and shows an approval link for that project. It checks access automatically on return and resumes the same setup. It never requests all-repository access to work around this. App-level push/PR webhooks avoid granting permission to manage repository hooks.

Each lead signs into Butler with their own GitHub account and installs the app using **Only select repositories**. Butler rejects all-repository installations and verifies that the personal installation belongs to the signed-in lead. The MVP provisions new repositories under that personal account; organization installations are not accepted. Invited teammates need no GitHub account.

Profile sign-in tokens are discarded after reading identity and never used for repository operations. Repository work uses renewable installation tokens valid for at most an hour, with `repository_ids` restricted to the single project repository. Metadata lookup and repository creation use separate tokens without Contents permission. A worker still receives only its Butler project credential; the git bridge obtains its short-lived repository token centrally.

Legacy OAuth `repo` grants are never used as a fallback. On migration, persisted OAuth credentials are quarantined and revoked at GitHub; interrupted revocations remain encrypted for retry. Previously authorized users may also revoke the old OAuth application in GitHub Settings → Applications → Authorized OAuth Apps. The old OAuth client is retained only for migration and temporary profile-only sign-in until the scoped app is registered. New app registration configures its own identity flow automatically.

Butler deliberately does not request repository Administration solely to manage branch protection. It still validates exact head/current main, compiles the proposed merge, checks other statuses and waits for a live preview. For protection against concurrent external manual pushes, the repository owner can enable a branch rule; Butler agents never bypass it.

### Railway

This connection is optional for legacy installations using `DEFAULT_HOSTING_PROVIDER=railway`. New teams use Boat's browser sign-in and do not register or authorize a Railway account.

1. Railway → workspace settings → Developer → New OAuth App.
2. Add redirect URI `PUBLIC_URL/auth/railway/callback`.
3. Paste the client ID and secret into the Railway card on Butler’s private installation page and click Save Railway.

Butler requests `openid email profile offline_access workspace:admin`. During consent the lead selects the workspace Butler may manage. Offline access allows remembered connections and refresh-token rotation. If multiple workspaces are granted, the lead chooses one in project creation.

The private installation page encrypts the credentials on the persistent volume and applies them immediately. No Railway variable editing or redeployment is needed to save these connections. No existing teammate host needs to restart.

Optional email sign-in uses `RESEND_API_KEY` and `EMAIL_FROM`. Without it, teammates can save their durable private sign-in link or optionally use GitHub. No email-provider setup is required for the primary experience.

## What happens for each team

1. The lead follows one guided flow: sign in with GitHub, authorize Butler to create the project automatically, connect Boat, then describe an idea. Each screen offers one primary next action. Existing repositories never need to be selected in Butler. Drafts and the project creation key survive redirects and refreshes.
2. Butler creates a private GitHub repo containing the web-app template and a fresh Boat VM for the project. The worker keeps its data on the VM's persistent disk; production and PR previews run as separate app containers. Existing Railway projects continue using their recorded provider.
3. The lead can share the QR immediately. Requests are durably queued while infrastructure is building.
4. The same setup flow waits while Butler creates the private repository and hosting. Its final screen asks the lead to **Connect Codex**; the collaboration workspace opens after sign-in. The worker runs `codex login --device-auth`; Butler shows its authorization link and code. The lead completes sign-in in their browser. If necessary, enable device-code login in ChatGPT Settings → Security first.
5. The login is stored under the worker's persistent `/data/codex`. Coding and reviewing use that project host's subscription login, not an OpenAI API key. GitHub and Boat connections are remembered at the account level; Codex is authorized for each newly provisioned host and retained across visits/redeploys.
6. Each member has a persistent identity, home, git worktree and explicit Codex conversation ID. The small MVP worker runs coding and review jobs sequentially within a project. This keeps subscription use bounded by one active coding/review task and avoids conversation/auth-refresh races.
7. The controller builds the app and pushes a separate draft branch without opening a PR. It publishes an app-only preview. The request’s creator or project lead opens that preview and chooses **Make this the website** (or says “make the change” in that chat after inspection). Approval requires that same person to have inspected the exact commit. The lead can also send instructions to a teammate’s existing agent; those messages identify the lead as their author. The coding agent writes the PR title and description from the intended change, rather than copying dictation. Each follow-up gets its own draft and needs approval.
8. A separate reviewer conversation checks the proposed merge into current main, builds it, publishes the tested merge candidate to the PR without force-pushing, waits for a working preview and other checks, and squash-merges. Review findings appear in chat. Up to three automatic repair attempts can update that already approved PR; this does not approve a separate teammate request.
9. Butler stages clean app copies from exact commits and builds them as app-only containers on the project's Boat VM. It adds public preview URLs to the PR and project interface. Main publishing uses a GitHub webhook and the controller's durable deployment queue. Legacy Railway projects retain their separate app/agent services and trusted artifact uploader.

## Recovery and access

Accepted requests, messages, memberships and background tasks are stored in SQLite. The separate **Group chat** stores human conversations and emoji reactions without creating coding jobs or approving previews. Requests and group messages have idempotency keys; worker leases allow interrupted requests to be claimed again. Task records and explicit conversation IDs are persisted before publishing. Existing teammate worktrees are never reset or cleaned; only the reviewer's disposable checkout is reset. On startup, the controller updates the saved repository remote to the configured platform origin before fetching, so a domain change does not strand the queue. A failed request preserves its branch, edits and conversation for a follow-up.

Team invitations create a different member identity for each browser/person, not a shared terminal. Cookies restore the same workspace on that browser. **Save access** supplies a private sign-in link that restores the account on another device. Email/GitHub linking keeps the existing member work. Replacing the team invitation prevents new joins with the old invitation and retains current members.

Only the lead can retrieve team invitations or start/view device authentication. All browser writes require the configured origin. Worker APIs require a project-specific credential. The git bridge is restricted to that project's repository and keeps the owner's GitHub token in the platform. Coding/build subprocesses receive a small environment without the worker credential or GitHub/Railway tokens.

Project workers are separate containers and volumes for different teams. Within one team, agents run as root in a shared container and are suitable for trusted teammates, not hostile users. Separate worktrees are not an OS security boundary. All coding/review usage shares the signed-in subscription's applicable limits; exhausted limits or revoked authentication may require the lead to reconnect or wait. No claim of unlimited subscription use is made.

Butler serializes its own merges and rechecks head/base. Without an owner-configured branch rule, it cannot atomically prevent an external manual push to main racing a merge. Keep main changes through Butler or enable a branch rule in GitHub.

## Verification

`platform/test` checks tenant/member access, read-only team chats, durable progress, creator-only preview approval, revision checks, OAuth state, email-link binding, origin protection, invite revocation, private recovery links, request idempotency and persistent storage. Its pipeline test uses real Git smart-HTTP clone/push, real npm/TypeScript/Vite builds, a model fixture, and simulated provider endpoints to exercise request → draft preview → inspection → approval → PR → review → merge → resumed conversation. `project-worker/test` checks progress recovery, head/base merge guards, device-code parsing, worker authentication and subprocess credential separation.

Real GitHub consent, Railway OAuth permissions/provisioning, Codex subscription authorization, production previews and publishing must also be exercised against the deployed installation after its integration apps are registered. Fixture tests do not establish that these external account connections are configured.

The old `agent-host/` gateway remains operational for the existing team. Its credentials, sessions, worktrees and deployment are separate from this platform.
