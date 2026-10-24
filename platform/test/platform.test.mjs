import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createPlatform } from "../server.mjs";
import { createStore, id, token, now, digest } from "../store.mjs";

async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(`${tmpdir()}/butler-platform-`),
    store = createStore(dir);
  const config = {
    publicUrl: "http://127.0.0.1",
    secure: false,
    dataDir: dir,
    frontend: "/missing",
    githubClientId: "client",
    githubClientSecret: "secret",
    githubAppId: 123,
    githubAppSlug: "butler-test",
    githubAppPrivateKey: "fixture-key",
    githubAppWebhookSecret: "fixture-hook-secret",
    railwayClientId: "rail-client",
    railwayClientSecret: "rail-secret",
    defaultHostingProvider: "railway",
    emailKey: "mail-key",
    emailFrom: "team@example.test",
    commit: "test",
    ...overrides,
  };
  let sentEmail,
    profile = { id: 4242, login: "test-lead", name: "Test Lead" };
  const provider = {
    worker: async () => ({
      state: "pending",
      code: "ABCD-EFGH",
      url: "https://auth.openai.com/codex/device",
    }),
    railway: async () => ({ me: { workspaces: [{ id: id(), name: "Team" }] } }),
    request: async (url, options) => {
      if (url === "https://api.resend.com/emails") {
        sentEmail = JSON.parse(options.body);
        return Response.json({ id: "email" });
      }
      if (url.endsWith("/login/oauth/access_token"))
        return Response.json({
          access_token: "github-sensitive-fixture",
          scope: "read:user",
        });
      if (url === "https://api.github.com/user") return Response.json(profile);
      throw new Error("Unexpected provider request");
    },
  };
  const platform = createPlatform(config, { store, provider, provisioner: {} });
  await new Promise((resolve) =>
    platform.server.listen(0, "127.0.0.1", resolve),
  );
  config.publicUrl = `http://127.0.0.1:${platform.server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => platform.server.close(resolve));
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const lead = store.guest("Test Lead");
  store.run(
    "UPDATE users SET github_id=?,github_login=? WHERE id=?",
    "4242",
    "test-lead",
    lead.id,
  );
  store.connection(lead.id, "github_installation", { id: 99, accountId: 4242 });
  store.connection(lead.id, "railway", {
    access_token: "rail-sensitive-fixture",
    expiresAt: now() + 3600000,
  });
  const owner = `butler_account=${store.session(lead.id)}`;
  async function call(url, body, cookie = owner, headers = {}) {
    return fetch(config.publicUrl + url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin: config.publicUrl,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
  }
  async function create(name = "Our project") {
    const requestKey = id(),
      r = await call("/api/projects", {
        name,
        description: "A website for our friends",
        requestKey,
      });
    assert.equal(r.status, 201);
    return { ...(await r.json()), requestKey };
  }
  async function invite(projectId) {
    return (await call(`/api/projects/${projectId}/invite`)).json();
  }
  async function join(link, name) {
    const secret = new URL(link).hash.slice(8);
    const r = await call("/api/invites/join", { token: secret, name }, "");
    assert.equal(r.status, 201);
    return r.headers.get("set-cookie").split(";")[0];
  }
  return {
    store,
    config,
    dir,
    lead,
    owner,
    call,
    create,
    invite,
    join,
    provider,
    email: () => sentEmail,
    setProfile: (value) => {
      profile = value;
    },
  };
}

test("QR joining gives separate persistent workspaces with no provider accounts and no cross-member access", async (t) => {
  const f = await fixture(t),
    p = await f.create(),
    inv = await f.invite(p.id);
  assert.ok(inv.qr.startsWith("data:image/png;base64,"));
  const alice = await f.join(inv.url, "Alice"),
    bob = await f.join(inv.url, "Bob");
  assert.notEqual(alice, bob);
  const a = await (
      await f.call(`/api/projects/${p.id}`, undefined, alice)
    ).json(),
    b = await (await f.call(`/api/projects/${p.id}`, undefined, bob)).json();
  assert.notEqual(a.member.id, b.member.id);
  assert.notEqual(a.member.prefix, b.member.prefix);
  assert.equal(
    (await (await f.call("/api/projects")).json()).projects[0].isOwner,
    true,
  );
  assert.equal(
    (await (await f.call("/api/projects", undefined, alice)).json()).projects[0]
      .isOwner,
    false,
  );
  assert.equal(
    (
      await f.call(
        `/api/projects/${p.id}?member=${a.member.id}`,
        undefined,
        bob,
      )
    ).status,
    404,
  );
  assert.equal(
    (await f.call(`/api/projects/${p.id}/invite`, undefined, bob)).status,
    403,
  );
  assert.equal(
    (await f.call(`/api/projects/${p.id}/codex`, {}, bob)).status,
    403,
  );
  assert.equal(
    (await f.call(`/api/projects/${p.id}`, undefined, "")).status,
    401,
  );
  assert.equal(
    (await f.call(`/api/projects/${p.id}`, undefined, alice + "tampered"))
      .status,
    401,
  );
  assert.equal((await f.call("/api/session", undefined, bob)).status, 200);
  assert.equal(f.store.all("SELECT * FROM connections").length, 2);
  const serialized = JSON.stringify({ a, b, inv });
  for (const secret of [
    "github-sensitive-fixture",
    "rail-sensitive-fixture",
    "worker_secret",
    "webhook_secret",
  ])
    assert.ok(!serialized.includes(secret));
});

test("accepted messages and project creation are idempotent, origin protected and recoverable after storage reopen", async (t) => {
  const f = await fixture(t),
    p = await f.create();
  const duplicate = await f.call("/api/projects", {
    name: "Our project",
    description: "A website for our friends",
    requestKey: p.requestKey,
  });
  assert.equal((await duplicate.json()).id, p.id);
  assert.equal(f.store.get("SELECT COUNT(*) AS n FROM projects").n, 1);
  const inv = await f.invite(p.id),
    alice = await f.join(inv.url, "Alice"),
    requestKey = id();
  for (let n = 0; n < 2; n++)
    assert.equal(
      (
        await f.call(
          `/api/projects/${p.id}/messages`,
          { text: "Make the heading Hello Team", requestKey },
          alice,
        )
      ).status,
      202,
    );
  assert.equal(
    f.store.get(
      "SELECT COUNT(*) AS n FROM jobs WHERE request_key=?",
      requestKey,
    ).n,
    1,
  );
  assert.equal(
    (
      await f.call(
        `/api/projects/${p.id}/messages`,
        { text: "no", requestKey: id() },
        alice,
        { origin: "https://evil.test" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call(
        `/api/projects/${p.id}/messages`,
        { text: "a".repeat(20001), requestKey: id() },
        alice,
      )
    ).status,
    400,
  );
  const recovery = await (await f.call("/api/auth/recovery", {}, alice)).json();
  const again = await (await f.call("/api/auth/recovery", {}, alice)).json();
  assert.equal(recovery.url, again.url);
  const signed = await f.call(
    "/api/auth/recover",
    { token: new URL(recovery.url).hash.slice(7) },
    "",
  );
  assert.equal(signed.status, 200);
  const freshCookie = signed.headers.get("set-cookie").split(";")[0],
    fresh = await (
      await f.call(`/api/projects/${p.id}`, undefined, freshCookie)
    ).json();
  assert.equal(fresh.messages.length, 1);
  assert.equal(fresh.jobs[0].text, "Make the heading Hello Team");
  const other = createStore(f.dir);
  assert.equal(
    other.all("SELECT * FROM jobs WHERE request_key=?", requestKey).length,
    1,
  );
  assert.equal(
    other.open(
      other.get("SELECT secret FROM connections WHERE provider=?", "railway")
        .secret,
    ).access_token,
    "rail-sensitive-fixture",
  );
  other.close();
  const disk = await readFile(`${f.dir}/butler.sqlite`);
  assert.ok(!disk.includes(Buffer.from("rail-sensitive-fixture")));
});

test("Codex connection and worker requests require the right project and role; abandoned jobs are leased again", async (t) => {
  const f = await fixture(t),
    p = await f.create(),
    p2 = await f.create("Other project");
  f.store.run(
    "UPDATE projects SET state='ready',worker_url='https://worker.example.test' WHERE id=?",
    p.id,
  );
  const auth = await (await f.call(`/api/projects/${p.id}/codex`, {})).json();
  assert.equal(auth.state, "pending");
  assert.equal(auth.code, "ABCD-EFGH");
  const row = f.store.get("SELECT * FROM projects WHERE id=?", p.id),
    secret = f.store.open(row.worker_secret);
  const workerHeaders = {
    authorization: `Bearer ${secret}`,
    "x-butler-project": p.id,
  };
  assert.equal(
    (
      await f.call("/api/worker/claim", {}, "", {
        ...workerHeaders,
        "x-butler-project": p2.id,
      })
    ).status,
    401,
  );
  const first = await (
    await f.call("/api/worker/claim", {}, "", workerHeaders)
  ).json();
  assert.ok(first.job);
  assert.equal(
    (await (await f.call("/api/worker/claim", {}, "", workerHeaders)).json())
      .job,
    null,
  );
  f.store.run(
    "UPDATE jobs SET lease_until=? WHERE id=?",
    now() - 1,
    first.job.id,
  );
  assert.equal(
    (await (await f.call("/api/worker/claim", {}, "", workerHeaders)).json())
      .job.id,
    first.job.id,
  );
  assert.equal(
    (
      await f.call(
        `/api/worker/jobs/${first.job.id}/result`,
        { state: "unchanged", text: "Done" },
        "",
        { ...workerHeaders, "x-butler-project": p2.id },
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await f.call(
        `/api/worker/jobs/${first.job.id}/result`,
        { state: "unchanged", text: "Done" },
        "",
        workerHeaders,
      )
    ).status,
    200,
  );
  assert.equal(
    f.store.get("SELECT state FROM jobs WHERE id=?", first.job.id).state,
    "unchanged",
  );
});

test("GitHub OAuth requires browser state and never exposes its access token", async (t) => {
  const f = await fixture(t);
  const begin = await f.call(
    "/auth/github?returnTo=%2Fp%2F" + id(),
    undefined,
    "",
  );
  assert.equal(begin.status, 302);
  const state = new URL(begin.headers.get("location")).searchParams.get(
      "state",
    ),
    browser = begin.headers.get("set-cookie").split(";")[0];
  assert.equal(
    (
      await f.call(
        `/auth/github/callback?code=code&state=${state}`,
        undefined,
        "",
      )
    ).status,
    400,
  );
  const callback = await f.call(
    `/auth/github/callback?code=code&state=${state}`,
    undefined,
    browser,
  );
  assert.equal(callback.status, 302);
  assert.ok(
    !JSON.stringify([...callback.headers]).includes("github-sensitive-fixture"),
  );
  assert.equal(
    (
      await f.call(
        `/auth/github/callback?code=code&state=${state}`,
        undefined,
        browser,
      )
    ).status,
    400,
  );
});

test("switching GitHub accounts does not transfer an existing lead project", async (t) => {
  const f = await fixture(t),
    p = await f.create();
  f.setProfile({ id: 9999, login: "other-person", name: "Other Person" });
  const begin = await f.call("/auth/github"),
    state = new URL(begin.headers.get("location")).searchParams.get("state");
  const browser = begin.headers.get("set-cookie").split(";")[0];
  const callback = await f.call(
    `/auth/github/callback?code=code&state=${state}`,
    undefined,
    f.owner + "; " + browser,
  );
  assert.equal(callback.status, 302);
  assert.equal(
    f.store.get("SELECT owner_id FROM projects WHERE id=?", p.id).owner_id,
    f.lead.id,
  );
  assert.equal(
    f.store.get("SELECT github_id FROM users WHERE id=?", f.lead.id).github_id,
    "4242",
  );
});

test("email completion cannot attach a victim email to an attacker-controlled session", async (t) => {
  const f = await fixture(t),
    attacker = f.store.guest("Someone"),
    attackerCookie = `butler_account=${f.store.session(attacker.id)}`;
  assert.equal(
    (
      await f.call(
        "/api/auth/email",
        { email: "victim@example.test" },
        attackerCookie,
      )
    ).status,
    200,
  );
  const sent = f.email(),
    link = sent.text.match(/https?:\/\/\S+/)[0],
    secret = new URL(link).hash.slice(7);
  const complete = await f.call(
    "/api/auth/email/complete",
    { token: secret },
    "",
  );
  assert.equal(complete.status, 200);
  assert.equal(
    f.store.get("SELECT email FROM users WHERE id=?", attacker.id).email,
    null,
  );
  assert.notEqual(
    f.store.get("SELECT id FROM users WHERE email=?", "victim@example.test").id,
    attacker.id,
  );
  assert.equal(
    (await f.call("/api/auth/email/complete", { token: secret }, "")).status,
    400,
  );
});

test("invite replacement prevents new claims through old links while existing members retain access", async (t) => {
  const f = await fixture(t),
    p = await f.create(),
    inv = await f.invite(p.id),
    member = await f.join(inv.url, "Alice");
  await f.call(`/api/projects/${p.id}/invite/rotate`, {});
  assert.equal(
    (
      await f.call(
        "/api/invites/join",
        { token: new URL(inv.url).hash.slice(8), name: "Bob" },
        "",
      )
    ).status,
    403,
  );
  assert.equal(
    (await f.call(`/api/projects/${p.id}`, undefined, member)).status,
    200,
  );
});

test("private installation setup saves encrypted provider credentials, applies them immediately, and can be revoked", async (t) => {
  const bootstrap = token(),
    f = await fixture(t, {
      setupToken: bootstrap,
      githubClientId: undefined,
      githubClientSecret: undefined,
      railwayClientId: undefined,
      railwayClientSecret: undefined,
    });
  assert.equal(
    (await f.call("/api/setup/status", { token: "wrong" }, "")).status,
    403,
  );
  const first = await (
    await f.call("/api/setup/status", { token: bootstrap }, "")
  ).json();
  assert.equal(first.github, false);
  const saved = await f.call(
    "/api/setup/save",
    {
      token: bootstrap,
      provider: "github",
      clientId: "github-fixture-client",
      clientSecret: "github-fixture-private-secret",
    },
    "",
  );
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).github, true);
  const begin = await f.call("/auth/github", undefined, "");
  assert.equal(
    new URL(begin.headers.get("location")).searchParams.get("client_id"),
    "github-fixture-client",
  );
  const status = JSON.stringify(
    await (await f.call("/api/setup/status", { token: bootstrap }, "")).json(),
  );
  assert.ok(!status.includes("github-fixture-private-secret"));
  const reboot = {
    ...f.config,
    githubClientId: undefined,
    githubClientSecret: undefined,
  };
  createPlatform(reboot, {
    store: f.store,
    provider: f.provider,
    provisioner: {},
  });
  assert.equal(reboot.githubClientId, "github-fixture-client");
  await f.call("/api/setup/finish", { token: bootstrap }, "");
  assert.equal(
    (await f.call("/api/setup/status", { token: bootstrap }, "")).status,
    403,
  );
  createPlatform(
    { ...f.config },
    { store: f.store, provider: f.provider, provisioner: {} },
  );
  assert.equal(f.store.setting("setup-enabled"), false);
});

test("linking a verified email account to GitHub preserves future email sign-in and its existing workspaces", async (t) => {
  const f = await fixture(t),
    p = await f.create(),
    inv = await f.invite(p.id),
    guestCookie = await f.join(inv.url, "Maya");
  const guest = await (
    await f.call("/api/session", undefined, guestCookie)
  ).json();
  f.store.run(
    "UPDATE users SET email=? WHERE id=?",
    "maya@example.test",
    guest.user.id,
  );
  f.store.mergeUsers(guest.user.id, f.lead.id);
  assert.equal(
    f.store.get("SELECT email FROM users WHERE id=?", f.lead.id).email,
    "maya@example.test",
  );
  await f.call("/api/auth/email", { email: "maya@example.test" }, "");
  const link = f.email().text.match(/https?:\/\/\S+/)[0],
    secret = new URL(link).hash.slice(7);
  const signed = await f.call(
    "/api/auth/email/complete",
    { token: secret },
    "",
  );
  const cookie = signed.headers.get("set-cookie").split(";")[0];
  const account = await (
    await f.call("/api/session", undefined, cookie)
  ).json();
  assert.equal(account.user.id, f.lead.id);
  const projects = await (
    await f.call("/api/projects", undefined, cookie)
  ).json();
  assert.ok(projects.projects.some((project) => project.id === p.id));
  const other = f.store.guest("Other");
  f.store.run(
    "UPDATE users SET email=? WHERE id=?",
    "other@example.test",
    other.id,
  );
  f.store.mergeUsers(other.id, f.lead.id);
  assert.equal(
    f.store.get(
      "SELECT user_id FROM email_aliases WHERE email=?",
      "other@example.test",
    ).user_id,
    f.lead.id,
  );
});

test("merge reconciliation is idempotent even when publication finished before the response was recorded", async (t) => {
  const f = await fixture(t),
    p = await f.create(),
    job = f.store.get("SELECT * FROM jobs WHERE project_id=?", p.id),
    sha = "a".repeat(40),
    later = "b".repeat(40);
  f.store.run(
    "UPDATE jobs SET state='reviewing',pr_number=7 WHERE id=?",
    job.id,
  );
  f.store.run(
    "UPDATE projects SET resources=? WHERE id=?",
    JSON.stringify({ deployedSha: sha }),
    p.id,
  );
  f.store.recordMerge(p.id, 7, sha);
  assert.equal(
    f.store.get("SELECT state FROM jobs WHERE id=?", job.id).state,
    "live",
  );
  f.store.run(
    "UPDATE jobs SET state='reviewing',merge_sha=NULL WHERE id=?",
    job.id,
  );
  f.store.run(
    "UPDATE projects SET resources=? WHERE id=?",
    JSON.stringify({ deployedSha: later }),
    p.id,
  );
  f.store.enqueue(p.id, "deploy", `main:${p.id}:${sha}`, { sha });
  f.store.run(
    "UPDATE tasks SET state='done' WHERE dedupe_key=?",
    `main:${p.id}:${sha}`,
  );
  f.store.recordMerge(p.id, 7, sha);
  assert.equal(
    f.store.get(
      "SELECT state FROM tasks WHERE dedupe_key=?",
      `main:${p.id}:${sha}`,
    ).state,
    "queued",
  );
  f.store.recordMerge(p.id, 7, sha);
  assert.equal(
    f.store.get(
      "SELECT COUNT(*) AS n FROM tasks WHERE dedupe_key=?",
      `main:${p.id}:${sha}`,
    ).n,
    1,
  );
});

test("GitHub linking revokes pre-link guest sessions and recovery links for existing and new accounts", async (t) => {
  const f = await fixture(t),
    p = await f.create(),
    invite = await f.invite(p.id);
  for (const existing of [true, false]) {
    const guestCookie = await f.join(invite.url, "Guest");
    const recovery = await (
      await f.call("/api/auth/recovery", {}, guestCookie)
    ).json();
    const before = await (
      await f.call("/api/session", undefined, guestCookie)
    ).json();
    if (!existing)
      f.setProfile({ id: 9191, login: "new-account", name: "New" });
    const begin = await f.call("/auth/github", undefined, guestCookie);
    const state = new URL(begin.headers.get("location")).searchParams.get(
      "state",
    );
    const browser = begin.headers.get("set-cookie").split(";")[0];
    const callback = await f.call(
      `/auth/github/callback?code=code&state=${state}`,
      undefined,
      guestCookie + "; " + browser,
    );
    const signedCookie = callback.headers
      .get("set-cookie")
      .match(/butler_account=[^;]+/)[0];
    const signed = await (
      await f.call("/api/session", undefined, signedCookie)
    ).json();
    assert.equal(
      signed.user.githubLogin,
      existing ? "test-lead" : "new-account",
    );
    assert.equal(
      (await (await f.call("/api/session", undefined, guestCookie)).json())
        .user,
      null,
    );
    assert.equal(
      (
        await f.call(
          "/api/auth/recover",
          { token: new URL(recovery.url).hash.slice(7) },
          "",
        )
      ).status,
      403,
    );
    assert.equal(
      f.store.get(
        "SELECT user_id FROM members WHERE project_id=? AND name='Guest' AND user_id=?",
        p.id,
        signed.user.id,
      )?.user_id,
      signed.user.id,
    );
    assert.equal(
      f.store.get("SELECT recovery_hash FROM users WHERE id=?", before.user.id)
        .recovery_hash,
      null,
    );
  }
});

test("reopening a PR at the same head reactivates completed preview work and repeat closes reactivate cleanup", async (t) => {
  const { createHmac } = await import("node:crypto");
  const f = await fixture(t),
    p = await f.create();
  f.store.run("UPDATE projects SET repo=? WHERE id=?", "team/site", p.id);
  const project = f.store.get("SELECT * FROM projects WHERE id=?", p.id),
    sha = "a".repeat(40);
  async function hook(action) {
    const body = JSON.stringify({
      action,
      number: 12,
      repository: { full_name: "team/site" },
      pull_request: { merged: false, base: { ref: "main" }, head: { sha } },
    });
    return fetch(`${f.config.publicUrl}/api/hooks/github/${p.id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256":
          "sha256=" +
          createHmac("sha256", f.store.open(project.webhook_secret))
            .update(body)
            .digest("hex"),
      },
      body,
    });
  }
  assert.equal((await hook("opened")).status, 202);
  f.store.run("UPDATE tasks SET state='done',attempts=3 WHERE kind='deploy'");
  await hook("closed");
  f.store.run("UPDATE tasks SET state='done' WHERE kind='cleanup'");
  await hook("reopened");
  assert.equal(
    f.store.get("SELECT state FROM tasks WHERE kind='deploy'").state,
    "queued",
  );
  assert.equal(
    f.store.get("SELECT attempts FROM tasks WHERE kind='deploy'").attempts,
    0,
  );
  await hook("reopened");
  assert.equal(
    f.store.get("SELECT count(*) AS n FROM tasks WHERE kind='deploy'").n,
    1,
  );
  await hook("closed");
  assert.equal(
    f.store.get("SELECT state FROM tasks WHERE kind='cleanup'").state,
    "queued",
  );
  await hook("reopened");
  assert.equal(
    f.store.get("SELECT count(*) AS n FROM tasks WHERE kind='cleanup'").n,
    0,
  );
});

