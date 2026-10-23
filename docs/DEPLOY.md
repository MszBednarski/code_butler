# Deploy Pocket Butler

Use two Railway projects. PR environments must be enabled only on `butler-app`; copying `butler-agents` would copy the shared agent service.

Repository: https://github.com/MszBednarski/code_butler

## 1. Push the repository

Push the initial setup to `main`. The repository already exists. This setup is the one occasion when the infrastructure agent commits directly to `main`.

## 2. Create the shared GitHub token

GitHub → avatar → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.

- Resource owner: the repository owner.
- Repository access: Only select repositories → `code_butler`.
- Repository permissions: Contents **Read and write**, Pull requests **Read and write**, Issues **Read-only**. Metadata read access is automatic.

Keep the token for step 6. Do not put it in the repository or chat. This token is used by every agent for HTTPS git and `gh`, independently of the SSH key used to push this initial setup.

## 3. Create the agent project

Railway → New Project → Deploy from GitHub repo → `MszBednarski/code_butler`. Name the project `butler-agents` and the service `agent-host`.

Service → Settings:

- Source → Root Directory: `/agent-host`.
- Railway Config File: `/agent-host/railway.json` (the absolute path is required).
- Attach a volume mounted at `/data`, approximately 10 GB.
- Networking → Public Networking → Generate Domain. Save its HTTPS origin as `AGENTS_URL`.
- Serverless/sleeping: **off**. The config also sets `sleepApplication: false` and one replica.
- Project → Settings → Environments: leave PR environments **off**.

The service will not start successfully until step 6 supplies its required variables. This is expected. The container runs as root with `IS_SANDBOX=1` and creates sessions only when teammates visit.

CLI equivalents when linked to this project:

```sh
railway add --service agent-host --repo MszBednarski/code_butler
railway environment edit --service-config agent-host source.rootDirectory /agent-host
railway environment edit --service-config agent-host configFile /agent-host/railway.json
railway volume --service agent-host add --mount-path /data
railway domain --service agent-host --port 3000
```

Check `railway environment config --json` after configuring; if the CLI cannot set a setting, use the dashboard values above. Set `PORT=3000` when generating a domain targeting port 3000.

## 4. Create the GitHub OAuth app

GitHub → avatar → Settings → Developer settings → OAuth Apps → New OAuth App.

- Application name: Pocket Butler.
- Homepage URL: `AGENTS_URL`.
- Authorization callback URL: `AGENTS_URL/auth/callback`.
- Device Flow is not needed for this GitHub OAuth app.

Copy the client ID and generate a client secret. Keep them for step 6. The gateway requests no GitHub scopes, reads the user's login, then discards the OAuth access token.

## 5. Create the app project

Railway → New Project → Deploy from GitHub repo → the same repo. Name the project `butler-app` and its only service `web`.

- Service → Settings → Root Directory: `/app`.
- Railway Config File: `/app/railway.json`.
- Source branch: `main`, with automatic deploys enabled.
- Networking → Generate Domain. Save its HTTPS URL as `APP_URL`.
- Project → Settings → Environments → Enable PR Environments.
- Also enable Bot PR Environments if the shared token belongs to a bot account.

A Railway domain on the production service is needed for PR environments to receive public URLs. The Railway GitHub integration must be installed for this repo and allowed to post preview comments. Do not create an agent-host service in this project.

## 6. Configure the agent service

Set these under `butler-agents` → `agent-host` → Variables → Raw Editor. Replace the examples and collect everyone's login before the first deployment:

```dotenv
PORT=3000
PUBLIC_URL=https://AGENT-DOMAIN.up.railway.app
GITHUB_REPO=MszBednarski/code_butler
GH_TOKEN=YOUR_FINE_GRAINED_TOKEN
GITHUB_OAUTH_CLIENT_ID=YOUR_CLIENT_ID
GITHUB_OAUTH_CLIENT_SECRET=YOUR_CLIENT_SECRET
SESSION_SECRET=GENERATE_A_RANDOM_SECRET
TEAM=GitHubLogin:short-name,OtherGitHubLogin:other-name
AGENT_CMD=/usr/local/bin/run-agent codex
APP_URL=https://APP-DOMAIN.up.railway.app
IS_SANDBOX=1
```

Generate the session secret with `openssl rand -hex 32` or `node -p 'require("crypto").randomBytes(32).toString("hex")'`. Keep it unchanged on redeploys so cookies remain valid. `PUBLIC_URL` must have no trailing slash. Duplicate logins or short names are rejected, as are invalid names and missing variables.

Use `railway variable set --service agent-host --stdin KEY` for a secret from stdin; use `railway variable --set 'KEY=value' --skip-deploys` for ordinary values. Apply the variables and redeploy once after all are set.

All three agents are installed. Switch `AGENT_CMD` to `/usr/local/bin/run-agent claude` or `/usr/local/bin/run-agent gemini` to change agents. A custom trusted shell command is also accepted. The image runs each agent's `--help` and fails the build if required flags disappear. The pinned ttyd release is 1.7.7.

Codex's launcher runs `codex login --device-auth` only if not already signed in. The user opens the displayed link and enters the device code in their browser. They may need to enable device code login in ChatGPT security settings. Credentials live under `/data/home/<name>/.codex`; the launcher resumes the last conversation. See the [official authentication documentation](https://learn.chatgpt.com/docs/auth#login-on-headless-devices).

## 7. Fill in teammate links

Replace `<AGENTS_URL>` and `<APP_URL>` in `docs/ONBOARDING.md` with the actual URLs, commit and push `main` once more. Docs-only commits do not redeploy either service because the watch paths are `/app/**` and `/agent-host/**`.

## 8. Verify

Run [the acceptance checks](ACCEPTANCE.md). Optionally add a GitHub ruleset: repository → Settings → Rules → Rulesets → New branch ruleset → target `main` → Require a pull request before merging.

Local verification:

```sh
cd app
npm ci
npm run typecheck
npm run build
cd ../agent-host/gateway
npm ci
npm test
cd ..
docker build -t pocket-butler-agents .
```

The app is served using `serve`, which accepts Railway's Host headers. App HTML is never cached by the service worker, so refreshing after a merge gets the latest deployment.

## Known limits

- Everyone shares one root container. One person's agent can read another's files and logins. Use this only with a trusted hackathon team.
- Editing `TEAM` redeploys and restarts every agent. Work on disk survives. Collect everyone's username before the first deployment.
- Merges touching `agent-host/` redeploy the host, so avoid them during the event.
- PRs appear under the token owner's account. The branch prefix and commit author identify the teammate.

The reconciler that reviews and merges PRs is outside this setup. OAuth account login and phone dictation must be checked by a human using their own browser.
