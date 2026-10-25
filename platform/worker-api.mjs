import { digest, id, now } from "./store.mjs";
import { installGeminiWorker } from "./gemini.mjs";

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
  installGeminiWorker(app, store, provider);
  app.get("/api/worker/config", (req, res) =>
    res.json({
      id: req.project.id,
      name: req.project.name,
      description: req.project.description,
      nameSource: req.project.name_source,
      repo: req.project.repo,
      appUrl: req.project.app_url,
      state: req.project.state,
    }),
  );
  app.post("/api/worker/name", (req, res) => {
    const name =
      typeof req.body.name === "string"
        ? req.body.name.trim().replace(/\s+/g, " ")
        : "";
    if (!name || name.length > 50 || /[\x00-\x1f<>/\\]|https?:/i.test(name))
      return res.status(400).json({ error: "Choose a short project name." });
    store.run(
      "UPDATE projects SET name=?,name_source='generated' WHERE id=? AND name_source='pending'",
      name,
      req.project.id,
    );
    res.json({
      name: store.get("SELECT name FROM projects WHERE id=?", req.project.id)
        .name,
    });
  });
  app.post("/api/worker/auth", (req, res) => {
    if (typeof req.body.connected !== "boolean")
      return res.status(400).json({ error: "Invalid connection state." });
    store.run(
      "UPDATE projects SET codex_ready=? WHERE id=?",
      req.body.connected ? 1 : 0,
      req.project.id,
    );
    res.json({ ok: true });
  });
  app.post("/api/worker/claim", (req, res) =>
    res.json({
      job:
        req.project.state === "ready"
          ? store.claimJob(req.project.id, {
              supportsApproval: ["2", "3"].includes(
                req.headers["x-butler-protocol"],
              ),
              supportsRevisions: req.headers["x-butler-protocol"] === "3",
            })
          : null,
    }),
  );
  app.get("/api/worker/pending-pulls", (req, res) =>
    res.json(
      store.all(
        "SELECT DISTINCT pr_number AS number FROM jobs WHERE project_id=? AND pr_number IS NOT NULL AND state IN ('reviewing','needs_attention','preview_failed')",
        req.project.id,
      ),
    ),
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
  const validEvents = (body) =>
    Array.isArray(body?.events) &&
    body.events.length > 0 &&
    body.events.length <= 50 &&
    body.events.every(
      (e) =>
        typeof e.key === "string" &&
        /^[a-zA-Z0-9:._-]{1,160}$/.test(e.key) &&
        ["agent", "status", "review", "error", "gemini"].includes(e.kind) &&
        typeof e.text === "string" &&
        e.text.length > 0 &&
        e.text.length <= 20000 &&
        (!e.at ||
          (Number.isSafeInteger(e.at) && e.at > 0 && e.at <= now() + 60000)),
    );
  app.post(
    ["/api/worker/jobs/:jobId/events", "/api/worker/pulls/:number/events"],
    (req, res) => {
      if (!validEvents(req.body))
        return res.status(400).json({ error: "Invalid progress update." });
      const jobs = req.params.jobId
        ? store.all(
            "SELECT id FROM jobs WHERE id=? AND project_id=?",
            req.params.jobId,
            req.project.id,
          )
        : store.all(
            "SELECT id FROM jobs WHERE pr_number=? AND project_id=?",
            Number(req.params.number),
            req.project.id,
          );
      if (!jobs.length)
        return res.status(404).json({ error: "Unknown request." });
      store.transaction(() => {
        for (const e of req.body.events)
          if (req.params.jobId)
            store.recordEvent(jobs[0].id, e.key, e.kind, e.text, e.at || now());
          else
            store.recordPullEvent(
              req.project.id,
              Number(req.params.number),
              e.key,
              e.kind,
              e.text,
              e.at || now(),
            );
      });
      res.json({ ok: true });
    },
  );
  app.post("/api/worker/pulls/:number/start", (req, res) => {
    const pr = Number(req.params.number);
    if (
      !number(pr) ||
      typeof req.body.key !== "string" ||
      !/^[a-zA-Z0-9:._-]{1,150}$/.test(req.body.key)
    )
      return res.status(400).json({ error: "Invalid review." });
    store.transaction(() => {
      store.run(
        "UPDATE jobs SET state=CASE WHEN state='needs_attention' THEN 'reviewing' ELSE state END,error=NULL,started_at=COALESCE(started_at,?),finished_at=NULL WHERE project_id=? AND pr_number=? AND state IN ('reviewing','needs_attention')",
        now(),
        req.project.id,
        pr,
      );
      store.recordPullEvent(
        req.project.id,
        pr,
        `${req.body.key}:start`,
        "review",
        `Reviewing PR #${pr}. Checking the code and app build.`,
      );
    });
    res.json({ ok: true });
  });
  app.post("/api/worker/jobs/:jobId/result", (req, res) => {
    const job = store.get(
      "SELECT * FROM jobs WHERE id=? AND project_id=?",
      req.params.jobId,
      req.project.id,
    );
    if (!job) return res.status(404).json({ error: "Unknown request." });
    if ((req.body?.revision || 0) !== job.request_revision)
      return res.status(409).json({
        error:
          "This preview has a newer follow-up. The saved result is out of date.",
      });
    if (
      !["reviewing", "unchanged", "failed", "building_preview"].includes(
        req.body?.state,
      ) ||
      typeof req.body.text !== "string" ||
      req.body.text.length > 30000
    )
      return res.status(400).json({ error: "Invalid request result." });
    if (
      job.approval_required &&
      req.body.state === "reviewing" &&
      !job.approved_at
    )
      return res.status(409).json({
        error:
          "The user must inspect and approve the preview before a PR is created.",
      });
    if (
      req.body.state === "building_preview" &&
      (!SHA.test(req.body.sha || "") ||
        typeof req.body.title !== "string" ||
        !req.body.title.trim() ||
        req.body.title.length > 100 ||
        typeof req.body.description !== "string" ||
        req.body.description.length > 20000)
    )
      return res.status(400).json({
        error:
          "A preview needs a revision and an agent-written title and description.",
      });
    const branch =
      typeof req.body.branch === "string" &&
      /^[a-z0-9-]+\/[a-z0-9-]+$/.test(req.body.branch)
        ? req.body.branch
        : null;
    if (req.body.state === "building_preview") {
      const member = store.get(
        "SELECT prefix FROM members WHERE id=?",
        job.member_id,
      );
      if (!branch?.startsWith(`${member.prefix}/`))
        return res.status(400).json({ error: "Invalid preview branch." });
    }
    const pr = number(req.body.prNumber) ? req.body.prNumber : null;
    const prUrl = pr
      ? `https://github.com/${req.project.repo}/pull/${pr}`
      : null;
    store.transaction(() => {
      if (/^[a-f0-9-]{36}$/.test(req.body.threadId || ""))
        store.run(
          "UPDATE members SET thread_id=? WHERE id=?",
          req.body.threadId,
          job.member_id,
        );
      if (!["working", "queued"].includes(job.state)) return;
      store.run(
        "UPDATE jobs SET state=?,result=?,error=?,pr_number=?,pr_url=?,updated_at=?,lease_until=NULL,finished_at=? WHERE id=?",
        req.body.state,
        req.body.text,
        req.body.state === "failed" ? req.body.text.slice(0, 350) : null,
        pr,
        prUrl,
        now(),
        req.body.state === "reviewing" ? null : now(),
        job.id,
      );
      if (req.body.state === "building_preview") {
        store.run(
          "UPDATE jobs SET change_sha=?,branch=?,pr_title=?,pr_body=?,inspected_at=NULL,approved_at=NULL WHERE id=?",
          req.body.sha,
          branch,
          req.body.title.trim(),
          req.body.description,
          job.id,
        );
        if (!job.pending_text)
          store.enqueue(
            req.project.id,
            "artifact",
            `artifact:${job.id}:${req.body.sha}`,
            {
              jobId: job.id,
              sha: req.body.sha,
              revision: job.request_revision,
            },
            true,
          );
        if (!job.pending_text)
          store.run(
            "UPDATE tasks SET payload=? WHERE dedupe_key=?",
            JSON.stringify({
              jobId: job.id,
              sha: req.body.sha,
              revision: job.request_revision,
            }),
            `artifact:${job.id}:${req.body.sha}`,
          );
      }
      if (branch)
        store.run(
          "UPDATE members SET branch=?,pr_number=? WHERE id=?",
          branch,
          pr,
          job.member_id,
        );
      const last = store.get(
        "SELECT text FROM job_events WHERE job_id=? AND kind='agent' ORDER BY created_at DESC,rowid DESC LIMIT 1",
        job.id,
      );
      const text =
        last?.text && req.body.text.startsWith(last.text)
          ? req.body.text.slice(last.text.length).trim()
          : req.body.text;
      if (text)
        store.recordEvent(
          job.id,
          `result:${job.request_revision}`,
          req.body.state === "failed" ? "error" : "message",
          text,
        );
      if (pr && SHA.test(req.body.sha || ""))
        store.enqueue(
          req.project.id,
          "deploy",
          `preview:${req.project.id}:${pr}:${req.body.sha}`,
          { prNumber: pr, sha: req.body.sha },
        );
      store.resumeFollowups(job.id);
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
        if (job.approval_required && !job.approved_at)
          return res.status(409).json({
            error: "Inspect and approve the preview before opening a PR.",
          });
        const open = await github(
          `/pulls?state=open&head=${encodeURIComponent(project.repo.split("/")[0] + ":" + b.branch)}`,
        );
        result =
          open[0] ||
          (await github("/pulls", "POST", {
            base: "main",
            head: b.branch,
            title: String(b.title || "Update the website")
              .replace(/\s+/g, " ")
              .slice(0, 100),
            body: `Requested by **${job.name}** through Pocket Butler.\n\n${String(b.description || "Website changes prepared and checked by the coding agent.").slice(0, 15000)}\n\n<!-- butler-job:${job.id} -->`,
          }));
        if (open[0] && b.title && b.description)
          await github(`/pulls/${result.number}`, "PATCH", {
            title: String(b.title).slice(0, 100),
            body: `Requested by **${job.name}** through Pocket Butler.\n\n${String(b.description).slice(0, 15000)}`,
          });
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
        store.recordPullEvent(
          project.id,
          b.number,
          `review-complete:${b.sha}`,
          "review",
          `Review passed for PR #${b.number}.\n\n${b.text}`,
        );
        break;
      case "block":
        if (!number(b.number) || typeof b.text !== "string")
          return res.status(400).json({ error: "Invalid review." });
        if (!b.retryable)
          await github(`/issues/${b.number}/comments`, "POST", {
            body: `<!-- butler-review -->\n${b.text.slice(0, 10000)}`,
          });
        store.run(
          "UPDATE jobs SET state='needs_attention',error=?,updated_at=?,finished_at=? WHERE project_id=? AND pr_number=? AND state='reviewing'",
          b.text.slice(0, 350),
          now(),
          now(),
          project.id,
          b.number,
        );
        store.recordPullEvent(
          project.id,
          b.number,
          `review-block:${digest(b.text)}`,
          "review",
          `${b.retryable ? "Review paused" : "Review blocked"} for PR #${b.number}:\n\n${b.text}${b.retryable ? "" : "\n\nAsk your agent to fix these findings, then it will be reviewed again."}`,
        );
        result = { ok: true };
        break;
      case "repair": {
        if (
          !number(b.number) ||
          !SHA.test(b.sha || "") ||
          !SHA.test(b.base || "") ||
          typeof b.text !== "string"
        )
          return res.status(400).json({ error: "Invalid repair request." });
        const pr = await github(`/pulls/${b.number}`),
          main = await github("/git/ref/heads/main");
        if (
          pr.state !== "open" ||
          pr.draft ||
          pr.head.sha !== b.sha ||
          main.object.sha !== b.base ||
          pr.labels?.some((l) => ["hold", "do-not-merge"].includes(l.name))
        )
          return res.json({
            queued: false,
            reason: "The pull request changed or is on hold.",
          });
        const original = store.get(
          "SELECT * FROM jobs WHERE project_id=? AND pr_number=? AND request_key NOT LIKE 'review-fix:%' ORDER BY created_at DESC LIMIT 1",
          project.id,
          b.number,
        );
        if (!original) return res.json({ queued: false });
        const requestKey = `review-fix:${b.number}:${b.sha}:${b.base}`;
        if (
          store.get(
            "SELECT id FROM jobs WHERE member_id=? AND request_key=?",
            original.member_id,
            requestKey,
          )
        )
          return res.json({
            queued: false,
            reason: "Already sent for repair.",
          });
        if (
          store.get(
            "SELECT id FROM jobs WHERE member_id=? AND state IN ('queued','working')",
            original.member_id,
          )
        )
          return res.json({
            queued: false,
            reason: "The agent is already working on a follow-up.",
          });
        if (
          store.get(
            "SELECT COUNT(*) AS n FROM jobs WHERE project_id=? AND request_key LIKE ?",
            project.id,
            `review-fix:${b.number}:%`,
          ).n >= 3
        ) {
          store.recordEvent(
            original.id,
            `repair-limit:${b.number}`,
            "review",
            "Automatic repairs have reached the limit for this PR. Read the review findings and send your agent a follow-up request.",
          );
          return res.json({ queued: false, reason: "Repair limit reached." });
        }
        const repair = id();
        const text = `Continue this teammate's request: ${original.text.slice(0, 4000)}\n\nThe independent reviewer blocked PR #${b.number}:\n${b.text.slice(0, 12000)}\n\nFix these findings in the existing app. Preserve the requested features and the teammate's work. Check the actual files and the review findings; do not claim success without making the required changes.`;
        store.transaction(() => {
          store.run(
            "INSERT INTO jobs(id,project_id,member_id,request_key,text,created_at,updated_at,branch,pr_number) VALUES(?,?,?,?,?,?,?,?,?)",
            repair,
            project.id,
            original.member_id,
            requestKey,
            text,
            now(),
            now(),
            pr.head.ref,
            b.number,
          );
          store.recordEvent(
            repair,
            "automatic-repair",
            "status",
            `The reviewer found issues in PR #${b.number}. I’m sending them back to your coding agent for an automatic fix.\n\n${b.text.slice(0, 15000)}`,
          );
        });
        result = { queued: true, jobId: repair };
        break;
      }
      case "merge": {
        if (
          !number(b.number) ||
          !SHA.test(b.sha || "") ||
          !SHA.test(b.base || "")
        )
          return res.status(400).json({ error: "Invalid reviewed revision." });
        const pr = await github(`/pulls/${b.number}`);
        if (
          pr.state === "closed" &&
          pr.merged &&
          pr.head.sha === b.sha &&
          SHA.test(pr.merge_commit_sha || "")
        ) {
          store.recordMerge(project.id, b.number, pr.merge_commit_sha, {
            title: pr.title,
            author: pr.user?.login,
            mergedAt: Date.parse(pr.merged_at),
          });
          return res.json({ merged: true, sha: pr.merge_commit_sha });
        }
        const main = await github("/git/ref/heads/main");
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
          return res.status(409).json({
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
        store.recordMerge(project.id, b.number, result.sha, {
          title: pr.title,
          author: pr.user?.login,
        });
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
