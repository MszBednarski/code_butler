# Pocket Butler

Turn a group of people with phones into a software team. A lead connects GitHub, Boat and their Codex subscription; teammates scan an invitation and start requesting changes. Each change gets a preview first. Its creator or the team lead inspects it and chooses **Make this the website** before Butler opens a PR, reviews it and publishes it. Teammates can talk in group chat, react to messages and previews, and follow each other’s agents. The lead can guide any teammate’s agent, with instructions clearly attributed.

- [Product direction / implementation issue](https://github.com/MszBednarski/code_butler/issues/9)
- [Run and deploy the platform](docs/PLATFORM.md)
- [Existing team's onboarding](docs/ONBOARDING.md)
- [Existing agent-host deployment](docs/DEPLOY.md)

`app/` is the mobile web portal. `platform/` provides accounts, memberships, provider connections, provisioning and deployment. `project-worker/` runs a team's persistent Codex conversations, worktrees and reviewer. `agent-host/` contains the retired prototype for reference.

With Node 22.13+: install package dependencies and run `./scripts/check.sh`. For deployment, build `platform/Dockerfile` from the repository root and mount a persistent volume at `/data`; see the platform guide for the one-time OAuth app registrations.
