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
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
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
  function mergeUsers(from, to) {
    if (!from || from === to) return;
    transaction(() => {
      run("UPDATE members SET user_id=? WHERE user_id=?", to, from);
      run("UPDATE projects SET owner_id=? WHERE owner_id=?", to, from);
      run("UPDATE sessions SET user_id=? WHERE user_id=?", to, from);
      run(
        "INSERT OR IGNORE INTO connections SELECT ?,provider,secret FROM connections WHERE user_id=?",
        to,
        from,
      );
      run("DELETE FROM connections WHERE user_id=?", from);
      // Keep the old account as a recovery alias. It holds no provider login.
      run(
        "UPDATE users SET github_id=NULL,github_login=NULL,email=NULL,merged_into=? WHERE id=?",
        to,
        from,
      );
    });
  }
  function enqueue(project, kind, dedupeKey, payload = {}) {
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
  }
  function claimJob(project) {
    return transaction(() => {
      const job = get(
        "SELECT * FROM jobs WHERE project_id=? AND (state='queued' OR (state='working' AND lease_until<?)) ORDER BY created_at LIMIT 1",
        project,
        now(),
      );
      if (!job) return null;
      run(
        "UPDATE jobs SET state='working',lease_until=?,updated_at=? WHERE id=?",
        now() + 90000,
        now(),
        job.id,
      );
      return {
        ...job,
        state: "working",
        member: get("SELECT * FROM members WHERE id=?", job.member_id),
      };
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
    enqueue,
    claimJob,
    close: () => db.close(),
  };
}