test("teammates sharing an IP have independent read budgets and polling cannot consume write capacity", async (t) => {
  const f = await fixture(t);
  const cookies = Array.from(
    { length: 20 },
    () => `butler_account=${f.store.session(f.store.guest().id)}`,
  );
  for (let i = 0; i < 25; i++) {
    const responses = await Promise.all(
      cookies.map((cookie) => f.call("/api/session", undefined, cookie)),
    );
    assert.ok(responses.every((response) => response.status === 200));
  }
  for (let i = 25; i < 240; i++)
    assert.equal(
      (await f.call("/api/session", undefined, cookies[0])).status,
      200,
    );
  assert.equal(
    (await f.call("/api/session", undefined, cookies[0])).status,
    429,
  );
  assert.equal(
    (await f.call("/api/session", undefined, cookies[1])).status,
    200,
  );
  assert.equal((await f.call("/api/projects", {}, cookies[0])).status, 409);
});

test("email linking also invalidates guest credentials instead of promoting them", async (t) => {
  const f = await fixture(t),
    p = await f.create(),
    inv = await f.invite(p.id);
  f.store.run(
    "UPDATE users SET email=? WHERE id=?",
    "lead@example.test",
    f.lead.id,
  );
  const guest = await f.join(inv.url, "Guest"),
    recovery = await (await f.call("/api/auth/recovery", {}, guest)).json();
  await f.call("/api/auth/email", { email: "lead@example.test" }, guest);
  const secret = new URL(f.email().text.match(/https?:\/\/\S+/)[0]).hash.slice(
    7,
  );
  const response = await f.call(
    "/api/auth/email/complete",
    { token: secret },
    guest,
  );
  assert.equal(response.status, 200);
  const signed = response.headers.get("set-cookie").split(";")[0];
  assert.equal(
    (await (await f.call("/api/session", undefined, signed)).json()).user.id,
    f.lead.id,
  );
  assert.equal(
    (await (await f.call("/api/session", undefined, guest)).json()).user,
    null,
  );
  assert.equal(
    (
      await f.call(
        "/api/auth/recover",
        { token: new URL(recovery.url).hash.slice(7) },
        "",
      )
    ).status,
    403,
  );
});
