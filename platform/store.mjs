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

function isContinuation(text) {
  const instruction =
    text.match(
      /^Group request from [^\n]+:\n([\s\S]*?)\n\nRecent group conversation/,
    )?.[1] || text;
  return /^(?:please\s+)?(?:cont(?:inue|ine)?|resume|retry|try again)[.!?]*$/i.test(
    instruction.trim(),
  );
}

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
    CREATE TABLE IF NOT EXISTS reactions (
      project_id TEXT NOT NULL REFERENCES projects(id), target_type TEXT NOT NULL,
      target_id TEXT NOT NULL, emoji TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
      member_id TEXT NOT NULL REFERENCES members(id), created_at INTEGER NOT NULL,
      PRIMARY KEY(project_id,target_type,target_id,emoji,user_id));
    CREATE TABLE IF NOT EXISTS group_messages (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
      member_id TEXT NOT NULL REFERENCES members(id), request_key TEXT NOT NULL,
      text TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(member_id,request_key));
    CREATE INDEX IF NOT EXISTS group_messages_project ON group_messages(project_id,created_at);
    CREATE TABLE IF NOT EXISTS message_authors (
      message_id TEXT PRIMARY KEY REFERENCES messages(id),
      user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS preview_inspections (
      job_id TEXT NOT NULL REFERENCES jobs(id), user_id TEXT NOT NULL REFERENCES users(id),
      sha TEXT NOT NULL, inspected_at INTEGER NOT NULL, PRIMARY KEY(job_id,user_id));
    CREATE TABLE IF NOT EXISTS request_receipts (
      member_id TEXT NOT NULL REFERENCES members(id), request_key TEXT NOT NULL,
      job_id TEXT NOT NULL REFERENCES jobs(id), PRIMARY KEY(member_id,request_key));
    CREATE TABLE IF NOT EXISTS preview_visibility (
      job_id TEXT NOT NULL REFERENCES jobs(id), user_id TEXT NOT NULL REFERENCES users(id),
      hidden_revision INTEGER, dismissed_at INTEGER NOT NULL, title TEXT NOT NULL,
      PRIMARY KEY(job_id,user_id));
    CREATE TABLE IF NOT EXISTS group_agents (
      project_id TEXT PRIMARY KEY REFERENCES projects(id),
      member_id TEXT NOT NULL UNIQUE REFERENCES members(id));
    CREATE TABLE IF NOT EXISTS group_requests (
      message_id TEXT PRIMARY KEY REFERENCES group_messages(id),
      job_id TEXT NOT NULL REFERENCES jobs(id));
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
  if (
    !all("PRAGMA table_info(projects)").some(
      (column) => column.name === "name_source",
    )
  ) {
    db.exec(
      "ALTER TABLE projects ADD COLUMN name_source TEXT NOT NULL DEFAULT 'manual'",
    );
    for (const project of all("SELECT id,name,description FROM projects")) {
      const oldName = project.description
        .trim()
        .split(/\s+/)
        .slice(0, 5)
        .join(" ")
        .slice(0, 45);
      if (project.name === oldName || project.name === "Our next idea")
        run("UPDATE projects SET name_source='pending' WHERE id=?", project.id);
    }
  }
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
    approved_by: "TEXT",
    request_revision: "INTEGER NOT NULL DEFAULT 0",
    pending_text: "TEXT",
    requested_by: "TEXT",
  }))
    if (!jobColumns.has(column))
      db.exec(`ALTER TABLE jobs ADD COLUMN ${column} ${type}`);
  db.exec(`INSERT OR IGNORE INTO request_receipts SELECT member_id,request_key,id FROM jobs;
    UPDATE jobs SET state='superseded',error=NULL WHERE approval_required=1 AND approved_at IS NULL AND pr_number IS NULL AND state='awaiting_approval'
    AND EXISTS (SELECT 1 FROM jobs newer WHERE newer.member_id=jobs.member_id AND newer.request_key NOT LIKE 'review-fix:%'
      AND (newer.created_at>jobs.created_at OR (newer.created_at=jobs.created_at AND newer.rowid>jobs.rowid)));
  `);
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
  let transactionDepth = 0;
  const transaction = (fn) => {
    const level = transactionDepth;
    db.exec(level ? `SAVEPOINT nested_${level}` : "BEGIN IMMEDIATE");
    transactionDepth++;
    try {
      const value = fn();
      db.exec(level ? `RELEASE nested_${level}` : "COMMIT");
      return value;
    } catch (error) {
      db.exec(
        level
          ? `ROLLBACK TO nested_${level}; RELEASE nested_${level}`
          : "ROLLBACK",
      );
      throw error;
    } finally {
      transactionDepth--;
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
      run("UPDATE OR IGNORE reactions SET user_id=? WHERE user_id=?", to, from);
      run("DELETE FROM reactions WHERE user_id=?", from);
      run("UPDATE message_authors SET user_id=? WHERE user_id=?", to, from);
      run(
        "UPDATE OR IGNORE preview_inspections SET user_id=? WHERE user_id=?",
        to,
        from,
      );
      run("DELETE FROM preview_inspections WHERE user_id=?", from);
      run("UPDATE jobs SET approved_by=? WHERE approved_by=?", to, from);
      run("UPDATE jobs SET requested_by=? WHERE requested_by=?", to, from);
      run(
        "UPDATE OR IGNORE preview_visibility SET user_id=? WHERE user_id=?",
        to,
        from,
      );
      run("DELETE FROM preview_visibility WHERE user_id=?", from);
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
  function claimJob(
    project,
    { supportsApproval = true, supportsRevisions = true } = {},
  ) {
    return transaction(() => {
      const job = get(
        "SELECT * FROM jobs WHERE project_id=? AND (approval_required=0 OR ?=1) AND (request_revision=0 OR ?=1) AND (state='queued' OR (state='working' AND lease_until<?)) ORDER BY created_at LIMIT 1",
        project,
        supportsApproval ? 1 : 0,
        supportsRevisions ? 1 : 0,
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
        job.started_at ? `resume:${now()}` : `started:${job.request_revision}`,
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
  // A pull can contain a request and several automatic repairs in one chat.
  // Keep shared progress on one stable job per chat, including on retries.
  function recordPullEvent(project, number, key, kind, text, at = now()) {
    for (const job of all(
      `SELECT j.id FROM jobs j WHERE j.project_id=? AND j.pr_number=?
       AND j.id=(SELECT first.id FROM jobs first WHERE first.member_id=j.member_id AND first.pr_number=j.pr_number ORDER BY first.created_at,first.rowid LIMIT 1)`,
      project,
      number,
    ))
      recordEvent(job.id, key, kind, text, at);
  }
  function chatSql(member, viewer = null, assistantOnly = false) {
    let sql = `SELECT m.id,m.job_id AS jobId,m.role,m.text,m.created_at AS createdAt,'message' AS kind,CASE m.role WHEN 'user' THEN 0 ELSE 2 END AS position,m.rowid AS sequence,NULL AS eventKey,NULL AS prNumber,u.name AS authorName,a.role AS authorRole FROM messages m LEFT JOIN message_authors a ON a.message_id=m.id LEFT JOIN users u ON u.id=a.user_id WHERE m.member_id=? ${assistantOnly ? "AND m.role='assistant'" : ""}
      UNION ALL SELECT j.id||':'||e.event_key,j.id,'assistant',e.text,e.created_at,e.kind,1,e.rowid,e.event_key,j.pr_number,NULL,NULL FROM job_events e JOIN jobs j ON j.id=e.job_id WHERE j.member_id=?`;
    const args = [member, member];
    if (viewer) {
      sql += ` UNION ALL SELECT 'saved-preview:'||j.id,j.id,'assistant',v.title,v.dismissed_at,'saved-preview',3,v.rowid,NULL,NULL,NULL,NULL
        FROM preview_visibility v JOIN jobs j ON j.id=v.job_id WHERE j.member_id=? AND v.user_id=?`;
      args.push(member, viewer);
    }
    return { sql, args };
  }
  function chatMessages(member, viewer = null) {
    const { sql, args } = chatSql(member, viewer);
    return presentMessages(
      all(
        `SELECT * FROM (${sql}) ORDER BY createdAt,position,sequence,id`,
        ...args,
      ),
    );
  }
  function historyPage(source, before = null, limit = 40) {
    let cursor = null;
    if (before) {
      try {
        cursor = JSON.parse(Buffer.from(before, "base64url").toString());
      } catch {
        /* Invalid cursor is rejected below. */
      }
      if (
        typeof before !== "string" ||
        before.length > 1500 ||
        !Array.isArray(cursor) ||
        cursor.length !== 4 ||
        !cursor.slice(0, 3).every(Number.isSafeInteger) ||
        typeof cursor[3] !== "string" ||
        cursor[3].length > 800
      )
        throw Object.assign(new Error("Invalid chat history cursor"), {
          status: 400,
        });
    }
    const rows = all(
      `SELECT * FROM (${source.sql}) ${cursor ? "WHERE (createdAt,position,sequence,id)<(?,?,?,?)" : ""} ORDER BY createdAt DESC,position DESC,sequence DESC,id DESC LIMIT ?`,
      ...source.args,
      ...(cursor || []),
      limit + 1,
    );
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit).reverse(),
      oldest = selected[0];
    return {
      items: presentMessages(selected),
      before: hasMore
        ? Buffer.from(
            JSON.stringify([
              oldest.createdAt,
              oldest.position,
              oldest.sequence,
              oldest.id,
            ]),
          ).toString("base64url")
        : null,
    };
  }
  function chatPage(member, viewer, before = null) {
    return historyPage(chatSql(member, viewer), before);
  }
  function groupPage(project, viewer, before = null) {
    const source = {
      sql: `SELECT g.id,r.job_id AS jobId,'user' AS role,g.text,g.created_at AS createdAt,'human' AS kind,0 AS position,g.rowid AS sequence,NULL AS eventKey,NULL AS prNumber,m.name AS authorName,(CASE WHEN m.user_id=? THEN 'own:' ELSE 'human:' END)||m.id AS authorRole FROM group_messages g JOIN members m ON m.id=g.member_id LEFT JOIN group_requests r ON r.message_id=g.id WHERE g.project_id=?`,
      args: [viewer, project],
    };
    const agent = groupAgent(project);
    if (agent) {
      const bot = chatSql(agent.id, viewer, true);
      source.sql += ` UNION ALL ${bot.sql}`;
      source.args.push(...bot.args);
    }
    const page = historyPage(source, before);
    return {
      ...page,
      items: page.items.map((message) => ({
        ...message,
        name: message.authorName || "@Butler",
        memberId:
          message.kind === "human"
            ? message.authorRole.split(":")[1]
            : agent?.id,
        isOwn: message.authorRole?.startsWith("own:") || false,
      })),
    };
  }
  function presentMessages(rows) {
    const seen = new Set();
    return rows
      .filter((message) => {
        // Old versions copied PR updates to every repair job. Retain raw records,
        // and show each shared update once; job starts and repairs stay separate.
        const shared =
          message.prNumber &&
          ((message.kind === "review" && message.eventKey.includes(":")) ||
            /^(?:preview|merged|published|preview-error|publish-error|previous-error):/.test(
              message.eventKey || "",
            ));
        if (!shared) return true;
        const key = JSON.stringify([
          message.prNumber,
          message.eventKey,
          message.kind,
          message.text,
        ]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(({ eventKey, prNumber, position, sequence, ...message }) => message);
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
  function reactionSummary(project, user) {
    const summary = {};
    for (const row of all(
      `SELECT r.target_type,r.target_id,r.emoji,COUNT(*) AS count,
       MAX(r.user_id=?) AS reacted,json_group_array(m.name) AS names
       FROM reactions r JOIN members m ON m.id=r.member_id
       WHERE r.project_id=? GROUP BY r.target_type,r.target_id,r.emoji ORDER BY MIN(r.created_at),r.emoji`,
      user,
      project,
    )) {
      const key = row.target_type + ":" + row.target_id;
      (summary[key] ||= []).push({
        emoji: row.emoji,
        count: row.count,
        reacted: Boolean(row.reacted),
        names: JSON.parse(row.names).sort(),
      });
    }
    return summary;
  }
  function groupMessages(project, user) {
    return all(
      `SELECT g.id,g.member_id AS memberId,m.name,g.text,g.created_at AS createdAt,r.job_id AS jobId,
       (m.user_id=?) AS isOwn FROM group_messages g JOIN members m ON m.id=g.member_id LEFT JOIN group_requests r ON r.message_id=g.id
       WHERE g.project_id=? ORDER BY g.created_at,g.rowid`,
      user,
      project,
    ).map((message) => ({ ...message, isOwn: Boolean(message.isOwn) }));
  }
  function groupAgent(project) {
    return get(
      "SELECT m.* FROM members m JOIN group_agents g ON g.member_id=m.id WHERE g.project_id=?",
      project,
    );
  }
  function ensureGroupAgent(project) {
    const saved = groupAgent(project);
    if (saved) return saved;
    const member = id();
    run(
      "INSERT INTO members(id,project_id,user_id,name,prefix,role,created_at) VALUES(?,?,?,'Group Butler',?,'agent',?)",
      member,
      project,
      get("SELECT owner_id FROM projects WHERE id=?", project).owner_id,
      `team-${member.slice(0, 8)}`,
      now(),
    );
    run("INSERT INTO group_agents VALUES(?,?)", project, member);
    return groupAgent(project);
  }
  function humanMessage(project, memberId, jobId, actor, text) {
    const messageId = id();
    run(
      "INSERT INTO messages VALUES(?,?,?,?,?,?,?)",
      messageId,
      project,
      memberId,
      jobId,
      "user",
      text,
      now(),
    );
    if (
      actor.id !==
      get("SELECT user_id FROM members WHERE id=?", memberId).user_id
    )
      run(
        "INSERT INTO message_authors VALUES(?,?,?)",
        messageId,
        actor.id,
        get("SELECT role FROM members WHERE id=?", memberId).role === "agent"
          ? "teammate"
          : "lead",
      );
  }
  function resumeFollowups(jobId) {
    const job = get("SELECT * FROM jobs WHERE id=?", jobId);
    if (!job?.pending_text) return false;
    const nextText = isContinuation(job.pending_text)
      ? recoveryInstruction(job)
      : job.state === "failed"
        ? recoveryInstruction(job) + "\n\nFollow-up:\n" + job.pending_text
        : job.pending_text;
    run("DELETE FROM preview_inspections WHERE job_id=?", job.id);
    run(
      "UPDATE jobs SET text=?,pending_text=NULL,request_revision=request_revision+1,state='queued',error=NULL,result=NULL,started_at=NULL,finished_at=NULL,lease_until=NULL,inspected_at=NULL,artifact_ready_at=NULL,updated_at=? WHERE id=?",
      nextText,
      now(),
      job.id,
    );
    recordEvent(
      job.id,
      `update-preview:${job.request_revision + 1}`,
      "status",
      "I’m updating your existing preview with your follow-up.",
    );
    return true;
  }
  function recoveryInstruction(job) {
    if (!isContinuation(job.text)) return job.text;
    return (
      all(
        "SELECT text FROM messages WHERE job_id=? AND role='user' ORDER BY created_at DESC,rowid DESC LIMIT 30",
        job.id,
      ).find((message) => !isContinuation(message.text))?.text || job.text
    );
  }
  function requestChange(project, member, actor, text, requestKey) {
    return transaction(() => {
      const existing =
        get(
          "SELECT job_id AS id FROM request_receipts WHERE member_id=? AND request_key=?",
          member.id,
          requestKey,
        ) ||
        get(
          "SELECT id FROM jobs WHERE member_id=? AND request_key=?",
          member.id,
          requestKey,
        );
      if (existing) return existing.id;
      const job = get(
        "SELECT * FROM jobs WHERE project_id=? AND member_id=? AND approval_required=1 AND approved_at IS NULL AND pr_number IS NULL AND state IN ('queued','working','building_preview','preview_failed','awaiting_approval','failed') ORDER BY created_at DESC,rowid DESC LIMIT 1",
        project,
        member.id,
      );
      const jobId = job?.id || id();
      if (job) {
        run("DELETE FROM preview_inspections WHERE job_id=?", job.id);
        if (["working", "building_preview"].includes(job.state))
          run(
            "UPDATE jobs SET pending_text=?,inspected_at=NULL,updated_at=? WHERE id=?",
            [job.pending_text, text].filter(Boolean).join("\n\nFollow-up:\n"),
            now(),
            job.id,
          );
        else {
          const nextText = isContinuation(text)
            ? recoveryInstruction(job)
            : ["queued", "failed"].includes(job.state)
              ? recoveryInstruction(job) + "\n\nFollow-up:\n" + text
              : text;
          run(
            "UPDATE jobs SET text=?,state='queued',request_revision=request_revision+1,pending_text=NULL,result=NULL,error=NULL,started_at=NULL,finished_at=NULL,lease_until=NULL,inspected_at=NULL,artifact_ready_at=NULL,updated_at=? WHERE id=?",
            nextText,
            now(),
            job.id,
          );
        }
        recordEvent(
          job.id,
          `follow-up:${requestKey}`,
          "status",
          "I’ll update this preview with your follow-up.",
        );
      } else {
        run(
          "INSERT INTO jobs(id,project_id,member_id,request_key,text,created_at,updated_at,approval_required) VALUES(?,?,?,?,?,?,?,1)",
          jobId,
          project,
          member.id,
          requestKey,
          text,
          now(),
          now(),
        );
        run("UPDATE jobs SET requested_by=? WHERE id=?", actor.id, jobId);
      }
      run(
        "INSERT INTO request_receipts VALUES(?,?,?)",
        member.id,
        requestKey,
        jobId,
      );
      humanMessage(project, member.id, jobId, actor, text);
      return jobId;
    });
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
      recordPullEvent(
        project,
        number,
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
    recordPullEvent,
    chatMessages,
    chatPage,
    groupPage,
    reactionSummary,
    groupMessages,
    groupAgent,
    ensureGroupAgent,
    humanMessage,
    requestChange,
    resumeFollowups,
    recordRelease,
    close: () => db.close(),
  };
}
