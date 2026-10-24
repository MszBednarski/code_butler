import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createPlatform } from "../server.mjs";
import { createStore, id, token, now, digest } from "../store.mjs";
import { createProvisioner } from "../provision.mjs";

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

function workerCall(f, project, path, body) {
  return fetch(f.config.publicUrl + "/api/worker" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${f.store.open(project.worker_secret)}`,
      "x-butler-project": project.id,
      "x-butler-protocol": "2",
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
test("sharing the website returns its canonical public URL and QR, without granting team access", async (t) => {
  const f = await fixture(t),
    p = await f.create(),
    other = await f.create("Other project"),
    inv = await f.invite(p.id),
    alice = await f.join(inv.url, "Alice");
  assert.equal(
    (await f.call(`/api/projects/${p.id}/share`, undefined, alice)).status,
    409,
  );
  f.store.run(
    "UPDATE projects SET app_url='https://current.example.test' WHERE id=?",
    p.id,
  );
  const share = await (
    await f.call(
      `/api/projects/${p.id}/share?url=https://preview.example.test`,
      undefined,
      alice,
    )
  ).json();
  assert.equal(share.url, "https://current.example.test");
  assert.match(share.qr, /^data:image\/png;base64,/);
  assert.deepEqual(Object.keys(share).sort(), ["qr", "url"]);
  assert.ok(!JSON.stringify(share).includes(inv.url));
  assert.equal(
    (await f.call(`/api/projects/${other.id}/share`, undefined, alice)).status,
    404,
  );
  assert.equal(
    (await f.call(`/api/projects/${p.id}/share`, undefined, "")).status,
    401,
  );
});
test("automatic project names are scoped, persistent and never replace an explicit name", async (t) => {
  const f = await fixture(t);
  const created = await (
    await f.call("/api/projects", {
      name: "Your new project",
      description: "A phone-friendly tap racing game",
      generateName: true,
      requestKey: id(),
    })
  ).json();
  let project = f.store.get("SELECT * FROM projects WHERE id=?", created.id);
  assert.equal(project.name_source, "pending");
  const originalSlug = project.slug;
  const cfg = await (await workerCall(f, project, "/config")).json();
  assert.equal(cfg.description, "A phone-friendly tap racing game");
  assert.equal(cfg.nameSource, "pending");
  assert.equal(
    (
      await workerCall(f, project, "/name", {
        name: "https://wrong.example.test",
      })
    ).status,
    400,
  );
  assert.equal(
    (await workerCall(f, project, "/name", { name: "TapSprint" })).status,
    200,
  );
  project = f.store.get("SELECT * FROM projects WHERE id=?", created.id);
  assert.equal(project.name, "TapSprint");
  assert.equal(project.name_source, "generated");
  assert.equal(project.slug, originalSlug);
  await workerCall(f, project, "/name", { name: "Accidental rename" });
  assert.equal(
    f.store.get("SELECT name FROM projects WHERE id=?", created.id).name,
    "TapSprint",
  );
  const explicit = await f.create("Sunday Table"),
    manual = f.store.get("SELECT * FROM projects WHERE id=?", explicit.id);
  await workerCall(f, manual, "/name", { name: "Different name" });
  assert.equal(
    f.store.get("SELECT name FROM projects WHERE id=?", explicit.id).name,
    "Sunday Table",
  );
  const page = await (await f.call(`/api/projects/${created.id}`)).json();
  assert.equal(page.name, "TapSprint");
  const reopened = createStore(f.dir);
  assert.equal(
    reopened.get("SELECT name,name_source FROM projects WHERE id=?", created.id)
      .name,
    "TapSprint",
  );
  reopened.close();
});
test("an explicit domain alias keeps old sessions working without accepting arbitrary origins or callback hosts", async (t) => {
  const f = await fixture(t, { publicAliases: ["https://old.butler.example"] }),
    p = await f.create();
  assert.equal(
    (
      await f.call(
        `/api/projects/${p.id}/messages`,
        { text: "A change from the existing address", requestKey: id() },
        f.owner,
        { origin: "https://old.butler.example" },
      )
    ).status,
    202,
  );
  assert.equal(
    (
      await f.call(
        `/api/projects/${p.id}/messages`,
        { text: "Cross-site request", requestKey: id() },
        f.owner,
        { origin: "https://attacker.example" },
      )
    ).status,
    403,
  );
  const { request } = await import("node:http");
  const hostCall = (path, cookie, host) =>
    new Promise((resolve, reject) => {
      const server = new URL(f.config.publicUrl);
      const req = request(
        {
          hostname: server.hostname,
          port: server.port,
          path,
          headers: { host, cookie },
        },
        (res) => {
          const headers = new Headers(
            Object.entries(res.headers).map(([key, value]) => [
              key,
              Array.isArray(value) ? value.join(", ") : String(value),
            ]),
          );
          res.resume();
          res.on("end", () =>
            resolve(new Response(null, { status: res.statusCode, headers })),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
  const login = await hostCall(
      "/auth/github?returnTo=/start",
      f.owner,
      "old.butler.example",
    ),
    url = new URL(login.headers.get("location"));
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "https://old.butler.example/auth/github/callback",
  );
  const original = f.provider.request;
  let exchanged = false;
  f.provider.request = async (url, options) => {
    if (url.endsWith("/login/oauth/access_token")) {
      assert.equal(
        new URLSearchParams(options.body).get("redirect_uri"),
        "https://old.butler.example/auth/github/callback",
      );
      exchanged = true;
    }
    return original(url, options);
  };
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const callback = await hostCall(
    `/auth/github/callback?code=fixture&state=${url.searchParams.get("state")}`,
    f.owner + "; " + cookie,
    "old.butler.example",
  );
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), "/start");
  assert.equal(exchanged, true);
  const unknown = await hostCall(
    "/auth/github?returnTo=/start",
    f.owner,
    "attacker.example",
  );
  assert.equal(
    unknown.headers.get("location"),
    f.config.publicUrl + "/auth/github?returnTo=/start",
  );
  const install = await hostCall(
    "/auth/github/install?returnTo=/start",
    f.owner,
    "old.butler.example",
  );
  assert.equal(
    install.headers.get("location"),
    f.config.publicUrl + "/auth/github/install?returnTo=/start",
  );
});
test("team chat reads expose live durable progress while writes and worker events remain scoped", async (t) => {
  const f = await fixture(t),
    p = await f.create(),
    inv = await f.invite(p.id),
    alice = await f.join(inv.url, "Alice"),
    bob = await f.join(inv.url, "Bob");
  f.store.run("UPDATE projects SET state='ready' WHERE id=?", p.id);
  f.store.run("UPDATE jobs SET state='unchanged' WHERE project_id=?", p.id);
  const project = f.store.get("SELECT * FROM projects WHERE id=?", p.id);
  const sent = await (
    await f.call(
      `/api/projects/${p.id}/messages`,
      { text: "Make the tiles larger", requestKey: id() },
      alice,
    )
  ).json();
  const claimed = await (await workerCall(f, project, "/claim", {})).json();
  assert.equal(claimed.job.id, sent.jobId);
  const member = claimed.job.member.id;
  const event = {
    key: "attempt:item_1",
    kind: "agent",
    text: "I’m updating the tile layout.",
    at: Date.now(),
  };
  for (let n = 0; n < 2; n++)
    assert.equal(
      (
        await workerCall(f, project, `/jobs/${sent.jobId}/events`, {
          events: [event],
        })
      ).status,
      200,
    );
  const watched = await (
    await f.call(`/api/projects/${p.id}?chat=${member}`, undefined, bob)
  ).json();
  assert.equal(watched.readOnly, true);
  assert.equal(watched.chatMember.name, "Alice");
  assert.equal(watched.member.name, "Bob");
  assert.equal(watched.messages.filter((m) => m.text === event.text).length, 1);
  assert.ok(watched.jobs[0].startedAt);
  assert.equal(watched.jobs[0].state, "working");
  assert.equal(
    (
      await f.call(
        `/api/projects/${p.id}/messages?chat=${member}`,
        { text: "Hijack", requestKey: id() },
        bob,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call(
        `/api/projects/${p.id}/messages?member=${member}`,
        { text: "Hijack", requestKey: id() },
        bob,
      )
    ).status,
    404,
  );
  assert.equal(
    (await f.call(`/api/projects/${p.id}?chat=${id()}`, undefined, bob)).status,
    404,
  );
  assert.equal(
    (
      await workerCall(f, project, `/jobs/${sent.jobId}/events`, {
        events: [{ ...event, key: "private", kind: "reasoning" }],
      })
    ).status,
    400,
  );
  const other = await f.create("Other team"),
    otherProject = f.store.get("SELECT * FROM projects WHERE id=?", other.id);
  assert.equal(
    (
      await workerCall(f, otherProject, `/jobs/${sent.jobId}/events`, {
        events: [event],
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await workerCall(f, project, `/jobs/${sent.jobId}/result`, {
        state: "unchanged",
        text: "The tile layout is updated.",
      })
    ).status,
    200,
  );
  const final = await (
    await f.call(`/api/projects/${p.id}?chat=${member}`, undefined, bob)
  ).json();
  assert.ok(final.messages.some((m) => m.text === event.text));
  assert.ok(
    final.messages.some((m) => m.text === "The tile layout is updated."),
  );
  assert.ok(final.jobs[0].finishedAt >= final.jobs[0].startedAt);
  const reopened = createStore(f.dir);
  assert.equal(
    reopened.get(
      "SELECT COUNT(*) AS n FROM job_events WHERE job_id=? AND event_key=?",
      sent.jobId,
      event.key,
    ).n,
    1,
  );
  reopened.close();
});
test("a ready artifact requires its creator to inspect and approve the exact revision before a PR can exist", async (t) => {
  const f = await fixture(t),
    p = await f.create(),
    inv = await f.invite(p.id),
    alice = await f.join(inv.url, "Alice"),
    bob = await f.join(inv.url, "Bob");
  f.store.run(
    "UPDATE projects SET state='ready',repo='lead/site' WHERE id=?",
    p.id,
  );
  f.store.run("UPDATE jobs SET state='unchanged' WHERE project_id=?", p.id);
  const project = f.store.get("SELECT * FROM projects WHERE id=?", p.id);
  const sent = await (
    await f.call(
      `/api/projects/${p.id}/messages`,
      {
        text: "uh make that home heading say hello team or whatever",
        requestKey: id(),
      },
      alice,
    )
  ).json();
  const old = await f.call("/api/worker/claim", {}, "", {
    authorization: `Bearer ${f.store.open(project.worker_secret)}`,
    "x-butler-project": p.id,
  });
  assert.equal(
    (await old.json()).job,
    null,
    "An older worker must not create PRs for gated requests",
  );
  const claimed = (await (await workerCall(f, project, "/claim", {})).json())
    .job;
  assert.equal(claimed.id, sent.jobId);
  const sha = "a".repeat(40),
    base = `/api/projects/${p.id}/jobs/${sent.jobId}`,
    branch = claimed.member.prefix + "/draft-test";
  let creations = 0,
    latestSha = sha;
  const pulls = [];
  f.provider.github = async (_owner, path, method = "GET", body) => {
    if (path.includes("/git/ref/heads/")) return { object: { sha: latestSha } };
    if (path.includes("/pulls?")) return pulls;
    if (path.endsWith("/pulls") && method === "POST") {
      creations++;
      const pr = {
        number: 7,
        state: "open",
        title: body.title,
        body: body.body,
        head: { sha, ref: body.head },
      };
      pulls.push(pr);
      return pr;
    }
    throw new Error("Unexpected GitHub request " + path);
  };
  assert.equal(
    (
      await workerCall(f, project, "/github", {
        operation: "createPull",
        jobId: sent.jobId,
        branch,
        title: "Bad premature PR",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await workerCall(f, project, `/jobs/${sent.jobId}/result`, {
        state: "reviewing",
        text: "Premature",
        branch,
        prNumber: 7,
      })
    ).status,
    409,
  );
  const result = {
    state: "building_preview",
    text: "The heading is updated.",
    sha,
    branch,
    title: "Update the homepage heading to Hello Team",
    description:
      "Show Hello Team as the heading. Checks: production build passed.",
  };
  assert.equal(
    (
      await workerCall(f, project, `/jobs/${sent.jobId}/result`, {
        ...result,
        branch: "someone-else/draft",
      })
    ).status,
    400,
  );
  assert.equal(
    (await workerCall(f, project, `/jobs/${sent.jobId}/result`, result)).status,
    200,
  );
  const provisioner = createProvisioner(f.config, f.store, f.provider);
  await provisioner.openPull(project, { jobId: sent.jobId, sha });
  assert.equal(creations, 0);
  assert.equal((await f.call(base + "/approve", { sha }, alice)).status, 409);
  assert.equal(
    (await f.call(base + "/inspect", { sha }, alice)).status,
    409,
    "A building artifact is not ready to inspect",
  );
  f.store.run(
    "INSERT INTO previews(project_id,pr_number,state,commit_sha,url,environment_id) VALUES(?,-1,'ready',?,'https://preview.example.test','boat:4000')",
    p.id,
    sha,
  );
  f.store.run(
    "UPDATE jobs SET state='awaiting_approval',artifact_url='https://preview.example.test',artifact_number=-1,artifact_ready_at=? WHERE id=?",
    now(),
    sent.jobId,
  );
  assert.equal((await f.call(base + "/inspect", { sha }, bob)).status, 404);
  assert.equal(
    (await f.call(base + "/approve", { sha }, f.owner)).status,
    404,
    "The team lead cannot approve another member’s work",
  );
  assert.equal(
    (await f.call(base + "/inspect", { sha: "b".repeat(40) }, alice)).status,
    409,
  );
  assert.equal(
    (
      await f.call(
        `/api/projects/${p.id}/messages`,
        { text: "make the change", requestKey: id() },
        alice,
      )
    ).status,
    409,
  );
  assert.equal((await f.call(base + "/inspect", { sha }, alice)).status, 200);
  assert.equal(creations, 0, "Inspection alone does not open a PR");
  assert.equal(
    (await f.call(base + "/approve", { sha: "b".repeat(40) }, alice)).status,
    409,
  );
  assert.equal(
    (
      await f.call(
        `/api/projects/${p.id}/messages`,
        { text: "make the website have that", requestKey: id() },
        alice,
      )
    ).status,
    202,
  );
  assert.equal(
    (await f.call(base + "/approve", { sha }, alice)).status,
    200,
    "Double approval is idempotent",
  );
  assert.equal(
    f.store.get(
      "SELECT COUNT(*) AS n FROM tasks WHERE project_id=? AND kind='open-pr'",
      p.id,
    ).n,
    1,
  );
  latestSha = "b".repeat(40);
  await assert.rejects(
    provisioner.openPull(project, { jobId: sent.jobId, sha }),
    /changed after approval/,
  );
  assert.equal(creations, 0);
  latestSha = sha;
  await provisioner.openPull(project, { jobId: sent.jobId, sha });
  await provisioner.openPull(project, { jobId: sent.jobId, sha });
  assert.equal(creations, 1);
  assert.equal(pulls[0].title, result.title);
  assert.ok(!pulls[0].body.includes(claimed.text));
  const saved = f.store.get("SELECT * FROM jobs WHERE id=?", sent.jobId);
  assert.equal(saved.pr_number, 7);
  assert.ok(saved.approved_at);
  assert.equal(saved.state, "reviewing");
  assert.equal(
    f.store.get(
      "SELECT environment_id FROM previews WHERE project_id=? AND pr_number=7",
      p.id,
    ).environment_id,
    "boat:4000",
  );
  assert.equal(
    f.store.get(
      "SELECT state FROM previews WHERE project_id=? AND pr_number=-1",
      p.id,
    ).state,
    "closed",
  );
});
test("merged PR history distinguishes merged changes from published changes and preserves timestamps", async (t) => {
  const f = await fixture(t),
    p = await f.create(),
    sha = "a".repeat(40),
    published = "b".repeat(40),
    mergedAt = Date.now() - 60000;
  f.store.run("UPDATE projects SET repo='lead/site' WHERE id=?", p.id);
  f.store.run(
    "UPDATE jobs SET state='reviewing',pr_number=7,started_at=? WHERE project_id=?",
    mergedAt - 10000,
    p.id,
  );
  f.store.recordMerge(p.id, 7, sha, { title: "Larger tiles", mergedAt });
  let page = await (await f.call(`/api/projects/${p.id}`)).json();
  assert.equal(page.releases.length, 1);
  assert.equal(page.releases[0].isLive, false);
  assert.equal(page.releases[0].mergedAt, mergedAt);
  const project = f.store.get("SELECT * FROM projects WHERE id=?", p.id);
  f.provider.github = async (_user, path) => {
    if (path.includes("/compare/")) return { status: "ahead" };
    if (path.includes("/pulls?"))
      return [
        {
          number: 8,
          title: "Another merged change",
          user: { login: "teammate" },
          base: { ref: "main" },
          merged_at: new Date(mergedAt - 1000).toISOString(),
          merge_commit_sha: "c".repeat(40),
        },
      ];
    throw Error("Unexpected history request");
  };
  const provisioner = createProvisioner(f.config, f.store, f.provider);
  await provisioner.markPublished(project, published);
  page = await (await f.call(`/api/projects/${p.id}`)).json();
  assert.equal(page.releases[0].isLive, true);
  assert.ok(page.releases[0].publishedAt >= mergedAt);
  assert.equal(page.jobs[0].state, "live");
  assert.ok(page.jobs[0].finishedAt);
  assert.ok(
    page.messages.some((m) => m.text === "Your change is live on the website."),
  );
  await provisioner.markPublished(project, published);
  assert.equal(
    f.store.get("SELECT COUNT(*) AS n FROM releases WHERE project_id=?", p.id)
      .n,
    1,
  );
  const tasksBefore = f.store.get(
    "SELECT COUNT(*) AS n FROM tasks WHERE project_id=?",
    p.id,
  ).n;
  await provisioner.syncHistory(project);
  assert.equal(
    f.store.get("SELECT COUNT(*) AS n FROM tasks WHERE project_id=?", p.id).n,
    tasksBefore,
  );
  assert.equal(
    f.store.get("SELECT COUNT(*) AS n FROM releases WHERE project_id=?", p.id)
      .n,
    2,
  );
});
test("automatic review repairs are deduplicated, bounded, and never queued for stale or held PRs", async (t) => {
  const f = await fixture(t),
    p = await f.create(),
    sha = "a".repeat(40),
    base = "b".repeat(40);
  f.store.run("UPDATE projects SET repo='lead/site' WHERE id=?", p.id);
  f.store.run(
    "UPDATE jobs SET state='needs_attention',pr_number=1 WHERE project_id=?",
    p.id,
  );
  const project = f.store.get("SELECT * FROM projects WHERE id=?", p.id),
    original = f.store.get("SELECT * FROM jobs WHERE project_id=?", p.id);
  let head = sha,
    labels = [];
  f.provider.github = async (_user, path) =>
    path.endsWith("/pulls/1")
      ? {
          state: "open",
          draft: false,
          head: { sha: head, ref: "lead/change" },
          labels,
        }
      : { object: { sha: base } };
  const repair = () =>
    workerCall(f, project, "/github", {
      operation: "repair",
      number: 1,
      sha,
      base,
      text: "Restore keyboard activation.",
    });
  head = "c".repeat(40);
  assert.equal((await (await repair()).json()).queued, false);
  head = sha;
  labels = [{ name: "hold" }];
  assert.equal((await (await repair()).json()).queued, false);
  labels = [];
  const queued = await (await repair()).json();
  assert.equal(queued.queued, true);
  assert.equal((await (await repair()).json()).queued, false);
  assert.equal(
    f.store.get("SELECT member_id FROM jobs WHERE id=?", queued.jobId)
      .member_id,
    original.member_id,
  );
  assert.equal(
    f.store.get("SELECT COUNT(*) AS n FROM jobs WHERE project_id=?", p.id).n,
    2,
  );
  f.store.run("UPDATE jobs SET state='failed' WHERE id=?", queued.jobId);
  for (const n of [2, 3])
    f.store.run(
      "INSERT INTO jobs(id,project_id,member_id,request_key,text,state,created_at,updated_at) VALUES(?,?,?,?,?,'failed',?,?)",
      id(),
      p.id,
      original.member_id,
      `review-fix:1:attempt-${n}`,
      "Repair",
      now(),
      now(),
    );
  const limited = await (
    await workerCall(f, project, "/github", {
      operation: "repair",
      number: 1,
      sha: "d".repeat(40),
      base,
      text: "Fix another issue.",
    })
  ).json();
  assert.equal(limited.queued, false);
  head = "d".repeat(40);
  const cap = await (
    await workerCall(f, project, "/github", {
      operation: "repair",
      number: 1,
      sha: head,
      base,
      text: "Fix another issue.",
    })
  ).json();
  assert.equal(cap.reason, "Repair limit reached.");
});
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

test("GitHub approval waits without repeating setup and resumes the same project with owner-only access", async (t) => {
  const f = await fixture(t),
    p = await f.create();
  f.store.run(
    "UPDATE projects SET hosting_provider='boat',repo=? WHERE id=?",
    "lead/created-project",
    p.id,
  );
  let approved = false,
    checks = 0;
  f.provider.createRepository = async () => {
    checks++;
    if (!approved)
      throw Object.assign(Error("Approve this project on GitHub."), {
        code: "github_repository_access_required",
      });
    return { id: 88, full_name: "lead/created-project" };
  };
  const provisioner = createProvisioner(f.config, f.store, f.provider);
  await provisioner.tick();
  assert.equal(
    f.store.get("SELECT state FROM projects WHERE id=?", p.id).state,
    "github_access",
  );
  await provisioner.tick();
  assert.equal(checks, 1);
  const owner = await (await f.call(`/api/projects/${p.id}`)).json();
  assert.deepEqual(owner.githubAccess, {
    repo: "lead/created-project",
    url: "https://github.com/settings/installations/99",
  });
  const member = await f.join((await f.invite(p.id)).url, "Teammate");
  assert.equal(
    (await (await f.call(`/api/projects/${p.id}`, undefined, member)).json())
      .githubAccess,
    null,
  );
  assert.equal(
    (await f.call(`/api/projects/${p.id}/github-access`, {}, member)).status,
    403,
  );
  assert.equal(
    (
      await f.call(`/api/projects/${p.id}/github-access`, {}, f.owner, {
        origin: "https://attacker.example.test",
      })
    ).status,
    403,
  );
  assert.deepEqual(
    await (await f.call(`/api/projects/${p.id}/github-access`, {})).json(),
    { ready: false },
  );
  assert.equal(
    f.store.get(
      "SELECT state FROM tasks WHERE project_id=? AND kind='provision'",
      p.id,
    ).state,
    "failed",
  );
  approved = true;
  assert.deepEqual(
    await (await f.call(`/api/projects/${p.id}/github-access`, {})).json(),
    { ready: true },
  );
  assert.equal(
    f.store.get(
      "SELECT state FROM tasks WHERE project_id=? AND kind='provision'",
      p.id,
    ).state,
    "queued",
  );
  assert.equal(f.store.get("SELECT COUNT(*) AS n FROM projects").n, 1);
  assert.equal(
    f.store.get("SELECT COUNT(*) AS n FROM jobs WHERE project_id=?", p.id).n,
    1,
  );
  assert.equal(
    f.store.get("SELECT repo FROM projects WHERE id=?", p.id).repo,
    "lead/created-project",
  );
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
    "x-butler-protocol": "2",
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
