# Join the team (2 minutes)

1. Ask the team lead for your private invite link. Each link opens one person's workspace; keep yours private.
2. Open the link on your phone or laptop. On a phone, add it to your home screen. Your workspace URL is **https://agent-host-production-1fb3.up.railway.app**.
3. First time only: The mobile **Connect GitHub** screen displays your device code. Tap **Copy code**, then **Open GitHub**. Open it in your browser and authorize **your own GitHub account**. Then Codex displays a login link and a device code. Open that link, sign in with your own ChatGPT account, and enter the device code **in the browser**. If asked, enable device code login in your ChatGPT security settings.
4. Type or dictate what you want changed into the Send box. Your agent makes the change, pushes a branch, and opens a pull request.
5. Live app: **https://web-production-0846c.up.railway.app**. Railway previews and automatic main deployments require the repository connection described in the deployment guide.

Each teammate connects their own GitHub account and Codex subscription. Issues, pushes, and PRs use that GitHub account; repository access depends on its permissions. Signing in does not change the workspace repository.

To switch GitHub accounts, stop the agent with Ctrl-C, run `gh auth logout --hostname github.com`, then run `/usr/local/bin/run-agent codex` and authorize the desired account.

Tips
- **Esc** interrupts your agent. **Ctrl-C** stops a stuck command. Use **Enter** for terminal login prompts.
- Use your phone keyboard's dictation button in the normal Send textarea.
- Your worktree, branches, uncommitted files, Codex login, conversation history, and task note live on persistent storage.
- After a host restart, previously active sessions are recreated and Codex resumes its latest conversation. A running tool or command stops during the restart; ask the agent to continue if needed.
- You can open the same session on your phone and your laptop together.
- If the screen freezes during a deployment, reload after the host is healthy again.

Tap **GitHub** in the workspace header to view your connection and signed-in username. The connection screen updates automatically after authorization.
