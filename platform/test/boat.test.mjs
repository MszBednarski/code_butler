import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, cp, writeFile } from "node:fs/promises";
import { createStore, id, token, digest, now } from "../store.mjs";
import { createBoat, boatActions } from "../boat.mjs";
import { createBoatProvisioner } from "../boat-provision.mjs";
import { createPlatform } from "../server.mjs";
import { configuration } from "../config.mjs";
import { gunzipSync } from "node:zlib";

async function fixture(t) {
  const directory = await mkdtemp("/tmp/butler-boat-test-"),
    store = createStore(directory),
    user = store.guest("Lead");
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    store,
    user,
    config: {
      boatOrigin: "https://boat.dev",
      publicUrl: "https://butler.example.test",
      workerDir: new URL("../../project-worker/", import.meta.url).pathname,
    },
  };
}
test("regular onboarding defaults to Boat even with a remembered Railway connection, without moving saved projects", async (t) => {
  assert.equal(configuration({}).defaultHostingProvider, "boat");
  assert.equal(
    configuration({ DEFAULT_HOSTING_PROVIDER: "railway" })
      .defaultHostingProvider,
    "railway",
  );
  const f = await fixture(t);
  Object.assign(f.config, {
    frontend: "/missing",
    githubAppId: 123,
    githubAppSlug: "butler-test",
    githubAppPrivateKey: "fixture-key",
    githubAppWebhookSecret: "fixture-hook",
  });
  f.store.run(
    "UPDATE users SET github_id=?,github_login=? WHERE id=?",
    "42",
    "lead",
    f.user.id,
  );
  f.store.connection(f.user.id, "github_installation", {
    id: 99,
    accountId: 42,
  });
  f.store.connection(f.user.id, "railway", {
    access_token: "remembered-railway-fixture",
  });
  const platform = createPlatform(f.config, {
    store: f.store,
    provider: {},
    provisioner: {},
  });
  await new Promise((resolve) =>
    platform.server.listen(0, "127.0.0.1", resolve),
  );
  f.config.publicUrl = `http://127.0.0.1:${platform.server.address().port}`;
  t.after(() => new Promise((resolve) => platform.server.close(resolve)));
  const request = (path, body) =>
    fetch(f.config.publicUrl + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        cookie: `butler_account=${f.store.session(f.user.id)}`,
        origin: f.config.publicUrl,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const fresh = await (await fetch(f.config.publicUrl + "/api/session")).json();
  assert.equal(fresh.hostingProvider, "boat");
  const remembered = await (await request("/api/session")).json();
  assert.equal(remembered.connections.railway, true);
  assert.equal(remembered.hostingProvider, "boat");
  const missingBoat = await request("/api/projects", {
    name: "Together",
    description: "A team website",
    requestKey: id(),
    hostingProvider: "railway",
  });
  assert.equal(missingBoat.status, 409);
  assert.match((await missingBoat.json()).error, /Boat/);
  f.store.connection(f.user.id, "boat", {
    access_token: "limited-fixture",
    environmentId: id(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
  const create = async () => {
    const response = await request("/api/projects", {
      name: "Together",
      description: "A team website",
      requestKey: id(),
    });
    assert.equal(response.status, 201);
    return (await response.json()).id;
  };
  const saved = await create();
  f.store.run(
    "UPDATE projects SET hosting_provider='railway',repo=?,resources=? WHERE id=?",
    "lead/existing",
    '{"existing":true}',
    saved,
  );
  const next = await create();
  assert.equal(
    f.store.get("SELECT hosting_provider FROM projects WHERE id=?", next)
      .hosting_provider,
    "boat",
  );
  assert.equal(
    (await (await request(`/api/projects/${saved}`)).json()).hostingProvider,
    "railway",
  );
  assert.deepEqual(
    { ...f.store.get("SELECT repo,resources FROM projects WHERE id=?", saved) },
    { repo: "lead/existing", resources: '{"existing":true}' },
  );
});
test("Boat browser login survives a restart and retains only an environment-limited credential", async (t) => {
  const f = await fixture(t),
    requests = [];
  let approved = false;
  const environment = { id: id(), name: `butler-${f.user.id}` };
  const request = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ url, body, authorization: options.headers.Authorization });
    if (url.endsWith("/cli/login/start"))
      return Response.json({
        login_url: "https://boat.dev/api/boat/auth/github?state=fixture",
        poll_token: "private-poll-fixture",
        user_code: "AAAA-BBBB",
        expires_at: new Date(Date.now() + 600000).toISOString(),
      });
    if (url.endsWith("/cli/login/poll/private-poll-fixture"))
      return Response.json({
        status: approved ? "complete" : "pending",
        token: approved ? "broad-device-fixture" : null,
      });
    if (url.endsWith("/api/v1/me"))
      return Response.json({ user: { id: "boat-user-fixture" } });
    if (url.endsWith("/limits"))
      return Response.json({ canStart: true, accessTier: "trial" });
    if (url.endsWith("/api-keys"))
      return Response.json({ catalog: { scopedCreationEnabled: true } });
    if (url.endsWith("/environments"))
      return Response.json({
        environments: options.method === "POST" ? [environment] : [],
      });
    if (url.endsWith("/environments/" + environment.id)) {
      assert.equal(body.safeForThirdParties, true);
      assert.equal(body.passGithub, false);
      assert.equal(body.passAgentsCredentials, false);
      return Response.json({ environment });
    }
    if (url.endsWith("/api-keys/scoped")) {
      assert.deepEqual(body.actions, boatActions);
      assert.deepEqual(body.environmentIds, [environment.id]);
      assert.ok(!body.actions.includes("account.admin"));
      return Response.json({
        secret: "limited-environment-key-fixture",
        apiKey: {
          id: "key-fixture",
          credentialLane: "scoped-v1",
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          scope: {
            actions: boatActions,
            environments: [environment.id],
            sandboxes: [],
          },
        },
      });
    }
    if (url.endsWith("/auth/logout"))
      return new Response(null, { status: 204 });
    throw new Error("Unexpected Boat request");
  };
  const first = createBoat(f.config, f.store, request),
    pending = await first.boatAuth.start(f.user.id);
  assert.equal(pending.state, "pending");
  assert.equal(pending.code, "AAAA-BBBB");
  assert.ok(!JSON.stringify(pending).includes("private-poll-fixture"));
  assert.equal(
    (await first.boatAuth.status(f.store.guest("Other").id)).state,
    "signed_out",
  );
  approved = true;
  const resumed = createBoat(f.config, f.store, request);
  assert.equal((await resumed.boatAuth.status(f.user.id)).state, "connected");
  assert.equal(resumed.boatToken(f.user.id), "limited-environment-key-fixture");
  assert.equal(f.store.connection(f.user.id, "boat_pending"), null);
  assert.equal(f.store.connection(f.user.id, "boat_session_revoke"), null);
  assert.ok(requests.some((r) => r.url.endsWith("/auth/logout")));
  assert.ok(
    !f.store
      .get("SELECT secret FROM connections WHERE provider='boat'")
      .secret.includes("limited-environment-key-fixture"),
  );
});
test("Boat cannot fall back to an unrestricted device credential when scoped keys are unavailable", async (t) => {
  const f = await fixture(t),
    requests = [];
  f.store.connection(f.user.id, "boat_pending", {
    token: "unrestricted-fixture",
  });
  const access = createBoat(f.config, f.store, async (url) => {
    requests.push(url);
    if (url.endsWith("/me")) return Response.json({ user: { id: "user" } });
    if (url.endsWith("/limits"))
      return Response.json({ canStart: false, checkoutRequired: true });
    if (url.endsWith("/api-keys"))
      return Response.json({ catalog: { scopedCreationEnabled: false } });
    throw new Error("No billing or provisioning is allowed");
  });
  await assert.rejects(
    access.boatAuth.status(f.user.id),
    /will not save an unrestricted/,
  );
  assert.equal(f.store.connection(f.user.id, "boat"), null);
  assert.throws(() => access.boatToken(f.user.id), /Reconnect Boat/);
  assert.ok(
    requests.every(
      (url) => !url.includes("billing") && !url.includes("sandboxes"),
    ),
  );
});
test("Boat connection routes require a verified lead, protect writes and ignore caller-supplied account IDs", async (t) => {
  const f = await fixture(t),
    calls = [];
  f.config.frontend = "/missing";
  const auth = Object.fromEntries(
    ["start", "status", "billing"].map((method) => [
      method,
      async (user) => {
        calls.push({ method, user });
        return { state: "pending", code: "AAAA-BBBB" };
      },
    ]),
  );
  const platform = createPlatform(f.config, {
    store: f.store,
    provider: { boatAuth: auth },
    provisioner: {},
  });
  await new Promise((resolve) =>
    platform.server.listen(0, "127.0.0.1", resolve),
  );
  f.config.publicUrl = `http://127.0.0.1:${platform.server.address().port}`;
  t.after(() => new Promise((resolve) => platform.server.close(resolve)));
  const cookie = `butler_account=${f.store.session(f.user.id)}`;
  const request = (
    path,
    method = "GET",
    account = cookie,
    origin = f.config.publicUrl,
  ) =>
    fetch(f.config.publicUrl + path, {
      method,
      headers: { cookie: account, origin, "content-type": "application/json" },
      body:
        method === "GET"
          ? undefined
          : JSON.stringify({ userId: "someone-else" }),
    });
  assert.equal((await request("/api/auth/boat", "GET", "")).status, 401);
  assert.equal((await request("/api/auth/boat")).status, 403);
  assert.equal((await request("/api/auth/boat", "POST")).status, 403);
  assert.deepEqual(calls, []);
  f.store.run(
    "UPDATE users SET github_id=?,github_login=? WHERE id=?",
    "1234",
    "lead",
    f.user.id,
  );
  assert.equal(
    (
      await request(
        "/api/auth/boat",
        "POST",
        cookie,
        "https://attacker.example.test",
      )
    ).status,
    403,
  );
  for (const [path, method] of [
    ["/api/auth/boat", "GET"],
    ["/api/auth/boat", "POST"],
    ["/api/auth/boat/billing", "POST"],
  ])
    assert.equal((await request(path, method)).status, 200);
  assert.deepEqual(
    calls,
    ["status", "start", "billing"].map((method) => ({
      method,
      user: f.user.id,
    })),
  );
});
test("Boat billing hands off to provider checkout without starting a machine or accepting card details", async (t) => {
  const f = await fixture(t),
    requests = [];
  f.store.connection(f.user.id, "boat_pending", {
    token: "device-session-fixture",
  });
  const access = createBoat(f.config, f.store, async (url, options) => {
    requests.push(url);
    if (url.endsWith("/me")) return Response.json({ user: { id: "user" } });
    if (url.endsWith("/limits"))
      return Response.json({ canStart: false, checkoutRequired: true });
    if (url.endsWith("/api-keys"))
      return Response.json({ catalog: { scopedCreationEnabled: true } });
    if (url.endsWith("/billing/checkout")) {
      assert.deepEqual(JSON.parse(options.body), { kind: "subscription" });
      return Response.json({
        url: "https://checkout.stripe.com/c/pay-fixture",
      });
    }
    throw new Error("No machine is authorized yet");
  });
  const state = await access.boatAuth.status(f.user.id);
  assert.equal(state.state, "billing");
  assert.equal(new URL(state.url).hostname, "checkout.stripe.com");
  assert.equal(f.store.connection(f.user.id, "boat"), null);
  assert.ok(!requests.some((u) => u.endsWith("/sandboxes")));
});
test("Boat provisioning retries reuse one VM and previews never fork or copy agent credentials", async (t) => {
  const f = await fixture(t),
    projectId = id(),
    worker = token(),
    invitation = token(),
    requests = [],
    files = [],
    commands = [];
  f.store.connection(f.user.id, "boat", {
    access_token: "limited-key-fixture",
    environmentName: "butler-test-environment",
    trial: true,
  });
  f.store.run(
    "INSERT INTO projects(id,owner_id,name,description,slug,invite_hash,invite_secret,worker_secret,worker_hash,webhook_secret,repo,resources,hosting_provider,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    projectId,
    f.user.id,
    "Together",
    "Our app",
    "together",
    digest(invitation),
    f.store.seal(invitation),
    f.store.seal(worker),
    digest(worker),
    f.store.seal(token()),
    "lead/project",
    JSON.stringify({ initialSha: "a".repeat(40) }),
    "boat",
    now(),
  );
  const project = f.store.get("SELECT * FROM projects WHERE id=?", projectId),
    created = new Map();
  let loseFirst = true,
    state = "ready",
    processId = 0;
  const provider = {
    request: async () => new Response("ok"),
    boat: async (_user, endpoint, method = "GET", body, extra) => {
      requests.push({ endpoint, method, body, extra });
      if (endpoint === "/limits")
        return { canStart: true, accessTier: "trial" };
      if (endpoint === "/sandboxes") {
        assert.equal(body.noEnv, true);
        assert.equal(body.snapshots, true);
        assert.equal(body.ttlSeconds, 7200);
        assert.equal(body.environment, "butler-test-environment");
        const key = extra.headers["Idempotency-Key"];
        created.set(key, created.get(key) || { id: "bx_23456789" });
        if (loseFirst) {
          loseFirst = false;
          throw new Error("Lost create response");
        }
        return { sandbox: created.get(key) };
      }
      if (endpoint === "/sandboxes/bx_23456789")
        return {
          sandbox: {
            state,
            archiveAfter: new Date(Date.now() + 7200000).toISOString(),
          },
        };
      if (endpoint.endsWith("/resume")) {
        state = "ready";
        return { sandbox: { state } };
      }
      if (endpoint.endsWith("/files")) {
        files.push(body);
        return { success: true };
      }
      if (endpoint.endsWith("/commands")) {
        commands.push(body.command);
        return { processId: ++processId, exitCode: 0 };
      }
      if (endpoint.includes("/commands/"))
        return { running: false, exitCode: 0 };
      if (endpoint.endsWith("/host")) {
        assert.equal(body.public, true);
        return { url: `https://butler-test-${body.port}.on.boat.dev` };
      }
      throw new Error("Unexpected Boat operation " + endpoint);
    },
    github: async (_user, endpoint, method = "GET") => {
      if (endpoint.endsWith("/pulls/7"))
        return { state: "open", head: { sha: "b".repeat(40) } };
      if (endpoint.includes("/comments"))
        return method === "GET" ? [] : { id: 1 };
      throw new Error("Unexpected GitHub operation");
    },
  };
  const source = async () => {
    const dir = await mkdtemp(f.directory + "/source-");
    await cp(new URL("../template/", import.meta.url), dir, {
      recursive: true,
    });
    for (const name of [
      ".netrc",
      ".git-credentials",
      "saved.sqlite3",
      "auth.json",
      ".env.local",
      "private.pem",
      "saved.db",
      "login.p12",
    ])
      await writeFile(dir + "/app/" + name, "sensitive-dont-ship-fixture");
    return dir;
  };
  const boat = createBoatProvisioner(f.config, f.store, provider, {
    source,
    markPublished: async () => {},
    pause: async () => {},
  });
  await assert.rejects(boat.provision(project), /Lost create response/);
  await boat.provision(project);
  assert.equal(created.size, 1);
  assert.equal(
    f.store.get("SELECT state FROM projects WHERE id=?", project.id).state,
    "ready",
  );
  const baseline = commands.length;
  await boat.deploy(project, { sha: "b".repeat(40), prNumber: 7 });
  const firstPort = f.store.get(
    "SELECT environment_id FROM previews WHERE project_id=? AND pr_number=7",
    project.id,
  ).environment_id;
  await boat.deploy(project, { sha: "b".repeat(40), prNumber: 7 });
  assert.equal(
    f.store.get(
      "SELECT environment_id FROM previews WHERE project_id=? AND pr_number=7",
      project.id,
    ).environment_id,
    firstPort,
  );
  await boat.cleanup(project, { prNumber: 7 });
  await boat.deploy(project, { sha: "b".repeat(40), prNumber: 7 });
  assert.equal(
    f.store.get(
      "SELECT environment_id FROM previews WHERE project_id=? AND pr_number=7",
      project.id,
    ).environment_id,
    firstPort,
  );
  assert.ok(
    commands
      .slice(baseline)
      .every(
        (command) =>
          !command.includes("butler-worker") && !command.includes("worker.env"),
      ),
  );
  for (const file of files.filter((file) => file.path.endsWith(".tgz")))
    assert.ok(
      !gunzipSync(Buffer.from(file.content, "base64")).includes(
        Buffer.from("sensitive-dont-ship-fixture"),
      ),
    );
  assert.ok(!requests.some((r) => r.endpoint.includes("fork")));
  assert.ok(
    files.every(
      (file) =>
        !Buffer.from(file.content, "base64").includes(
          Buffer.from("limited-key-fixture"),
        ),
    ),
  );
  assert.equal(
    f.store.get(
      "SELECT state FROM previews WHERE project_id=? AND pr_number=7",
      project.id,
    ).state,
    "ready",
  );
  state = "archived";
  await boat.ensure(project);
  assert.equal(
    requests.filter((r) => r.endpoint.endsWith("/resume")).length,
    1,
  );
});
