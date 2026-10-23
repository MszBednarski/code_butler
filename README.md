# Pocket Butler

A mobile app and a private invite-link gateway to persistent, personal coding agents. The app and agent host run in separate Railway projects so app previews never copy the shared agent host.

- [Join the team](docs/ONBOARDING.md)
- [Deploy and operate](docs/DEPLOY.md)
- [Acceptance checks](docs/ACCEPTANCE.md)

Local app: `cd app && npm ci && npm run dev`. Agent host: `docker build -t pocket-butler-agents agent-host`, then follow the deployment guide for variables and a persistent `/data` mount.
