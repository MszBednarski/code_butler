import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  randomUUID,
  createHash,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";

export const id = () => randomUUID();
export const token = () => randomBytes(32).toString("base64url");
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export const now = () => Date.now();

export function createStore(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keyFile = path.join(directory, "master.key");
  let key;
  try {
    key = readFileSync(keyFile);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    key = randomBytes(32);
    writeFileSync(keyFile, key, { mode: 0o600, flag: "wx" });
  }
  if (key.length !== 32) throw new Error("Invalid persistent encryption key");
  const dbFile = path.join(directory, "butler.sqlite");
  const db = new DatabaseSync(dbFile);
  chmodSync(dbFile, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, github_id TEXT UNIQUE, github_login TEXT,
      email TEXT UNIQUE, recovery_hash TEXT UNIQUE, recovery_secret TEXT, merged_into TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (
      hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, secret TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS email_aliases (email TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS connections (
      user_id TEXT NOT NULL REFERENCES users(id), provider TEXT NOT NULL, secret TEXT NOT NULL,
      PRIMARY KEY(user_id, provider));
    CREATE TABLE IF NOT EXISTS oauth_states (
      hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, user_id TEXT, provider TEXT NOT NULL,
      return_to TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS email_links (
      hash TEXT PRIMARY KEY, email TEXT NOT NULL, user_id TEXT, return_to TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
      description TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, invite_hash TEXT NOT NULL UNIQUE,
      invite_secret TEXT NOT NULL, worker_secret TEXT NOT NULL, worker_hash TEXT NOT NULL UNIQUE,
      webhook_secret TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued', error TEXT,
      repo TEXT, app_url TEXT, worker_url TEXT, resources TEXT NOT NULL DEFAULT '{}',
      workspace_id TEXT, create_key TEXT, codex_ready INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, UNIQUE(owner_id,create_key));
    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), user_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL, prefix TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
      thread_id TEXT, branch TEXT, pr_number INTEGER, created_at INTEGER NOT NULL,
      UNIQUE(project_id,prefix));
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), member_id TEXT NOT NULL REFERENCES members(id),
      request_key TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
      result TEXT, error TEXT, pr_number INTEGER, pr_url TEXT, preview_url TEXT, merge_sha TEXT,
      lease_until INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(member_id,request_key));
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), member_id TEXT NOT NULL REFERENCES members(id),
      job_id TEXT REFERENCES jobs(id), role TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), kind TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0, error TEXT, available_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS previews (
      project_id TEXT NOT NULL REFERENCES projects(id), pr_number INTEGER NOT NULL,
      environment_id TEXT, url TEXT, commit_sha TEXT, state TEXT NOT NULL DEFAULT 'queued',
      PRIMARY KEY(project_id,pr_number));
    CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(project_id,state,created_at);
    CREATE INDEX IF NOT EXISTS members_user ON members(user_id,project_id);
    CREATE INDEX IF NOT EXISTS messages_member ON messages(member_id,created_at);
    CREATE TABLE IF NOT EXISTS job_events (
      job_id TEXT NOT NULL REFERENCES jobs(id), event_key TEXT NOT NULL,
      kind TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(job_id,event_key));
    CREATE TABLE IF NOT EXISTS releases (
      project_id TEXT NOT NULL REFERENCES projects(id), pr_number INTEGER NOT NULL,
      title TEXT NOT NULL, author TEXT, merge_sha TEXT NOT NULL,
      merged_at INTEGER, published_at INTEGER, is_live INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(project_id,pr_number));
  `);
  if (
    !db
      .prepare("PRAGMA table_info(projects)")
      .all()
      .some((column) => column.name === "codex_ready")
  )
    db.exec(
      "ALTER TABLE projects ADD COLUMN codex_ready INTEGER NOT NULL DEFAULT 0",
    );
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  if (
    !db
      .prepare("PRAGMA table_info(projects)")
      .all()
      .some((column) => column.name === "hosting_provider")
  )
    db.exec(
      "ALTER TABLE projects ADD COLUMN hosting_provider TEXT NOT NULL DEFAULT 'railway'",
    );
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const jobColumns = new Set(
    db
      .prepare("PRAGMA table_info(jobs)")
      .all()
      .map((c) => c.name),
  );
  for (const column of [
    "started_at",
    "finished_at",
    "merged_at",
    "published_at",
  ])
    if (!jobColumns.has(column))
      db.exec(`ALTER TABLE jobs ADD COLUMN ${column} INTEGER`);
  for (const [column, type] of Object.entries({
    approval_required: "INTEGER NOT NULL DEFAULT 0",
    change_sha: "TEXT",
    branch: "TEXT",
    pr_title: "TEXT",
    pr_body: "TEXT",
    artifact_url: "TEXT",
    artifact_number: "INTEGER",
    artifact_ready_at: "INTEGER",
    inspected_at: "INTEGER",
    approved_at: "INTEGER",
  }))
    if (!jobColumns.has(column))
      db.exec(`ALTER TABLE jobs ADD COLUMN ${column} ${type}`);
  // Preserve older outcomes without pretending their historical start/merge times were recorded.
  db.exec(`INSERT OR IGNORE INTO releases(project_id,pr_number,title,author,merge_sha,merged_at,published_at,is_live)
    SELECT j.project_id,j.pr_number,substr(j.text,1,100),m.name,j.merge_sha,j.merged_at,j.published_at,(j.state='live')
    FROM jobs j JOIN members m ON m.id=j.member_id WHERE j.pr_number IS NOT NULL AND j.merge_sha IS NOT NULL ORDER BY j.created_at`);
  for (const job of all(
    "SELECT id,error,state FROM jobs WHERE error IS NOT NULL",
  ))
    recordEvent(
      job.id,
      `previous-error:${digest(job.error)}`,
      job.state === "needs_attention" ? "review" : "error",
      job.error,
    );
  const transaction = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  function seal(value) {
    const nonce = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", key, nonce);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString(
      "base64url",
    );
  }
  function open(value) {
    const data = Buffer.from(value, "base64url"),
      cipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
    cipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([
        cipher.update(data.subarray(28)),
        cipher.final(),
      ]).toString("utf8"),
    );
  }
  function connection(user, provider, value) {
    if (value !== undefined)
      run(
        "INSERT INTO connections VALUES(?,?,?) ON CONFLICT(user_id,provider) DO UPDATE SET secret=excluded.secret",
        user,
        provider,
        seal(value),
      );
    const row = get(
      "SELECT secret FROM connections WHERE user_id=? AND provider=?",
      user,
      provider,
    );
    return row ? open(row.secret) : null;
  }
  function setting(name, value) {
    if (value !== undefined)
      run(
        "INSERT INTO settings VALUES(?,?) ON CONFLICT(name) DO UPDATE SET secret=excluded.secret",
        name,
        seal(value),
      );
    const row = get("SELECT secret FROM settings WHERE name=?", name);
    return row ? open(row.secret) : null;
  }
  function guest(name = "Teammate") {
    const user = { id: id(), name };
    run(
      "INSERT INTO users(id,name,created_at) VALUES(?,?,?)",
      user.id,
      name,
      now(),
    );
    return get("SELECT * FROM users WHERE id=?", user.id);
  }
  function session(userId) {
    const value = token();
    run(
      "INSERT INTO sessions VALUES(?,?,?)",
      digest(value),
      userId,
      now() + 30 * 86400000,
    );
    return value;
  }
  function revokeAccess(userId) {
    run("DELETE FROM sessions WHERE user_id=?", userId);
    run("DELETE FROM oauth_states WHERE user_id=?", userId);
    run("DELETE FROM email_links WHERE user_id=?", userId);
    run(
      "UPDATE users SET recovery_hash=NULL,recovery_secret=NULL WHERE id=?",
      userId,
    );
  }
  function mergeUsers(from, to) {
    if (!from || from === to) return;
    const source = get("SELECT * FROM users WHERE id=?", from),
      target = get("SELECT * FROM users WHERE id=?", to);
    if (
      source.github_id &&
      target.github_id &&
      source.github_id !== target.github_id
    ) {
      const error = new Error(
        "This email belongs to a different GitHub account. Sign out to use that account, or choose another email.",
      );
      error.status = 409;
      error.provider = "Account";
      throw error;
    }
    transaction(() => {
      run("UPDATE email_aliases SET user_id=? WHERE user_id=?", to, from);
      if (source.email)
        run(
          "INSERT INTO email_aliases VALUES(?,?) ON CONFLICT(email) DO UPDATE SET user_id=excluded.user_id",
          source.email,
          to,
        );
      run("UPDATE members SET user_id=? WHERE user_id=?", to, from);
      run("UPDATE projects SET owner_id=? WHERE owner_id=?", to, from);
      revokeAccess(from);
      run(
        "INSERT OR IGNORE INTO connections SELECT ?,provider,secret FROM connections WHERE user_id=?",
        to,
        from,
      );
      run("DELETE FROM connections WHERE user_id=?", from);
      // Old guest credentials must never become credentials for the target.
      run(
        "UPDATE users SET github_id=NULL,github_login=NULL,email=NULL,merged_into=? WHERE id=?",
        to,
        from,
      );
      run(
        "UPDATE users SET github_id=COALESCE(github_id,?),github_login=COALESCE(github_login,?),email=COALESCE(email,?) WHERE id=?",
        source.github_id,
        source.github_login,
        source.email,
        to,
      );
    });
  }
  function enqueue(project, kind, dedupeKey, payload = {}, reactivate = false) {
    run(
      "INSERT OR IGNORE INTO tasks VALUES(?,?,?,?,?,?,0,NULL,?,?)",
      id(),
      project,
      kind,
      dedupeKey,
      JSON.stringify(payload),
      "queued",
      now(),
      now(),
    );
    if (reactivate)
      run(
        "UPDATE tasks SET state='queued',attempts=0,error=NULL,available_at=?,updated_at=? WHERE dedupe_key=? AND state IN ('done','failed')",
        now(),
        now(),
        dedupeKey,
      );
  }
  function claimJob(project, { supportsApproval = true } = {}) {
    return transaction(() => {
      const job = get(
        "SELECT * FROM jobs WHERE project_id=? AND (approval_required=0 OR ?=1) AND (state='queued' OR (state='working' AND lease_until<?)) ORDER BY created_at LIMIT 1",
        project,
        supportsApproval ? 1 : 0,
        now(),
      );
      if (!job) return null;
      run(
        "UPDATE jobs SET state='working',lease_until=?,updated_at=?,started_at=COALESCE(started_at,?),finished_at=NULL WHERE id=?",
        now() + 90000,
        now(),
        now(),
        job.id,
      );
      recordEvent(
        job.id,
        job.started_at ? `resume:${now()}` : "started",
        "status",
        job.started_at
          ? "Resuming your saved request."
          : "I’m starting work on your request.",
      );
      return {
        ...job,
        state: "working",
        started_at: job.started_at || now(),
        member: get("SELECT * FROM members WHERE id=?", job.member_id),
      };
    });
  }
  function recordEvent(jobId, key, kind, text, at = now()) {
    run(
      "INSERT OR IGNORE INTO job_events(job_id,event_key,kind,text,created_at) VALUES(?,?,?,?,?)",
      jobId,
      key,
      kind,
      text,
      at,
    );
  }
  function recordRelease(project, number, sha, metadata = {}) {
    const job = get(
      "SELECT j.pr_title,m.name FROM jobs j JOIN members m ON m.id=j.member_id WHERE j.project_id=? AND j.pr_number=? ORDER BY j.created_at DESC LIMIT 1",
      project,
      number,
    );
    const mergedAt = Number.isFinite(metadata.mergedAt)
      ? metadata.mergedAt
      : now();
    run(
      `INSERT INTO releases(project_id,pr_number,title,author,merge_sha,merged_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(project_id,pr_number) DO UPDATE SET title=excluded.title,author=COALESCE(excluded.author,releases.author),merge_sha=excluded.merge_sha,merged_at=CASE WHEN ? THEN excluded.merged_at ELSE COALESCE(releases.merged_at,excluded.merged_at) END`,
      project,
      number,
      String(metadata.title || job?.pr_title || `PR #${number}`).slice(0, 200),
      job?.name || metadata.author || null,
      sha,
      mergedAt,
      Number.isFinite(metadata.mergedAt) ? 1 : 0,
    );
  }
  function recordMerge(project, number, sha, metadata = {}) {
    return transaction(() => {
      recordRelease(project, number, sha, metadata);
      const resources = JSON.parse(
        get("SELECT resources FROM projects WHERE id=?", project).resources,
      );
      const state = resources.deployedSha === sha ? "live" : "deploying";
      run(
        "UPDATE jobs SET state=?,error=NULL,merge_sha=?,updated_at=?,merged_at=COALESCE(merged_at,?),finished_at=CASE WHEN ?='live' THEN COALESCE(finished_at,?) ELSE NULL END WHERE project_id=? AND pr_number=? AND state IN ('reviewing','needs_attention','preview_failed','deploying','publish_failed')",
        state,
        sha,
        now(),
        Number.isFinite(metadata.mergedAt) ? metadata.mergedAt : now(),
        state,
        now(),
        project,
        number,
      );
      if (state === "live")
        run(
          "UPDATE releases SET is_live=1 WHERE project_id=? AND pr_number=?",
          project,
          number,
        );
      for (const job of all(
        "SELECT id FROM jobs WHERE project_id=? AND pr_number=?",
        project,
        number,
      ))
        recordEvent(
          job.id,
          `merged:${sha}`,
          "status",
          `PR #${number} merged. ${state === "live" ? "Your change is live." : "Publishing the website update."}`,
        );
      if (state !== "live") {
        const key = `main:${project}:${sha}`;
        enqueue(project, "deploy", key, { sha });
        run(
          "UPDATE tasks SET state='queued',attempts=0,error=NULL,available_at=? WHERE dedupe_key=? AND state='done'",
          now(),
          key,
        );
      }
      return state;
    });
  }
  return {
    db,
    get,
    all,
    run,
    transaction,
    seal,
    open,
    connection,
    setting,
    guest,
    session,
    mergeUsers,
    revokeAccess,
    enqueue,
    claimJob,
    recordMerge,
    recordEvent,
    recordRelease,
    close: () => db.close(),
  };
}
