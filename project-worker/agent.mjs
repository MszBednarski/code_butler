import { mkdir, writeFile, readFile } from "node:fs/promises";
import { run, save, load, safeEnvironment } from "./runtime.mjs";

export function createAgent({
  dataDir = "/data",
  platform,
  projectId,
  secret,
  auth,
  request = fetch,
}) {
  const repo = `${dataDir}/repo`,
    worktrees = `${dataDir}/wt`,
    homes = `${dataDir}/home`;
  const gitEnv = {
    ...safeEnvironment(`${dataDir}/git`),
    PLATFORM_URL: platform,
    WORKER_SECRET: secret,
  };
  let stopping = false,
    child;
  async function api(endpoint, body) {
    const response = await request(`${platform}/api/worker${endpoint}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "X-Butler-Project": projectId,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const value = await response.json();
    if (!response.ok)
      throw new Error(value.error || "Butler connection interrupted.");
    return value;
  }
  const github = (operation, body = {}) =>
    api("/github", { operation, ...body });
  const git = (args, cwd = repo, extra = {}) =>
    run("git", args, {
      cwd,
      env: gitEnv,
      onChild: (value) => {
        child = value;
      },
      ...extra,
    });
  async function initialize() {
    await Promise.all(
      [
        worktrees,
        homes,
        `${dataDir}/git`,
        `${dataDir}/build`,
        `${dataDir}/jobs`,
        `${dataDir}/reviews`,
      ].map((p) => mkdir(p, { recursive: true, mode: 0o700 })),
    );
    const exists = await run("git", ["-C", repo, "rev-parse", "--git-dir"], {
      env: gitEnv,
      allowFailure: true,
    });
    if (exists.code !== 0)
      await run(
        "git",
        [
          "-c",
          `credential.helper=!node ${new URL("./git-credential.mjs", import.meta.url).pathname}`,
          "clone",
          "--no-checkout",
          `${platform}/api/git/${projectId}/repo.git`,
          repo,
        ],
        {
          env: gitEnv,
          onChild: (value) => {
            child = value;
          },
        },
      );
    // Also configure the helper in local development, where no image-wide git config exists.
    await git([
      "config",
      "credential.helper",
      `!node ${new URL("./git-credential.mjs", import.meta.url).pathname}`,
    ]);
    await git(["config", "user.name", "Pocket Butler"]);
    await git(["config", "user.email", "butler@users.noreply.github.com"]);
    await git(["fetch", "--prune", "origin"]);
    await git(["worktree", "prune"]);
  }
  async function build(cwd, home) {
    await run("npm", ["ci", "--no-audit", "--no-fund"], {
      cwd: `${cwd}/app`,
      env: safeEnvironment(home),
      onChild: (c) => {
        child = c;
      },
    });
    for (const script of ["typecheck", "test", "build"])
      await run(
        "npm",
        ["run", script, ...(script === "build" ? [] : ["--if-present"])],
        {
          cwd: `${cwd}/app`,
          env: safeEnvironment(home),
          timeout: 600000,
          onChild: (c) => {
            child = c;
          },
        },
      );
  }
  async function perform(job) {
    const member = job.member,
      cwd = `${worktrees}/${member.id}`,
      home = `${homes}/${member.id}`,
      file = `${dataDir}/jobs/${job.id}.json`;
    await mkdir(home, { recursive: true, mode: 0o700 });
    await git(["fetch", "--prune", "origin"]);
    const workspace = await git(["rev-parse", "--git-dir"], cwd, {
      allowFailure: true,
    }).catch((error) => {
      if (error.code === "ENOENT") return { code: 1 };
      throw error;
    });
    if (workspace.code !== 0)
      await git(["worktree", "add", "--detach", cwd, "origin/main"]);
    let recovery = await load(file);
    let branch = recovery.branch;
    if (!branch) {
      const dirty = (await git(["status", "--porcelain"], cwd)).stdout.trim();
      const current = (
        await git(["branch", "--show-current"], cwd)
      ).stdout.trim();
      if (dirty) {
        if (!current.startsWith(`${member.prefix}/`))
          throw new Error(
            "Your workspace has unfinished work on another branch. It was preserved; ask the lead to inspect it.",
          );
        branch = current;
      } else if (
        member.branch &&
        (!member.pr_number ||
          (await github("pull", { number: member.pr_number })).state === "open")
      ) {
        branch = member.branch;
        await git(["switch", branch], cwd);
        const remote = await git(
          ["rev-parse", "--verify", `origin/${branch}`],
          cwd,
          { allowFailure: true },
        );
        if (remote.code === 0)
          await git(["merge", "--ff-only", `origin/${branch}`], cwd);
      } else {
        branch = `${member.prefix}/task-${job.id.slice(0, 8)}`;
        await git(["switch", "-c", branch, "origin/main"], cwd);
      }
      recovery = { branch, phase: "started" };
      await save(file, recovery);
    }
    if ((await git(["branch", "--show-current"], cwd)).stdout.trim() !== branch)
      throw new Error(
        "Your workspace branch changed. Existing work was preserved; ask the lead to inspect it.",
      );
    await writeFile(
      `${home}/.butler-task.md`,
      `Request: ${job.text}\nJob: ${job.id}\nBranch: ${branch}\nPreserve existing edits. The Butler controller publishes and reviews this request.\n`,
      { mode: 0o600 },
    );
    let final = recovery.result;
    if (!["edited", "pushed"].includes(recovery.phase)) {
      const prompt = `You are ${member.name}'s personal Pocket Butler coding agent. Work only in this project's app/ directory.\nRequest id: ${job.id}. This request may be recovering after a process restart: inspect existing edits and $HOME/.butler-task.md first and preserve completed work.\nMake the requested website change. Use the files in this checkout as the source of truth. Do not run gh, commit, push, merge, change branches/remotes, inspect other workspaces, or read account credentials. A controller independently builds, commits, opens a PR, reviews and publishes your local changes. Keep the final reply short and say what changed; do not claim publication has already happened. Do not delegate.\n\nTeammate's request:\n${job.text}`;
      const output = `${dataDir}/jobs/${job.id}.txt`;
      const thread = recovery.threadId || member.thread_id;
      const args = [
        "exec",
        ...(thread ? ["resume", thread] : []),
        "--dangerously-bypass-approvals-and-sandbox",
        "--json",
        "--output-last-message",
        output,
        "-",
      ];
      let threadPromise = Promise.resolve();
      await run("codex", args, {
        cwd,
        env: { ...safeEnvironment(home, true), BUTLER_USER: member.prefix },
        input: prompt,
        timeout: 1800000,
        onChild: (c) => {
          child = c;
        },
        onLine: (line) => {
          try {
            const event = JSON.parse(line);
            if (event.type === "thread.started" && event.thread_id) {
              recovery.threadId = event.thread_id;
              threadPromise = threadPromise
                .then(async () => {
                  await save(file, recovery);
                  await api(`/jobs/${job.id}/thread`, {
                    threadId: event.thread_id,
                  });
                })
                .catch(() => {});
            }
          } catch {}
        },
      });
      await threadPromise;
      final = (await readFile(output, "utf8")).slice(0, 25000);
      recovery = { ...recovery, phase: "edited", result: final };
      await save(file, recovery);
    }
    await build(cwd, home);
    if ((await git(["branch", "--show-current"], cwd)).stdout.trim() !== branch)
      throw new Error(
        "The agent changed branches. Work is preserved; ask the lead to inspect it.",
      );
    await git(["add", "--", "app"], cwd);
    const changed = await git(["diff", "--cached", "--quiet"], cwd, {
      allowFailure: true,
    });
    if (changed.code !== 0) {
      await git(["diff", "--cached", "--check"], cwd);
      await git(
        [
          "-c",
          `user.name=${member.name}`,
          "-c",
          `user.email=${member.prefix}@users.noreply.github.com`,
          "commit",
          "-m",
          job.text.replace(/\s+/g, " ").slice(0, 90),
        ],
        cwd,
      );
    }
    const sha = (await git(["rev-parse", "HEAD"], cwd)).stdout.trim();
    if (sha === (await git(["rev-parse", "origin/main"], cwd)).stdout.trim()) {
      await api(`/jobs/${job.id}/result`, {
        state: "unchanged",
        text: final || "The website already matches this request.",
      });
      return;
    }
    await git(
      ["push", "--set-upstream", "origin", `HEAD:refs/heads/${branch}`],
      cwd,
    );
    recovery = { ...recovery, phase: "pushed", sha };
    await save(file, recovery);
    const pr = await github("createPull", {
      jobId: job.id,
      branch,
      title: job.text,
    });
    await api(`/jobs/${job.id}/result`, {
      state: "reviewing",
      text: `${final || "Your change is ready."}\n\nI’ve sent it for review. The preview and live website will update here.`,
      branch,
      sha,
      prNumber: pr.number,
    });
  }
  async function codeOne() {
    if (stopping || (await auth.status()).state !== "connected") return;
    const { job } = await api("/claim", {});
    if (!job) return;
    const heartbeat = setInterval(
      () => api(`/jobs/${job.id}/heartbeat`, {}).catch(() => {}),
      15000,
    );
    try {
      await perform(job);
    } catch (error) {
      if (stopping) return;
      console.error(`[agent] request ${job.id} interrupted: ${error.name}`);
      const recovery = await load(`${dataDir}/jobs/${job.id}.json`);
      await api(`/jobs/${job.id}/result`, {
        state: "failed",
        branch: recovery.branch,
        text: "This request stopped before it could be published. Your edits and conversation were saved. Ask your agent to continue, or ask the lead to check the workspace.",
      });
    } finally {
      clearInterval(heartbeat);
    }
  }
  return {
    initialize,
    codeOne,
    git,
    github,
    api,
    build,
    run,
    get stopping() {
      return stopping;
    },
    stop() {
      stopping = true;
      child?.kill("SIGTERM");
    },
  };
}
