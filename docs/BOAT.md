# Boat hosting

Boat is the default host for **new** teams. Open Butler's regular homepage, sign in with GitHub, then follow the Boat browser sign-in in step 2. There is no special entry link, Railway signup or API key to copy. The Butler website and existing Railway projects keep their current addresses and storage. `DEFAULT_HOSTING_PROVIDER=railway` is an explicit operator override for legacy installations; leaving it unset uses Boat. The older `/connect/boat` link still works.

Boat may require activation through its own checkout. The lead reviews the trial, card requirements and charges there. Butler does not accept card details or start a machine during connection. See Boat's [sign-in documentation](https://docs.boat.dev/agent-auth) and [trial terms](https://docs.boat.dev/free-trial).

## Permissions and credentials

The browser sign-in uses Boat's first-party CLI device endpoints. These endpoints are a compatibility dependency, rather than a registered third-party OAuth integration. Butler temporarily encrypts the device session on its persistent volume, creates an empty dedicated environment with credential inheritance disabled, then requests a 90-day credential restricted to that environment and the sandbox/file/command/hosting operations it needs. It rejects wildcard permissions, missing expiry and unrestricted fallback keys. If scoped credential creation is unavailable on the account, setup stops before checkout or provisioning.

The temporary device session is retired after the limited credential is saved. Failed session revocations remain encrypted for retry; incomplete device sessions expire from Butler's setup flow after an hour. The limited credential stays in the control plane. Neither it nor the GitHub installation credential is uploaded to a project VM. The VM receives only its own Butler worker credential. The lead authorizes their Codex subscription on that VM, with login files retained on its project disk.

Do not paste provider credentials, private recovery/invite links, setup links or login codes into public issues, PRs, screenshots or documentation. Local agent logins, keys and databases are excluded from Git and Docker build contexts. Never place runtime credentials in the frontend or `VITE_*` variables. Secret scans supplement these exclusions; they do not replace review.

## Project storage and publishing

Each project gets one fresh private Ubuntu VM with `noEnv: true` and snapshots enabled. Docker runs a worker with a persistent data directory, plus separate static-app containers for production and each active PR. Enabled Docker startup and container restart policies restore services after the VM resumes. Previews contain only the web-app build; they never fork the worker VM or copy Codex logins. Butler publishes preview links and redeploys the app after reviewed merges without replacing the worker.

Machine creation uses a project-specific idempotency key. Build jobs use persistent locks and completion markers, and verify the expected container is running before reusing a completed job. A lost HTTP response therefore does not require a second machine or discard a saved workspace. Closed preview containers are removed and their ports can be reused; the MVP supports 48 simultaneous PR previews per project.

Paid accounts request no automatic stop. Boat trials require automatic stop within two hours, so opening a project requests an authenticated resume and extends its permitted deadline while the page is active. A stopped VM cannot serve its app until resumed; there is no promise of an always-on trial deployment. See [Boat service recovery](https://docs.boat.dev/long-running-tasks).

Boat documents deletion of unsaved stopped snapshots after 14 days. Long-term backups and named saved snapshots are **not automated by this pilot**. Keep important code pushed to GitHub and arrange a backup before leaving a machine stopped long term. See [Boat snapshots](https://docs.boat.dev/snapshots).

## Validation

Automated tests cover browser-auth persistence, tenant/origin checks, narrow credentials, refusal of unrestricted credentials, checkout handoff, idempotent provisioning, credential-free preview archives, preview reopen/port reuse and VM resume. Browser checks exercise the guided flow with simulated provider responses. These checks do not prove account eligibility, billing, VM startup or real public hosting.

Use a real account to verify connection and scope support, project creation, Codex subscription sign-in, a request → PR → preview → reviewed merge → live app, and VM stop/resume with the same worktree, login and conversation. This real-account acceptance remains pending; making Boat the default does not establish that these external checks have passed.
