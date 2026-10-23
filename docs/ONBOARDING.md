# Join the team (2 minutes)

1. Ask the team lead for your private invite link. Each link opens one person's workspace; keep yours private.
2. Open the link on your phone or laptop. On a phone, add it to your home screen. Your workspace URL is **https://agent-host-production-1fb3.up.railway.app**.
3. First time only: open [Create your Butler GitHub token](https://github.com/settings/personal-access-tokens/new?name=Butler&target_name=MszBednarski&expires_in=30&contents=write&pull_requests=write&issues=write). The link prefills the owner, Contents/Pull requests/Issues read-write permissions, and a 30-day expiration. Select **Only select repositories → code_butler** yourself; GitHub does not support prefilling repository selection. Generate the token and paste it into the workspace’s **hidden terminal prompt**, never chat.
4. First time only: Codex displays a login link and a device code. Open that link, sign in with your own ChatGPT account, and enter the device code **in the browser**. If asked, enable device code login in your ChatGPT security settings.
5. Type or dictate what you want changed into the Send box. Your agent makes the change, pushes a branch, and opens a pull request.
6. Live app: **https://web-production-0846c.up.railway.app**. Railway previews and automatic main deployments require the repository connection described in the deployment guide.

The current link works for **MszBednarski**, the repository owner. GitHub does not support fine-grained PAT contributions by collaborators on another person’s repository. For teammates to use their own repo-only tokens, first transfer the repo to an organization and add them as members; the terminal link then uses the configured repository owner. See the deployment guide for setup and migration.

Tips
- **Esc** interrupts your agent. **Ctrl-C** stops a stuck command. Use **Enter** for terminal login prompts.
- Use your phone keyboard's dictation button in the normal Send textarea.
- Your worktree, branches, uncommitted files, Codex login, conversation history, and task note live on persistent storage.
- After a host restart, previously active sessions are recreated and Codex resumes its latest conversation. A running tool or command stops during the restart; ask the agent to continue if needed.
- You can open the same session on your phone and your laptop together.
- If the screen freezes during a deployment, reload after the host is healthy again.
