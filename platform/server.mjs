import {
  githubAppReady,
  creationCredential,
  githubLoginClient,
  retireLegacyGithub,
} from "./github-app.mjs";
import express from "express";
import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import QRCode from "qrcode";
import { createStore, id, token, digest, now } from "./store.mjs";
import { configuration } from "./config.mjs";
import { providers } from "./providers.mjs";
import { installAuth, publicUser, cookie, accountForRequest } from "./auth.mjs";
import { installWorkerApi } from "./worker-api.mjs";
import { installGitProxy } from "./git-proxy.mjs";
import { createProvisioner } from "./provision.mjs";
import { installSetup } from "./setup.mjs";

const uuid = (value) =>
  typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
const name = (value) =>
  typeof value === "string" &&
  value.trim().length >= 1 &&
  value.trim().length <= 50 &&
  !/[\x00-\x1f]/.test(value);
const reactionEmojis = new Set(["👍", "❤️", "🔥", "😂", "🎉", "👀", "🤩"]);
const memberView = (m) => ({
  id: m.id,
  name: m.name,
  prefix: m.prefix,
  role: m.role,
});

export function createPlatform(
  config,
  {
    store = createStore(config.dataDir),
    provider = providers(config, store),
    provisioner = createProvisioner(config, store, provider),
    gitOptions,
  } = {},
) {
  const app = express(),
    server = createServer(app),
    limits = new Map();
  app.set("trust proxy", true);
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set("Content-Security-Policy", "frame-ancestors 'self'");
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "no-referrer");
    if (req.path.startsWith("/api/") || req.path.startsWith("/auth/"))
      res.set("Cache-Control", "no-store");
    if (
      !["GET", "HEAD"].includes(req.method) &&
      !req.path.startsWith("/api/worker/") &&
      !req.path.startsWith("/api/git/") &&
      !req.path.startsWith("/api/hooks/") &&
      ![config.publicUrl, ...(config.publicAliases || [])].includes(
        req.headers.origin,
      )
    )
      return res.status(403).json({ error: "Invalid request origin." });
    next();
  });
  app.get("/healthz", (_req, res) => res.type("text").send("ok"));
  app.post(
    ["/api/hooks/github/:projectId", "/api/hooks/github-app"],
    express.raw({ type: "application/json", limit: "1mb" }),
    (req, res) => {
      const appHook = req.path === "/api/hooks/github-app";
      if (!Buffer.isBuffer(req.body)) return res.sendStatus(403);
      let event;
      try {
        event = JSON.parse(req.body.toString());
      } catch {
        return res.sendStatus(400);
      }
      const project = appHook
        ? store.get(
            "SELECT * FROM projects WHERE repo=? COLLATE NOCASE",
            String(event.repository?.full_name || ""),
          )
        : store.get("SELECT * FROM projects WHERE id=?", req.params.projectId);
      const secret = appHook
        ? config.githubAppWebhookSecret
        : project && store.open(project.webhook_secret);
      if (!secret) return res.sendStatus(403);
      const actual = Buffer.from(req.headers["x-hub-signature-256"] || ""),
        expected = Buffer.from(
          "sha256=" +
            createHmac("sha256", secret).update(req.body).digest("hex"),
        );
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        return res.sendStatus(403);
      if (
        appHook &&
        req.headers["x-github-event"] === "installation" &&
        ["deleted", "suspend"].includes(event.action)
      ) {
        for (const row of store.all(
          "SELECT user_id FROM connections WHERE provider='github_installation'",
        ))
          if (
            store.connection(row.user_id, "github_installation")?.id ===
            event.installation?.id
          )
            store.run(
              "DELETE FROM connections WHERE user_id=? AND provider='github_installation'",
              row.user_id,
            );
        return res.sendStatus(202);
      }
      if (!project) return res.sendStatus(202);
      if (
        appHook &&
        JSON.parse(project.resources).githubInstallationId !==
          event.installation?.id
      )
        return res.sendStatus(403);
      if (
        event.repository?.full_name?.toLowerCase() !==
        project.repo?.toLowerCase()
      )
        return res.sendStatus(403);
      const kind = req.headers["x-github-event"];
      if (
        kind === "push" &&
        event.ref === "refs/heads/main" &&
        /^[a-f0-9]{40}$/.test(event.after)
      )
        store.enqueue(
          project.id,
          "deploy",
          `main:${project.id}:${event.after}`,
          { sha: event.after },
        );
      if (kind === "pull_request" && Number.isSafeInteger(event.number)) {
        if (
          event.action === "closed" &&
          event.pull_request.merged &&
          /^[a-f0-9]{40}$/.test(event.pull_request.merge_commit_sha || "")
        )
          store.recordMerge(
            project.id,
            event.number,
            event.pull_request.merge_commit_sha,
            {
              title: event.pull_request.title,
              author: event.pull_request.user?.login,
              mergedAt: Date.parse(event.pull_request.merged_at),
            },
          );
        if (
          ["opened", "reopened", "synchronize"].includes(event.action) &&
          event.pull_request.base.ref === "main"
        ) {
          store.run(
            "DELETE FROM tasks WHERE project_id=? AND dedupe_key=? AND state='queued'",
            project.id,
            `cleanup:${project.id}:${event.number}`,
          );
          store.enqueue(
            project.id,
            "deploy",
            `preview:${project.id}:${event.number}:${event.pull_request.head.sha}`,
            { prNumber: event.number, sha: event.pull_request.head.sha },
            event.action === "reopened",
          );
        }
        if (event.action === "closed" && !event.pull_request.merged)
          store.enqueue(
            project.id,
            "cleanup",
            `cleanup:${project.id}:${event.number}`,
            { prNumber: event.number },
            true,
          );
      }
      res.sendStatus(202);
    },
  );
  installGitProxy(app, store, {
    repositoryToken: provider.repositoryToken,
    ...gitOptions,
  });
  app.use(express.json({ limit: "128kb" }));
  app.use("/api", (req, res, next) => {
    if (req.path.startsWith("/worker/")) return next();
    const restrictive =
      req.path.startsWith("/auth/email") ||
      req.path.startsWith("/auth/recover") ||
      req.path.startsWith("/invites/");
    const account = restrictive ? null : accountForRequest(req, store);
    const budget = ["GET", "HEAD"].includes(req.method) ? "read" : "write";
    const identity = account ? `user:${account.id}` : `ip:${req.ip}`;
    const key = restrictive ? `${req.ip}:${req.path}` : `${identity}:${budget}`,
      interval = restrictive ? 600000 : 60000,
      maximum = restrictive ? 25 : 240;
    const entry = limits.get(key);
    if (entry?.until > now() && entry.count >= maximum)
      return res
        .status(429)
        .set("Retry-After", "60")
        .json({ error: "Please wait a moment and try again." });
    if (entry?.until > now()) entry.count++;
    else limits.set(key, { count: 1, until: now() + interval });
    if (limits.size > 5000)
      for (const [k, value] of limits)
        if (value.until < now()) limits.delete(k);
    next();
  });
  installSetup(app, config, store, provider.request);
  installWorkerApi(app, config, store, provider);
  installAuth(app, config, store, provider);
  const signed = (req, res, next) =>
    req.account
      ? next()
      : res
          .status(401)
          .json({ error: "Sign in or open your team invitation." });
  function membership(req, res, next) {
    req.project = uuid(req.params.projectId)
      ? store.get("SELECT * FROM projects WHERE id=?", req.params.projectId)
      : null;
    req.member =
      req.account && req.project
        ? store.get(
            `SELECT * FROM members WHERE project_id=? AND user_id=? ${req.query.member ? "AND id=?" : ""} ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END,created_at DESC LIMIT 1`,
            req.project.id,
            req.account.id,
            ...(req.query.member ? [String(req.query.member)] : []),
          )
        : null;
    if (!req.member)
      return res.status(404).json({
        error:
          "This project is not in your account. Open its invitation to join.",
      });
    if (
      !["GET", "HEAD"].includes(req.method) &&
      req.query.chat &&
      req.query.chat !== req.member.id &&
      ![
        "/api/projects/:projectId/reactions",
        "/api/projects/:projectId/group/messages",
      ].includes(req.route?.path) &&
      !(
        req.project.owner_id === req.account.id &&
        [
          "/api/projects/:projectId/messages",
          "/api/projects/:projectId/jobs/:jobId/inspect",
          "/api/projects/:projectId/jobs/:jobId/approve",
          "/api/projects/:projectId/jobs/:jobId/retry",
        ].includes(req.route?.path)
      )
    )
      return res.status(403).json({
        error:
          "Teammate chats are read-only. Return to your chat to send a request.",
      });
    next();
  }
  const owner = (req, res, next) =>
    req.project.owner_id === req.account.id
      ? next()
      : res.status(403).json({ error: "Only the project lead can do that." });
  const boatConnected = (user) => {
    const saved = user && store.connection(user.id, "boat");
    return Boolean(
      saved?.access_token &&
        saved.environmentId &&
        Date.parse(saved.expiresAt) > now(),
    );
  };
  const hostingFor = (user) =>
    boatConnected(user) ? "boat" : config.defaultHostingProvider || "boat";
  app.get("/api/session", (req, res) => {
    const github =
      req.account && store.connection(req.account.id, "github_installation");
    res.json({
      user: publicUser(req.account),
      connections: {
        github: Boolean(github && githubAppReady(config)),
        githubCreation: Boolean(
          req.account && creationCredential(config, store, req.account.id),
        ),
        railway: Boolean(
          req.account && store.connection(req.account.id, "railway"),
        ),
        boat: boatConnected(req.account),
      },
      capabilities: {
        github: Boolean(
          githubLoginClient(config).id && githubLoginClient(config).secret,
        ),
        githubRepositories: githubAppReady(config),
        railway: Boolean(config.railwayClientId && config.railwayClientSecret),
        boat: true,
        email: Boolean(config.emailKey && config.emailFrom),
      },
      commit: config.commit,
      hostingProvider: hostingFor(req.account),
    });
  });
  app.get("/api/projects", signed, (req, res) =>
    res.json({
      projects: store
        .all(
          "SELECT DISTINCT p.id,p.name,p.description,p.state,p.app_url AS appUrl,p.created_at AS createdAt,(p.owner_id=?) AS isOwner FROM projects p JOIN members m ON m.project_id=p.id WHERE m.user_id=? ORDER BY p.created_at DESC",
          req.account.id,
          req.account.id,
        )
        .map((project) => ({ ...project, isOwner: Boolean(project.isOwner) })),
    }),
  );
  const verifiedLead = (req, res, next) =>
    req.account.github_id
      ? next()
      : res
          .status(403)
          .json({ error: "Sign in with GitHub before connecting hosting." });
  app.get("/api/auth/boat", signed, verifiedLead, async (req, res) =>
    res.json(await provider.boatAuth.status(req.account.id)),
  );
  app.post("/api/auth/boat", signed, verifiedLead, async (req, res) =>
    res.json(await provider.boatAuth.start(req.account.id)),
  );
  app.post("/api/auth/boat/billing", signed, verifiedLead, async (req, res) =>
    res.json(await provider.boatAuth.billing(req.account.id)),
  );
  app.get("/api/railway/workspaces", signed, async (req, res) =>
    res.json(
      (await provider.railway(req.account.id, "query{me{workspaces{id name}}}"))
        .me.workspaces,
    ),
  );
  app.post("/api/projects", signed, (req, res) => {
    const hosting = hostingFor(req.account);
    if (
      !req.account.github_id ||
      !githubAppReady(config) ||
      !creationCredential(config, store, req.account.id) ||
      !store.connection(req.account.id, hosting)
    )
      return res.status(409).json({
        error: `Connect GitHub and ${hosting === "boat" ? "Boat" : "Railway"} first.`,
      });
    const b = req.body || {};
    if (
      !name(b.name) ||
      typeof b.description !== "string" ||
      b.description.trim().length < 3 ||
      b.description.length > 10000 ||
      !uuid(b.requestKey)
    )
      return res
        .status(400)
        .json({ error: "Add a project name and a short description." });
    const duplicate = store.get(
      "SELECT id FROM projects WHERE owner_id=? AND create_key=?",
      req.account.id,
      b.requestKey,
    );
    if (duplicate) return res.json({ id: duplicate.id });
    const projectId = id(),
      memberId = id(),
      invitation = token(),
      worker = token();
    const slug = `${
      b.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 28) || "project"
    }-${projectId.slice(0, 8)}`;
    store.transaction(() => {
      store.run(
        `INSERT INTO projects(id,owner_id,name,description,slug,invite_hash,invite_secret,worker_secret,worker_hash,webhook_secret,workspace_id,create_key,created_at,hosting_provider) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        projectId,
        req.account.id,
        b.name.trim(),
        b.description.trim(),
        slug,
        digest(invitation),
        store.seal(invitation),
        store.seal(worker),
        digest(worker),
        store.seal(token()),
        uuid(b.workspaceId) ? b.workspaceId : null,
        b.requestKey,
        now(),
        hosting,
      );
      store.run(
        "INSERT INTO members(id,project_id,user_id,name,prefix,role,created_at) VALUES(?,?,?,?,?,?,?)",
        memberId,
        projectId,
        req.account.id,
        req.account.name,
        `lead-${memberId.slice(0, 8)}`,
        "owner",
        now(),
      );
      if (b.generateName === true)
        store.run(
          "UPDATE projects SET name_source='pending' WHERE id=?",
          projectId,
        );
      store.enqueue(projectId, "provision", `provision:${projectId}`);
      const jobId = id();
      store.run(
        "INSERT INTO jobs(id,project_id,member_id,request_key,text,created_at,updated_at,approval_required) VALUES(?,?,?,?,?,?,?,1)",
        jobId,
        projectId,
        memberId,
        "initial",
        `Build the first version of this website: ${b.description.trim()}`,
        now(),
        now(),
      );
      store.run(
        "INSERT INTO messages VALUES(?,?,?,?,?,?,?)",
        id(),
        projectId,
        memberId,
        jobId,
        "user",
        b.description.trim(),
        now(),
      );
    });
    res.status(201).json({ id: projectId });
  });
  app.post("/api/invites/inspect", (req, res) => {
    const project =
      typeof req.body?.token === "string" && req.body.token.length <= 100
        ? store.get(
            "SELECT p.id,p.name,p.state,u.name AS ownerName FROM projects p JOIN users u ON u.id=p.owner_id WHERE invite_hash=?",
            digest(req.body.token),
          )
        : null;
    if (!project)
      return res.status(404).json({
        error: "This invitation has expired. Ask the team lead for a new one.",
      });
    res.json(project);
  });
  app.post("/api/invites/join", (req, res) => {
    const project =
      typeof req.body?.token === "string" && req.body.token.length <= 100
        ? store.get(
            "SELECT * FROM projects WHERE invite_hash=?",
            digest(req.body.token),
          )
        : null;
    if (!project)
      return res.status(403).json({
        error: "This invitation has expired. Ask the team lead for a new one.",
      });
    if (!name(req.body.name))
      return res
        .status(400)
        .json({ error: "Tell us what to call you (up to 50 characters)." });
    const existing =
      req.account &&
      store.get(
        "SELECT id FROM members WHERE project_id=? AND user_id=?",
        project.id,
        req.account.id,
      );
    if (existing) return res.json({ projectId: project.id });
    if (
      store.get(
        "SELECT COUNT(*) AS total FROM members WHERE project_id=?",
        project.id,
      ).total >= 20
    )
      return res.status(409).json({
        error: "This team is full. Ask the lead to make another project.",
      });
    const user = req.account || store.guest(req.body.name.trim()),
      memberId = id();
    const prefix = `${
      req.body.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 12) || "teammate"
    }-${memberId.slice(0, 4)}`;
    store.run(
      "INSERT INTO members(id,project_id,user_id,name,prefix,created_at) VALUES(?,?,?,?,?,?)",
      memberId,
      project.id,
      user.id,
      req.body.name.trim(),
      prefix,
      now(),
    );
    cookie(res, config, "butler_account", store.session(user.id));
    res.status(201).json({ projectId: project.id });
  });
  app.get("/api/projects/:projectId", signed, membership, (req, res) => {
    const p = req.project;
    const chat = req.query.chat
      ? store.get(
          "SELECT * FROM members WHERE project_id=? AND id=?",
          p.id,
          String(req.query.chat),
        )
      : req.member;
    if (!chat)
      return res
        .status(404)
        .json({ error: "This chat is not in your project." });
    res.json({
      id: p.id,
      name: p.name,
      description: p.description,
      state: p.state,
      error: p.error,
      appUrl: p.app_url,
      repoUrl: p.repo ? `https://github.com/${p.repo}` : null,
      isOwner: p.owner_id === req.account.id,
      codingReady: Boolean(p.codex_ready),
      hostingProvider: p.hosting_provider,
      githubAccess:
        p.state === "github_access" && p.repo && p.owner_id === req.account.id
          ? {
              repo: p.repo,
              url: `/auth/github/install?returnTo=${encodeURIComponent(`/p/${p.id}`)}`,
            }
          : null,
      member: memberView(req.member),
      chatMember: memberView(chat),
      readOnly: chat.id !== req.member.id,
      canSteerChat:
        p.owner_id === req.account.id || chat.user_id === req.account.id,
      members: store.all(
        "SELECT m.id,m.name,m.prefix,m.role,j.state AS agentState,j.started_at AS startedAt,j.finished_at AS finishedAt FROM members m LEFT JOIN jobs j ON j.id=(SELECT id FROM jobs WHERE member_id=m.id ORDER BY created_at DESC,rowid DESC LIMIT 1) WHERE m.project_id=? ORDER BY m.created_at",
        p.id,
      ),
      ownMemberships: store.all(
        "SELECT id,name,prefix,role FROM members WHERE project_id=? AND user_id=?",
        p.id,
        req.account.id,
      ),
      messages: store.chatMessages(chat.id),
      reactions: store.reactionSummary(p.id, req.account.id),
      groupMessages: store.groupMessages(p.id, req.account.id),
      jobs: store.all(
        "SELECT id,member_id AS memberId,request_key AS requestKey,text,state,result,error,pr_number AS prNumber,pr_url AS prUrl,preview_url AS previewUrl,created_at AS createdAt,started_at AS startedAt,finished_at AS finishedAt,merged_at AS mergedAt,published_at AS publishedAt,change_sha AS changeSha,pr_title AS prTitle,artifact_url AS artifactUrl,artifact_ready_at AS artifactReadyAt,(SELECT inspected_at FROM preview_inspections i WHERE i.job_id=jobs.id AND i.user_id=? AND i.sha=jobs.change_sha) AS inspectedAt,approved_at AS approvedAt FROM jobs WHERE member_id=? ORDER BY created_at,rowid",
        req.account.id,
        chat.id,
      ),
      activity: store.all(
        "SELECT j.id,j.member_id AS memberId,substr(j.text,1,100) AS text,j.state,j.error,j.pr_url AS prUrl,j.preview_url AS previewUrl,m.name,j.started_at AS startedAt,j.finished_at AS finishedAt,j.created_at AS createdAt FROM jobs j JOIN members m ON m.id=j.member_id WHERE j.project_id=? ORDER BY j.created_at DESC LIMIT 30",
        p.id,
      ),
      releases: store
        .all(
          "SELECT pr_number AS number,title,author,merge_sha AS sha,merged_at AS mergedAt,published_at AS publishedAt,is_live AS isLive FROM releases WHERE project_id=? ORDER BY merged_at DESC,pr_number DESC",
          p.id,
        )
        .map((r) => ({
          ...r,
          isLive: Boolean(r.isLive),
          url: `https://github.com/${p.repo}/pull/${r.number}`,
        })),
      tasks:
        p.owner_id === req.account.id
          ? store.all(
              "SELECT kind,state,error,attempts FROM tasks WHERE project_id=? AND state!=? ORDER BY updated_at DESC LIMIT 10",
              p.id,
              "done",
            )
          : [],
    });
  });
  app.post("/api/projects/:projectId/wake", signed, membership, (req, res) => {
    if (req.project.hosting_provider === "boat")
      store.enqueue(
        req.project.id,
        "boat-wake",
        `boat-wake:${req.project.id}:${Math.floor(now() / 60000)}`,
      );
    res.json({ ok: true });
  });
  app.get(
    "/api/projects/:projectId/share",
    signed,
    membership,
    async (req, res) => {
      const link = req.project.app_url;
      if (!link)
        return res.status(409).json({
          error:
            "Your website isn’t live yet. You can share it once it’s ready.",
        });
      const url = new URL(link);
      if (url.protocol !== "https:" || url.username || url.password)
        return res.status(409).json({
          error: "The website link isn’t ready yet. Please try again shortly.",
        });
      res.json({
        url: link,
        qr: await QRCode.toDataURL(link, {
          width: 320,
          margin: 2,
          color: { dark: "#153e35", light: "#ffffff" },
          errorCorrectionLevel: "M",
        }),
      });
    },
  );
  app.get(
    "/api/projects/:projectId/invite",
    signed,
    membership,
    owner,
    async (req, res) => {
      const link = `${config.publicUrl}/join#invite=${store.open(req.project.invite_secret)}`;
      res.json({
        url: link,
        qr: await QRCode.toDataURL(link, {
          width: 320,
          margin: 2,
          color: { dark: "#153e35", light: "#ffffff" },
          errorCorrectionLevel: "M",
        }),
      });
    },
  );
  app.post(
    "/api/projects/:projectId/invite/rotate",
    signed,
    membership,
    owner,
    (req, res) => {
      const value = token();
      store.run(
        "UPDATE projects SET invite_hash=?,invite_secret=? WHERE id=?",
        digest(value),
        store.seal(value),
        req.project.id,
      );
      res.json({ ok: true });
    },
  );
  app.post(
    "/api/projects/:projectId/group/messages",
    signed,
    membership,
    (req, res) => {
      const { text, requestKey } = req.body || {};
      if (
        typeof text !== "string" ||
        !text.trim() ||
        text.length > 4000 ||
        text.includes("\0") ||
        !uuid(requestKey)
      )
        return res
          .status(400)
          .json({ error: "Send a message between 1 and 4,000 characters." });
      store.run(
        "INSERT OR IGNORE INTO group_messages VALUES(?,?,?,?,?,?)",
        id(),
        req.project.id,
        req.member.id,
        requestKey,
        text.trim(),
        now(),
      );
      const message = store.get(
        "SELECT id FROM group_messages WHERE member_id=? AND request_key=?",
        req.member.id,
        requestKey,
      );
      res.json({
        message: store
          .groupMessages(req.project.id, req.account.id)
          .find((value) => value.id === message.id),
      });
    },
  );
  app.post(
    "/api/projects/:projectId/reactions",
    signed,
    membership,
    (req, res) => {
      const { targetType, targetId, emoji, active } = req.body || {};
      if (
        !["message", "preview"].includes(targetType) ||
        typeof targetId !== "string" ||
        !/^[a-zA-Z0-9:._-]{1,200}$/.test(targetId) ||
        !reactionEmojis.has(emoji) ||
        typeof active !== "boolean"
      )
        return res
          .status(400)
          .json({ error: "Choose a message or preview and an emoji." });
      const target =
        targetType === "preview"
          ? store.get(
              "SELECT id FROM jobs WHERE id=? AND project_id=? AND (artifact_url IS NOT NULL OR preview_url IS NOT NULL)",
              targetId,
              req.project.id,
            )
          : store.get(
              `SELECT id FROM messages WHERE id=? AND project_id=?
           UNION ALL SELECT j.id||':'||e.event_key FROM job_events e JOIN jobs j ON j.id=e.job_id WHERE j.id||':'||e.event_key=? AND j.project_id=?
           UNION ALL SELECT id FROM group_messages WHERE id=? AND project_id=? LIMIT 1`,
              targetId,
              req.project.id,
              targetId,
              req.project.id,
              targetId,
              req.project.id,
            );
      if (!target)
        return res
          .status(404)
          .json({ error: "This message or preview isn’t in your project." });
      if (active)
        store.run(
          "INSERT OR IGNORE INTO reactions VALUES(?,?,?,?,?,?,?)",
          req.project.id,
          targetType,
          targetId,
          emoji,
          req.account.id,
          req.member.id,
          now(),
        );
      else
        store.run(
          "DELETE FROM reactions WHERE project_id=? AND target_type=? AND target_id=? AND emoji=? AND user_id=?",
          req.project.id,
          targetType,
          targetId,
          emoji,
          req.account.id,
        );
      res.json({
        reactions: store.reactionSummary(req.project.id, req.account.id),
      });
    },
  );
  app.post(
    "/api/projects/:projectId/messages",
    signed,
    membership,
    (req, res) => {
      const chat = req.query.chat
        ? store.get(
            "SELECT * FROM members WHERE id=? AND project_id=?",
            String(req.query.chat),
            req.project.id,
          )
        : req.member;
      if (!chat)
        return res
          .status(404)
          .json({ error: "This chat isn’t in your project." });
      const text = req.body?.text;
      if (
        typeof text !== "string" ||
        !text.trim() ||
        text.length > 20000 ||
        text.includes("\0") ||
        !uuid(req.body.requestKey)
      )
        return res
          .status(400)
          .json({ error: "Send a request between 1 and 20,000 characters." });
      if (
        /^(?:please\s+)?(?:make (?:the change|this the website|the website have that)|apply (?:this|the change)|publish (?:it|this)|ship it)[.!?]*$/i.test(
          text.trim(),
        )
      ) {
        const job = store.get(
          "SELECT * FROM jobs WHERE project_id=? AND member_id=? AND state='awaiting_approval' ORDER BY inspected_at DESC,created_at DESC LIMIT 1",
          req.project.id,
          chat.id,
        );
        if (!job)
          return res.status(409).json({
            error:
              "Inspect a ready preview first, then choose Make this the website.",
          });
        return approveJob(req, res, job, job.change_sha);
      }
      const jobId = store.requestChange(
        req.project.id,
        chat,
        req.account,
        text.trim(),
        req.body.requestKey,
      );
      res.status(202).json({ jobId });
    },
  );
  function ownedJob(req, res, next) {
    req.job = store.get(
      "SELECT * FROM jobs WHERE id=? AND project_id=? AND (member_id=? OR ?=1)",
      req.params.jobId,
      req.project.id,
      req.member.id,
      req.project.owner_id === req.account.id ? 1 : 0,
    );
    if (!req.job)
      return res
        .status(404)
        .json({ error: "This request is not in your chat." });
    next();
  }
  app.post(
    "/api/projects/:projectId/jobs/:jobId/inspect",
    signed,
    membership,
    ownedJob,
    (req, res) => {
      if (
        req.job.state !== "awaiting_approval" ||
        !req.job.artifact_url ||
        req.body.sha !== req.job.change_sha
      )
        return res
          .status(409)
          .json({ error: "Open the latest ready preview before applying it." });
      store.run("UPDATE jobs SET inspected_at=? WHERE id=?", now(), req.job.id);
      store.run(
        "INSERT INTO preview_inspections VALUES(?,?,?,?) ON CONFLICT(job_id,user_id) DO UPDATE SET sha=excluded.sha,inspected_at=excluded.inspected_at",
        req.job.id,
        req.account.id,
        req.job.change_sha,
        now(),
      );
      res.json({ ok: true });
    },
  );
  app.post(
    "/api/projects/:projectId/jobs/:jobId/approve",
    signed,
    membership,
    ownedJob,
    (req, res) => {
      return approveJob(req, res, req.job, req.body.sha);
    },
  );
  function approveJob(req, res, job, sha) {
    if (sha !== job.change_sha)
      return res.status(409).json({
        error: "The preview changed. Inspect the latest version first.",
      });
    if (job.approved_at) return res.json({ ok: true, jobId: job.id });
    if (
      store.get(
        "SELECT 1 FROM jobs WHERE member_id=? AND request_key NOT LIKE 'review-fix:%' AND created_at>? LIMIT 1",
        job.member_id,
        job.created_at,
      )
    )
      return res.status(409).json({
        error:
          "This preview has been updated. Inspect the latest version in this chat.",
      });
    if (
      job.state !== "awaiting_approval" ||
      !store.get(
        "SELECT 1 FROM preview_inspections WHERE job_id=? AND user_id=? AND sha=?",
        job.id,
        req.account.id,
        sha,
      ) ||
      !job.artifact_url ||
      !job.artifact_ready_at ||
      !job.pr_title ||
      !job.branch
    )
      return res.status(409).json({
        error: "Inspect your preview first, then choose Make this the website.",
      });
    store.transaction(() => {
      store.run(
        "UPDATE jobs SET state='creating_pr',approved_at=?,approved_by=?,updated_at=? WHERE id=?",
        now(),
        req.account.id,
        now(),
        job.id,
      );
      store.humanMessage(
        req.project.id,
        job.member_id,
        job.id,
        req.account,
        "Make this the website.",
      );
      store.recordEvent(
        job.id,
        "approved",
        "status",
        `${req.account.name} approved this preview. Creating the pull request for review.`,
      );
      store.enqueue(
        req.project.id,
        "open-pr",
        `open-pr:${job.id}:${job.change_sha}`,
        { jobId: job.id, sha: job.change_sha },
      );
    });
    return res.status(202).json({ ok: true, jobId: job.id });
  }
  app.post(
    "/api/projects/:projectId/jobs/:jobId/retry",
    signed,
    membership,
    ownedJob,
    (req, res) => {
      const job = req.job;
      if (job.state !== "preview_failed" || !job.change_sha)
        return res
          .status(409)
          .json({ error: "There is no preview step to retry." });
      const kind = job.approved_at ? "open-pr" : "artifact";
      store.run(
        "UPDATE tasks SET state='queued',attempts=0,available_at=0,error=NULL WHERE project_id=? AND dedupe_key=? AND state='failed'",
        req.project.id,
        `${kind}:${job.id}:${job.change_sha}`,
      );
      store.run(
        "UPDATE jobs SET state=?,error=NULL,updated_at=? WHERE id=?",
        job.approved_at ? "creating_pr" : "building_preview",
        now(),
        job.id,
      );
      res.status(202).json({ ok: true });
    },
  );
  app.get(
    "/api/projects/:projectId/codex",
    signed,
    membership,
    owner,
    async (req, res) => {
      const status = await provider.worker(req.project, "/auth/status");
      store.run(
        "UPDATE projects SET codex_ready=? WHERE id=?",
        status.state === "connected" ? 1 : 0,
        req.project.id,
      );
      res.json(status);
    },
  );
  app.post(
    "/api/projects/:projectId/codex",
    signed,
    membership,
    owner,
    async (req, res) => {
      if (req.project.state !== "ready")
        return res.status(409).json({
          error:
            "Your workspace is still being prepared. You can invite teammates now.",
        });
      res.json(await provider.worker(req.project, "/auth/start", "POST"));
    },
  );
  app.post(
    "/api/projects/:projectId/github-access",
    signed,
    membership,
    owner,
    async (req, res) => {
      if (req.project.state !== "github_access")
        return res.json({ ready: true });
      if (!req.project.repo)
        return res
          .status(409)
          .json({ error: "The project repository has not been created yet." });
      try {
        await provider.createRepository(req.project);
      } catch (error) {
        if (error.code === "github_repository_access_required")
          return res.json({ ready: false });
        throw error;
      }
      store.transaction(() => {
        store.run(
          "UPDATE tasks SET state='queued',attempts=0,error=NULL,available_at=? WHERE project_id=? AND kind='provision' AND state='failed'",
          now(),
          req.project.id,
        );
        store.run(
          "UPDATE projects SET state='queued',error=NULL WHERE id=? AND state='github_access'",
          req.project.id,
        );
      });
      res.json({ ready: true });
    },
  );
  app.post(
    "/api/projects/:projectId/retry",
    signed,
    membership,
    owner,
    (req, res) => {
      store.run(
        "UPDATE tasks SET state='queued',attempts=0,error=NULL,available_at=? WHERE project_id=? AND state='failed'",
        now(),
        req.project.id,
      );
      store.run(
        "UPDATE projects SET state=CASE WHEN state='failed' THEN 'queued' ELSE state END,error=NULL WHERE id=?",
        req.project.id,
      );
      res.json({ ok: true });
    },
  );
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "Unknown Butler endpoint." }),
  );
  if (existsSync(config.frontend))
    app.use(express.static(config.frontend, { index: false, maxAge: "1h" }));
  app.get("/{*path}", (_req, res) => {
    if (!existsSync(path.join(config.frontend, "index.html")))
      return res
        .status(503)
        .type("text")
        .send(
          "Build the Butler frontend with cd app && npm ci && npm run build.",
        );
    res
      .set("Cache-Control", "no-store")
      .sendFile(path.join(config.frontend, "index.html"));
  });
  app.use((error, _req, res, _next) => {
    console.error(`[platform] ${error.provider || error.name}: request failed`);
    if (res.headersSent) return res.end();
    const status =
      error.type === "entity.too.large"
        ? 413
        : error.status >= 400 && error.status < 500
          ? error.status
          : 502;
    res.status(status).json({
      error: error.provider
        ? error.message.slice(0, 350)
        : status === 413
          ? "This request is too large."
          : "Something interrupted this request. Please try again.",
    });
  });
  return { app, server, store, provider, provisioner };
}

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  process.umask(0o077);
  const config = configuration(),
    platform = createPlatform(config);
  const retire = async () => {
    const legacy = await retireLegacyGithub(config, platform.store);
    await platform.provider.boatAuth?.retire();
    console.log(
      `[github] Legacy grants revoked: ${legacy.revoked}; quarantined pending revocation: ${legacy.pending}`,
    );
  };
  retire().catch(() =>
    console.error("[github] Legacy grant cleanup will retry."),
  );
  const retireTimer = setInterval(
    () =>
      retire().catch(() =>
        console.error("[github] Legacy grant cleanup will retry."),
      ),
    60000,
  );
  retireTimer.unref();
  const stop = platform.provisioner.start();
  platform.server.listen(config.port, "0.0.0.0", () =>
    console.log(`Butler portal listening on ${config.port}`),
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => {
      stop();
      clearInterval(retireTimer);
      platform.server.close(() => {
        platform.store.close();
        process.exit(0);
      });
      setTimeout(() => process.exit(0), 15000).unref();
    });
}
