import { digest, id, now } from "./store.mjs";

const SHA = /^[a-f0-9]{40}$/;
const number = (value) =>
  Number.isSafeInteger(value) && value > 0 && value < 10000000;
export const context = "butler/validated-merge";

export function installWorkerApi(app, config, store, provider) {
  app.use("/api/worker", (req, res, next) => {
    const secret = /^Bearer ([\w-]{43})$/.exec(
      req.headers.authorization || "",
    )?.[1];
    req.project = secret
      ? store.get(
          "SELECT * FROM projects WHERE id=? AND worker_hash=?",
          req.headers["x-butler-project"] || "",
          digest(secret),
        )
      : null;
    if (!req.project)
      return res
        .status(401)
        .json({ error: "Invalid project worker credential." });
    next();
  });
  app.get("/api/worker/config", (req, res) =>
    res.json({
      id: req.project.id,
      name: req.project.name,
      repo: req.project.repo,
      appUrl: req.project.app_url,
      state: req.project.state,
    }),
  );
  app.post("/api/worker/claim", (req, res) =>
    res.json({
      job:
        req.project.state === "ready" ? store.claimJob(req.project.id) : null,
    }),
  );
  app.post("/api/worker/jobs/:jobId/heartbeat", (req, res) => {
    const job = store.get(
      "SELECT id FROM jobs WHERE id=? AND project_id=? AND state=?",
      req.params.jobId,
      req.project.id,
      "working",
    );
    if (!job)
      return res
        .status(409)
        .json({ error: "This request is no longer assigned to the worker." });
    store.run(
      "UPDATE jobs SET lease_until=?,updated_at=? WHERE id=?",
      now() + 90000,
      now(),
      job.id,
    );
    res.json({ ok: true });
  });
  app.post("/api/worker/jobs/:jobId/thread", (req, res) => {
    const job = store.get(
      "SELECT * FROM jobs WHERE id=? AND project_id=?",
      req.params.jobId,
      req.project.id,
    );
    if (!job || !/^[a-f0-9-]{36}$/.test(req.body?.threadId || ""))
      return res.status(400).json({ error: "Invalid conversation." });
    store.run(
      "UPDATE members SET thread_id=? WHERE id=?",
      req.body.threadId,
      job.member_id,
    );
    res.json({ ok: true });
  });
  app.post("/api/worker/jobs/:jobId/result", (req, res) => {
    const job = store.get(
      "SELECT * FROM jobs WHERE id=? AND project_id=?",
      req.params.jobId,
      req.project.id,
    );
    if (!job) return res.status(404).json({ error: "Unknown request." });
    if (
      !["reviewing", "unchanged", "failed"].includes(req.body?.state) ||
      typeof req.body.text !== "string" ||
      req.body.text.length > 30000
    )
      return res.status(400).json({ error: "Invalid request result." });
    const branch =
      typeof req.body.branch === "string" &&
      /^[a-z0-9-]+\/[a-z0-9-]+$/.test(req.body.branch)
        ? req.body.branch
        : null;
    const pr = number(req.body.prNumber) ? req.body.prNumber : null;
    const prUrl = pr
      ? `https://github.com/${req.project.repo}/pull/${pr}`
      : null;
    store.transaction(() => {
      if (!["working", "queued"].includes(job.state)) return;
      store.run(
        "UPDATE jobs SET state=?,result=?,error=?,pr_number=?,pr_url=?,updated_at=?,lease_until=NULL WHERE id=?",
        req.body.state,
        req.body.text,
        req.body.state === "failed" ? req.body.text.slice(0, 350) : null,
        pr,
        prUrl,
        now(),
        job.id,
      );
      if (branch)
        store.run(
          "UPDATE members SET branch=?,pr_number=? WHERE id=?",
          branch,
          pr,
          job.member_id,
        );
      if (
        !store.get(
          "SELECT id FROM messages WHERE job_id=? AND role=?",
          job.id,
          "assistant",
        )
      )
        store.run(
          "INSERT INTO messages VALUES(?,?,?,?,?,?,?)",
          id(),
          req.project.id,
          job.member_id,
          job.id,
          "assistant",
          req.body.text,
          now(),
        );
      if (pr && SHA.test(req.body.sha || ""))
        store.enqueue(
          req.project.id,
          "deploy",
          `preview:${req.project.id}:${pr}:${req.body.sha}`,
          { prNumber: pr, sha: req.body.sha },
        );
    });
    res.json({ ok: true });
  });
  app.get("/api/worker/previews/:number", (req, res) => {
    const found = store.get(
      "SELECT state,url,commit_sha AS sha FROM previews WHERE project_id=? AND pr_number=?",
      req.project.id,
      Number(req.params.number),
    );
    res.json(found || { state: "queued" });
  });
  app.post("/api/worker/github", async (req, res) => {
    const project = req.project,
      b = req.body || {},
      root = `/repos/${project.repo}`;
    const github = (suffix, method, body) =>
      provider.github(project.owner_id, root + suffix, method, body);
    let result;
    switch (b.operation) {
      case "pulls":
        result = await github(
          "/pulls?state=open&sort=created&direction=asc&per_page=100",
        );
        break;
      case "pull":
        if (!number(b.number))
          return res.status(400).json({ error: "Invalid pull request." });
        result = await github(`/pulls/${b.number}`);
        break;
      case "main":
        result = await github("/git/ref/heads/main");
        break;
      case "createPull": {
        const job = store.get(
          "SELECT j.*,m.prefix,m.name FROM jobs j JOIN members m ON m.id=j.member_id WHERE j.id=? AND j.project_id=?",
          b.jobId,
          project.id,
        );
        if (
          !job ||
          typeof b.branch !== "string" ||
          !b.branch.startsWith(`${job.prefix}/`) ||
          !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(b.branch)
        )
          return res.status(400).json({ error: "Invalid request branch." });
        const open = await github(
          `/pulls?state=open&head=${encodeURIComponent(project.repo.split("/")[0] + ":" + b.branch)}`,
        );
        result =
          open[0] ||
          (await github("/pulls", "POST", {
            base: "main",
            head: b.branch,
            title: String(b.title || job.text)
              .replace(/\s+/g, " ")
              .slice(0, 100),
            body: `Requested by **${job.name}** through Pocket Butler.\n\n${job.text.slice(0, 10000)}\n\n<!-- butler-job:${job.id} -->`,
          }));
        break;
      }
      case "checks": {
        if (!SHA.test(b.sha || ""))
          return res.status(400).json({ error: "Invalid revision." });
        const checks = [],
          statuses = [];
        for (let page = 1; ; page++) {
          const value = await github(
            `/commits/${b.sha}/check-runs?filter=latest&per_page=100&page=${page}`,
          );
          checks.push(...value.check_runs);
          if (value.check_runs.length < 100) break;
        }
        for (let page = 1; ; page++) {
          const value = await github(
            `/commits/${b.sha}/status?per_page=100&page=${page}`,
          );
          statuses.push(...value.statuses.filter((s) => s.context !== context));
          if (value.statuses.length < 100) break;
        }
        result = { checks, statuses };
        break;
      }
      case "reviews":
        if (!number(b.number))
          return res.status(400).json({ error: "Invalid pull request." });
        result = await github(`/pulls/${b.number}/reviews?per_page=100`);
        break;
      case "status":
        if (
          !SHA.test(b.sha || "") ||
          !["pending", "success", "failure", "error"].includes(b.state)
        )
          return res.status(400).json({ error: "Invalid check status." });
        result = await github(`/statuses/${b.sha}`, "POST", {
          context,
          state: b.state,
          description: String(b.description || "").slice(0, 140),
        });
        if (b.state === "pending" && number(b.number)) {
          const pr = await github(`/pulls/${b.number}`);
          if (pr.state === "open" && pr.head.sha === b.sha)
            store.enqueue(
              project.id,
              "deploy",
              `preview:${project.id}:${b.number}:${b.sha}`,
              { prNumber: b.number, sha: b.sha },
            );
        }
        break;
      case "review":
        if (
          !number(b.number) ||
          !SHA.test(b.sha || "") ||
          typeof b.text !== "string"
        )
          return res.status(400).json({ error: "Invalid review." });
        // The lead's integration opens PRs, so a review comment plus the required
        // validation status represents approval without self-approval errors.
        result = await github(`/pulls/${b.number}/reviews`, "POST", {
          commit_id: b.sha,
          event: "COMMENT",
          body: b.text.slice(0, 20000),
        });
        break;
      case "block":
        if (!number(b.number) || typeof b.text !== "string")
          return res.status(400).json({ error: "Invalid review." });
        await github(`/issues/${b.number}/comments`, "POST", {
          body: `<!-- butler-review -->\n${b.text.slice(0, 10000)}`,
        });
        store.run(
          "UPDATE jobs SET state='needs_attention',error=?,updated_at=? WHERE project_id=? AND pr_number=? AND state='reviewing'",
          b.text.slice(0, 350),
          now(),
          project.id,
          b.number,
        );
        result = { ok: true };
        break;
      case "merge": {
        if (
          !number(b.number) ||
          !SHA.test(b.sha || "") ||
          !SHA.test(b.base || "")
        )
          return res.status(400).json({ error: "Invalid reviewed revision." });
        const pr = await github(`/pulls/${b.number}`),
          main = await github("/git/ref/heads/main");
        if (
          pr.state !== "open" ||
          pr.draft ||
          pr.base.ref !== "main" ||
          pr.head.sha !== b.sha ||
          main.object.sha !== b.base ||
          pr.labels.some((l) => ["hold", "do-not-merge"].includes(l.name))
        )
          return res
            .status(409)
            .json({ error: "The pull request or main changed. Review again." });
        const validation = await github(`/commits/${b.sha}/status`);
        if (
          !validation.statuses.some(
            (s) => s.context === context && s.state === "success",
          )
        )
          return res
            .status(409)
            .json({
              error: "Compilation and review must pass before merging.",
            });
        result = await github(`/pulls/${b.number}/merge`, "PUT", {
          sha: b.sha,
          merge_method: "squash",
        });
        if (!result.merged)
          return res
            .status(409)
            .json({ error: result.message || "The PR could not be merged." });
        store.run(
          "UPDATE jobs SET state='deploying',merge_sha=?,updated_at=? WHERE project_id=? AND pr_number=? AND state IN ('reviewing','needs_attention')",
          result.sha,
          now(),
          project.id,
          b.number,
        );
        store.enqueue(
          project.id,
          "deploy",
          `main:${project.id}:${result.sha}`,
          { sha: result.sha },
        );
        // Keep the preview for the team to inspect; a closed unmerged PR's
        // environment is cleaned up by its webhook.
        break;
      }
      default:
        return res.status(400).json({ error: "Unknown project operation." });
    }
    res.json(result);
  });
}
