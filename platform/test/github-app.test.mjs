import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { createStore, id, token, digest, now } from "../store.mjs";
import { createPlatform } from "../server.mjs";
import {
  createGithubAccess,
  githubPermissions,
  repositoryPermissions,
  githubJwt,
  validateInstallation,
  retireLegacyGithub,
} from "../github-app.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const pem = privateKey.export({ type: "pkcs8", format: "pem" });
async function fixture(t) {
  const directory = await mkdtemp("/tmp/butler-github-app-"),
    store = createStore(directory);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const user = store.guest("Lead");
  store.run(
    "UPDATE users SET github_id='42',github_login='lead' WHERE id=?",
    user.id,
  );
  const config = {
    githubApi: "https://api.github.com",
    githubAppId: 123,
    githubAppSlug: "butler-test",
    githubAppPrivateKey: pem,
    githubAppWebhookSecret: "hook-fixture-secret",
    githubClientId: "oauth-profile-client",
    githubClientSecret: "oauth-profile-secret",
  };
  const installation = {
    id: 99,
    app_id: 123,
    repository_selection: "selected",
    permissions: { ...githubPermissions },
    account: { id: 42, login: "lead", type: "User" },
    suspended_at: null,
  };
  store.connection(user.id, "github_installation", { id: 99 });
  function project(repo = "lead/butler-fixture") {
    const projectId = id(),
      invitation = token(),
      worker = token();
    store.run(
      "INSERT INTO projects(id,owner_id,name,description,slug,invite_hash,invite_secret,worker_secret,worker_hash,webhook_secret,repo,resources,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      projectId,
      user.id,
      "Together",
      "A website",
      "fixture-" + projectId.slice(0, 8),
      digest(invitation),
      store.seal(invitation),
      store.seal(worker),
      digest(worker),
      store.seal(token()),
      repo,
      JSON.stringify(
        repo ? { githubRepositoryId: 7, githubInstallationId: 99 } : {},
      ),
      now(),
    );
    return store.get("SELECT * FROM projects WHERE id=?", projectId);
  }
  return { directory, store, user, config, installation, project };
}
test("GitHub App JWTs expire in ten minutes and installations must belong to the signed-in user with selected repositories", async (t) => {
  const f = await fixture(t),
    jwt = githubJwt(f.config),
    [header, payload, signature] = jwt.split(".");
  assert.equal(
    verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature, "base64url"),
    ),
    true,
  );
  const claims = JSON.parse(Buffer.from(payload, "base64url"));
  assert.equal(claims.iss, "123");
  assert.equal(claims.exp - claims.iat, 600);
  const user = f.store.get("SELECT * FROM users WHERE id=?", f.user.id);
  assert.equal(validateInstallation(f.config, user, f.installation).id, 99);
  for (const change of [
    { repository_selection: "all" },
    { app_id: 456 },
    { account: { id: 43, type: "User" } },
    { account: { id: 42, type: "Organization" } },
    { suspended_at: "today" },
    { permissions: { ...githubPermissions, administration: "write" } },
    { permissions: { ...githubPermissions, contents: "read" } },
  ])
    assert.throws(() =>
      validateInstallation(f.config, user, { ...f.installation, ...change }),
    );
});
test("project GitHub and git credentials are short-lived and restricted to that one repository, with no legacy OAuth fallback", async (t) => {
  const f = await fixture(t),
    p = f.project(),
    requests = [];
  const access = createGithubAccess(f.config, f.store, async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith("/app/installations/99"))
      return Response.json(f.installation);
    if (url.endsWith("/app/installations/99/access_tokens")) {
      assert.deepEqual(JSON.parse(options.body), {
        repository_ids: [7],
        permissions: repositoryPermissions,
      });
      return Response.json({
        token: "one-repository-only",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
    }
    assert.equal(
      url,
      "https://api.github.com/repos/lead/butler-fixture/contents/app",
    );
    assert.equal(options.headers.Authorization, "Bearer one-repository-only");
    return Response.json({ path: "app" });
  });
  assert.equal(
    (await access.github(f.user.id, `/repos/${p.repo}/contents/app`)).path,
    "app",
  );
  assert.equal(
    await access.repositoryToken(f.user.id, p.repo),
    "one-repository-only",
  );
  assert.equal(
    requests.filter((r) => r.url.endsWith("access_tokens")).length,
    1,
  );
  await assert.rejects(
    access.github(f.user.id, "/repos/lead/private-finances/contents"),
    /not assigned/,
  );
  await assert.rejects(
    access.github(f.user.id, "/user/repos"),
    /Only this project/,
  );
  f.store.connection(f.user.id, "github", {
    access_token: "old-broad-token",
    scope: "repo",
  });
  f.store.run("DELETE FROM connections WHERE provider='github_installation'");
  await assert.rejects(
    access.repositoryToken(f.user.id, p.repo),
    /Connect Butler/,
  );
  assert.ok(!JSON.stringify(requests).includes("old-broad-token"));
});
test("repository creation uses its dedicated permission without contents access or repository administration", async (t) => {
  const f = await fixture(t),
    p = f.project(null),
    requested = [];
  const access = createGithubAccess(f.config, f.store, async (url, options) => {
    if (url.endsWith("/app/installations/99"))
      return Response.json(f.installation);
    if (url.endsWith("/access_tokens")) {
      const b = JSON.parse(options.body);
      requested.push(b.permissions);
      assert.equal(b.permissions.contents, undefined);
      assert.equal(b.permissions.administration, undefined);
      return Response.json({
        token: b.permissions.repository_creation
          ? "create-only"
          : "metadata-only",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
    }
    if (url.includes("/repos/lead/"))
      return Response.json({ message: "Not found" }, { status: 404 });
    assert.equal(url, "https://api.github.com/user/repos");
    assert.equal(options.headers.Authorization, "Bearer create-only");
    const body = JSON.parse(options.body);
    return Response.json({
      id: 88,
      owner: { id: 42 },
      full_name: "lead/" + body.name,
      description: body.description,
      default_branch: "main",
    });
  });
  const repo = await access.createRepository(p);
  assert.deepEqual(requested, [
    { metadata: "read" },
    { metadata: "read", repository_creation: "write" },
  ]);
  const saved = f.store.get("SELECT * FROM projects WHERE id=?", p.id);
  assert.equal(saved.repo, repo.full_name);
  assert.equal(JSON.parse(saved.resources).githubRepositoryId, 88);
});
test("a created repository awaiting selection is reused after approval without creating it again", async (t) => {
  const f = await fixture(t),
    p = f.project(null);
  let approved = false,
    created = 0,
    repo;
  const access = createGithubAccess(f.config, f.store, async (url, options) => {
    if (url.endsWith("/app/installations/99"))
      return Response.json(f.installation);
    if (url.endsWith("/access_tokens")) {
      const body = JSON.parse(options.body);
      if (body.repository_ids && !approved)
        return Response.json(
          {
            message:
              "There is at least one repository that does not exist or is not accessible to the parent installation.",
          },
          { status: 422 },
        );
      if (body.repository_ids) assert.deepEqual(body.repository_ids, [88]);
      return Response.json({
        token: body.permissions.repository_creation
          ? "create-only"
          : "repo-metadata",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
    }
    if (url === "https://api.github.com/user/repos") {
      created++;
      const body = JSON.parse(options.body);
      repo = {
        id: 88,
        owner: { id: 42 },
        full_name: "lead/" + body.name,
        description: body.description,
        default_branch: "main",
      };
      return Response.json(repo);
    }
    if (url.includes("/repos/lead/"))
      return approved
        ? Response.json(repo)
        : Response.json({ message: "Not Found" }, { status: 404 });
    throw Error("Unexpected request");
  });
  const found = await access.createRepository(p);
  const missing = (error) => error.code === "github_repository_access_required";
  await assert.rejects(
    access.repositoryToken(f.user.id, found.full_name),
    missing,
  );
  await assert.rejects(access.createRepository(p), missing);
  assert.equal(created, 1);
  approved = true;
  assert.equal((await access.createRepository(p)).id, 88);
  assert.equal(created, 1);
  assert.equal(
    JSON.parse(
      f.store.get("SELECT resources FROM projects WHERE id=?", p.id).resources,
    ).githubRepositoryId,
    88,
  );
});
test("a lost repository creation response refreshes metadata instead of creating a second repository", async (t) => {
  const f = await fixture(t),
    p = f.project(null);
  let repo,
    created = 0,
    generation = 0;
  const canSee = new Map();
  const access = createGithubAccess(f.config, f.store, async (url, options) => {
    if (url.endsWith("/app/installations/99"))
      return Response.json(f.installation);
    if (url.endsWith("/access_tokens")) {
      const body = JSON.parse(options.body),
        credential = "fixture-" + ++generation;
      canSee.set(credential, Boolean(repo));
      return Response.json({
        token: credential,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
    }
    if (url === "https://api.github.com/user/repos") {
      created++;
      const body = JSON.parse(options.body);
      repo = {
        id: 88,
        owner: { id: 42 },
        full_name: "lead/" + body.name,
        description: body.description,
        default_branch: "main",
      };
      throw Error("Successful creation response was lost");
    }
    if (url.includes("/repos/lead/"))
      return canSee.get(options.headers.Authorization.slice(7))
        ? Response.json(repo)
        : Response.json({ message: "Not Found" }, { status: 404 });
    throw Error("Unexpected request");
  });
  await assert.rejects(access.createRepository(p), /response was lost/);
  assert.equal((await access.createRepository(p)).id, 88);
  assert.equal(created, 1);
});
test("old OAuth repository grants are quarantined immediately and revoked, with failed revocations retried", async (t) => {
  const f = await fixture(t);
  f.store.connection(f.user.id, "github", {
    access_token: "legacy-access-fixture",
    scope: "repo",
  });
  const first = await retireLegacyGithub(f.config, f.store, async () =>
    Response.json({}, { status: 503 }),
  );
  assert.deepEqual(first, { revoked: 0, pending: 1 });
  assert.equal(f.store.connection(f.user.id, "github"), null);
  assert.ok(f.store.connection(f.user.id, "github_legacy_revoke"));
  const second = await retireLegacyGithub(
    f.config,
    f.store,
    async (url, options) => {
      assert.equal(
        url,
        "https://api.github.com/applications/oauth-profile-client/grant",
      );
      assert.equal(options.method, "DELETE");
      assert.equal(
        JSON.parse(options.body).access_token,
        "legacy-access-fixture",
      );
      return new Response(null, { status: 204 });
    },
  );
  assert.deepEqual(second, { revoked: 1, pending: 0 });
  assert.equal(f.store.connection(f.user.id, "github_legacy_revoke"), null);
});

test("existing projects automatically recover repository IDs after connecting the limited app without recreating any work", async (t) => {
  const f = await fixture(t),
    project = f.project(),
    grants = [];
  f.store.run(
    "UPDATE projects SET resources=? WHERE id=?",
    JSON.stringify({ app: { deployment: "keep-this" } }),
    project.id,
  );
  const access = createGithubAccess(f.config, f.store, async (url, options) => {
    if (url.endsWith("/app/installations/99"))
      return Response.json(f.installation);
    if (url.endsWith("/access_tokens")) {
      const body = JSON.parse(options.body);
      grants.push(body);
      return Response.json({
        token: body.repository_ids ? "one-repo" : "metadata-only",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
    }
    assert.equal(url, "https://api.github.com/repos/lead/butler-fixture");
    assert.equal(options.headers.Authorization, "Bearer metadata-only");
    return Response.json({ id: 7, full_name: project.repo, owner: { id: 42 } });
  });
  assert.equal(
    await access.repositoryToken(f.user.id, project.repo),
    "one-repo",
  );
  assert.deepEqual(grants, [
    { permissions: { metadata: "read" } },
    { repository_ids: [7], permissions: repositoryPermissions },
  ]);
  const resources = JSON.parse(
    f.store.get("SELECT resources FROM projects WHERE id=?", project.id)
      .resources,
  );
  assert.deepEqual(resources, {
    app: { deployment: "keep-this" },
    githubRepositoryId: 7,
    githubInstallationId: 99,
  });
  assert.equal(
    await access.repositoryToken(f.user.id, project.repo),
    "one-repo",
  );
  assert.equal(grants.length, 2);
  f.store.run(
    "UPDATE projects SET resources=? WHERE id=?",
    JSON.stringify({
      ...resources,
      githubInstallationId: 55,
      githubRepositoryId: 88,
    }),
    project.id,
  );
  await assert.rejects(
    access.repositoryToken(f.user.id, project.repo),
    /does not match/,
  );
});
test("manifest registration is browser-bound, requests only the limited permissions and saves app keys encrypted without returning secrets", async (t) => {
  const f = await fixture(t),
    setup = token(),
    converted = [];
  Object.assign(f.config, {
    publicUrl: "http://127.0.0.1",
    secure: false,
    dataDir: f.directory,
    frontend: "/missing",
    setupToken: setup,
  });
  const platform = createPlatform(f.config, {
    store: f.store,
    provisioner: {},
    provider: {
      request: async (url) => {
        converted.push(url);
        return Response.json({
          id: 456,
          slug: "registered-butler",
          client_id: "Iv1.profile-app",
          client_secret: "app-client-secret-fixture",
          pem,
          webhook_secret: "webhook-new-fixture-secret",
          permissions: githubPermissions,
        });
      },
    },
  });
  await new Promise((r) => platform.server.listen(0, "127.0.0.1", r));
  f.config.publicUrl = `http://127.0.0.1:${platform.server.address().port}`;
  t.after(() => new Promise((r) => platform.server.close(r)));
  const start = await fetch(
    f.config.publicUrl + "/api/setup/github-app/manifest",
    {
      method: "POST",
      headers: {
        origin: f.config.publicUrl,
        "content-type": "application/json",
      },
      body: JSON.stringify({ token: setup }),
    },
  );
  assert.equal(start.status, 200);
  const data = await start.json(),
    state = new URL(data.url).searchParams.get("state"),
    cookie = start.headers.get("set-cookie").split(";")[0];
  assert.deepEqual(data.manifest.default_permissions, githubPermissions);
  for (const absent of [
    "administration",
    "issues",
    "members",
    "organization_administration",
    "workflows",
  ])
    assert.equal(data.manifest.default_permissions[absent], undefined);
  const callback =
    f.config.publicUrl +
    `/auth/github-app/manifest/callback?state=${state}&code=manifest-code-12345`;
  assert.equal((await fetch(callback, { redirect: "manual" })).status, 400);
  assert.equal(converted.length, 0);
  const done = await fetch(callback, {
    headers: { cookie },
    redirect: "manual",
  });
  assert.equal(done.status, 302);
  assert.equal(done.headers.get("location"), "/setup?github_app=registered");
  assert.equal(f.config.githubAppId, 456);
  assert.equal(f.store.setting("provider-settings").githubAppPrivateKey, pem);
  assert.ok(!JSON.stringify([...done.headers]).includes(pem));
  assert.ok(
    !(await readFile(f.directory + "/butler.sqlite")).includes(
      Buffer.from(pem),
    ),
  );
  assert.equal(
    (await fetch(callback, { headers: { cookie }, redirect: "manual" })).status,
    400,
  );
});

test("GitHub sign-in never requests repo scope, never stores profile tokens and rejects inherited broad grants", async (t) => {
  const f = await fixture(t);
  let broad = false;
  const revocations = [];
  Object.assign(f.config, {
    publicUrl: "http://127.0.0.1",
    secure: false,
    dataDir: f.directory,
    frontend: "/missing",
  });
  const platform = createPlatform(f.config, {
    store: f.store,
    provisioner: {},
    provider: {
      request: async (url, options) => {
        if (url.endsWith("/login/oauth/access_token"))
          return Response.json({
            access_token: "profile-login-token-fixture",
            scope: broad ? "read:user repo" : "read:user",
          });
        if (url.endsWith("/grant")) {
          revocations.push(JSON.parse(options.body));
          return new Response(null, { status: 204 });
        }
        if (url === "https://api.github.com/user")
          return Response.json({ id: 42, login: "lead", name: "Lead" });
        throw new Error("Unexpected profile request");
      },
    },
  });
  await new Promise((r) => platform.server.listen(0, "127.0.0.1", r));
  f.config.publicUrl = `http://127.0.0.1:${platform.server.address().port}`;
  t.after(() => new Promise((r) => platform.server.close(r)));
  async function login() {
    const start = await fetch(f.config.publicUrl + "/auth/github", {
      redirect: "manual",
    });
    const url = new URL(start.headers.get("location"));
    assert.ok(!url.searchParams.get("scope")?.split(" ").includes("repo"));
    const result = await fetch(
      f.config.publicUrl +
        `/auth/github/callback?code=code&state=${url.searchParams.get("state")}`,
      {
        headers: { cookie: start.headers.get("set-cookie").split(";")[0] },
        redirect: "manual",
      },
    );
    assert.equal(f.store.connection(f.user.id, "github"), null);
    return { url, result };
  }
  assert.ok(
    (await login()).result.headers
      .get("set-cookie")
      .includes("butler_account="),
  );
  broad = true;
  assert.ok(
    (await login()).result.headers.get("location").includes("auth_error="),
  );
  assert.equal(revocations.length, 1);
  f.config.githubAppClientId = "Iv1.selected-app";
  f.config.githubAppClientSecret = "selected-app-client-secret";
  broad = false;
  const current = await login();
  assert.equal(current.url.searchParams.get("client_id"), "Iv1.selected-app");
  assert.equal(current.url.searchParams.has("scope"), false);
});

test("installation callbacks require the browser, signed-in account and installation ownership, and app webhooks cannot cross installations", async (t) => {
  const f = await fixture(t),
    project = f.project(),
    cookie = `butler_account=${f.store.session(f.user.id)}`;
  Object.assign(f.config, {
    publicUrl: "http://127.0.0.1",
    secure: false,
    dataDir: f.directory,
    frontend: "/missing",
  });
  const connected = [];
  let registration = { id: f.config.githubAppId, slug: "butler-renamed" };
  const access = createGithubAccess(f.config, f.store, async (url) => {
    if (url === "https://api.github.com/app")
      return Response.json(registration);
    if (url.endsWith("/app/installations/99"))
      return Response.json(f.installation);
    return Response.json({ message: "Not found" }, { status: 404 });
  });
  const platform = createPlatform(f.config, {
    store: f.store,
    provisioner: {},
    provider: {
      ...access,
      connect: async (user, id) => {
        connected.push(user);
        return access.connect(user, id);
      },
    },
  });
  await new Promise((r) => platform.server.listen(0, "127.0.0.1", r));
  f.config.publicUrl = `http://127.0.0.1:${platform.server.address().port}`;
  t.after(() => new Promise((r) => platform.server.close(r)));
  const start = await fetch(f.config.publicUrl + "/auth/github/install", {
    headers: { cookie },
    redirect: "manual",
  });
  const url = new URL(start.headers.get("location")),
    browser = start.headers.get("set-cookie").split(";")[0];
  assert.equal(url.hostname, "github.com");
  assert.equal(url.pathname, "/apps/butler-renamed/installations/new");
  assert.equal(f.config.githubAppSlug, "butler-renamed");
  assert.equal(
    f.store.setting("provider-settings").githubAppSlug,
    "butler-renamed",
  );
  assert.equal(url.searchParams.get("suggested_target_id"), "42");
  registration = { id: "wrong-app", slug: "unrelated-app" };
  const wrong = await fetch(f.config.publicUrl + "/auth/github/install", {
    headers: { cookie },
    redirect: "manual",
  });
  assert.equal(wrong.status, 503);
  assert.equal(wrong.headers.get("location"), null);
  registration = { id: f.config.githubAppId, slug: "butler-renamed" };
  const callback =
    f.config.publicUrl +
    `/auth/github/install/callback?installation_id=99&state=${url.searchParams.get("state")}`;
  assert.equal(
    (await fetch(callback, { headers: { cookie }, redirect: "manual" })).status,
    400,
  );
  assert.equal(connected.length, 0);
  assert.equal(
    (
      await fetch(callback, {
        headers: { cookie: cookie + "; " + browser },
        redirect: "manual",
      })
    ).status,
    302,
  );
  assert.deepEqual(connected, [f.user.id]);
  const { createHmac } = await import("node:crypto");
  async function hook(
    installationId,
    secret = f.config.githubAppWebhookSecret,
  ) {
    const body = JSON.stringify({
      repository: { full_name: project.repo },
      installation: { id: installationId },
      ref: "refs/heads/main",
      after: "a".repeat(40),
    });
    return fetch(f.config.publicUrl + "/api/hooks/github-app", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-hub-signature-256":
          "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
      },
      body,
    });
  }
  assert.equal((await hook(100)).status, 403);
  assert.equal((await hook(99, "wrong-secret")).status, 403);
  assert.equal(f.store.all("SELECT * FROM tasks").length, 0);
  assert.equal((await hook(99)).status, 202);
  assert.equal(f.store.all("SELECT * FROM tasks").length, 1);
});
