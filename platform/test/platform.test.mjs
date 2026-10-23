import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createPlatform } from "../server.mjs";
import { createStore, id, token, now, digest } from "../store.mjs";

async function fixture(t) {
  const dir = await mkdtemp(`${tmpdir()}/butler-platform-`),
    store = createStore(dir);
  const config = {
    publicUrl: "http://127.0.0.1",
    secure: false,
    dataDir: dir,
    frontend: "/missing",
    githubClientId: "client",
    githubClientSecret: "secret",
    railwayClientId: "rail-client",
    railwayClientSecret: "rail-secret",
    emailKey: "mail-key",
    emailFrom: "team@example.test",
    commit: "test",
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
          scope: "read:user repo",
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
  store.connection(lead.id, "github", {
    access_token: "github-sensitive-fixture",
    scope: "repo",
  });
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
      other.get("SELECT secret FROM connections WHERE provider=?", "github")
        .secret,
    ).access_token,
    "github-sensitive-fixture",
  );
  other.close();
  const disk = await readFile(`${f.dir}/butler.sqlite`);
  assert.ok(!disk.includes(Buffer.from("github-sensitive-fixture")));
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
