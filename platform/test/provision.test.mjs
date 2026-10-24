import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, cp, mkdir, writeFile } from "node:fs/promises";
import { c as archive } from "tar";
import { createStore, id, token, digest, now } from "../store.mjs";
import { createProvisioner } from "../provision.mjs";

test("provisioning retries reuse repository/services/volume and PR environments contain only the app", async (t) => {
  const directory = await mkdtemp("/tmp/butler-provision-"),
    store = createStore(directory);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const user = store.guest("Lead"),
    projectId = id(),
    invitation = token(),
    secret = token(),
    workspace = id();
  store.run("UPDATE users SET github_login=? WHERE id=?", "lead", user.id);
  store.connection(user.id, "railway", {
    access_token: "railway-credential-fixture",
  });
  store.run(
    "INSERT INTO projects(id,owner_id,name,description,slug,invite_hash,invite_secret,worker_secret,worker_hash,webhook_secret,workspace_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    projectId,
    user.id,
    "Our Site",
    "Build a team website",
    "our-site-test",
    digest(invitation),
    store.seal(invitation),
    store.seal(secret),
    digest(secret),
    store.seal(token()),
    workspace,
    now(),
  );
  const template = new URL("../template/", import.meta.url).pathname,
    tarball = directory + "/repo.tgz";
  const sourceFixture = directory + "/fixture";
  await cp(template, sourceFixture, { recursive: true });
  await mkdir(sourceFixture + "/app/.railway");
  await writeFile(
    sourceFixture + "/app/.railway/railway.ts",
    'throw new Error("Source-controlled IaC must never run on the platform");',
  );
  await archive(
    { gzip: true, cwd: sourceFixture, prefix: "repository", file: tarball },
    ["."],
  );
  const bytes = await readFile(tarball);
  const railwayProjects = [],
    services = [],
    domains = new Map(),
    volumes = [],
    environments = [],
    uploads = [];
  let repository = null,
    prSha = "e".repeat(40),
    hooks = [];
  const provider = {
    railwayToken: async () => "railway-credential-fixture",
    createRepository: async (project) => {
      repository ||= {
        full_name: "lead/butler-our-site-test",
        description: `Pocket Butler project ${project.id}`,
        default_branch: "main",
      };
      store.run(
        "UPDATE projects SET repo=? WHERE id=?",
        repository.full_name,
        project.id,
      );
      project.repo = repository.full_name;
      return repository;
    },
    github: async (_user, url, method = "GET", body, raw) => {
      if (raw) return new Response(bytes);
      if (url === "/user/repos") {
        repository = {
          full_name: "lead/butler-our-site-test",
          description: body.description,
          default_branch: "main",
        };
        return repository;
      }
      if (url === "/repos/lead/butler-our-site-test") {
        if (!repository) {
          const error = new Error("Not found");
          error.status = 404;
          throw error;
        }
        return repository;
      }
      if (url.endsWith("/git/ref/heads/main"))
        return { object: { sha: "a".repeat(40) } };
      if (url.endsWith("/git/blobs")) return { sha: "b".repeat(40) };
      if (url.endsWith("/git/trees")) return { sha: "c".repeat(40) };
      if (url.endsWith("/git/commits")) return { sha: "d".repeat(40) };
      if (url.endsWith("/hooks")) {
        if (method === "POST") {
          hooks.push(body);
          return { id: 1 };
        }
        return hooks;
      }
      if (url.endsWith("/pulls/7"))
        return { state: "open", head: { sha: prSha } };
      if (url.includes("/comments")) return method === "GET" ? [] : { id: 1 };
      if (method === "PATCH" || url.endsWith("/protection")) return {};
      throw new Error("Unexpected GitHub fixture operation " + url);
    },
    railway: async (_user, query, vars) => {
      if (query.includes("projects(workspaceId"))
        return {
          projects: {
            edges: railwayProjects.map((node) => ({ node })),
            pageInfo: { hasNextPage: false },
          },
        };
      if (query.includes("projectCreate(")) {
        const value = {
          id: id(),
          name: vars.input.name,
          environments: { edges: [{ node: { id: id(), name: "production" } }] },
        };
        railwayProjects.push(value);
        return { projectCreate: value };
      }
      if (query.includes("serviceCreate(")) {
        const value = {
          id: id(),
          name: vars.input.name,
          projectId: vars.input.projectId,
        };
        services.push(value);
        return { serviceCreate: value };
      }
      if (query.includes("volumeInstances"))
        return {
          environment: {
            volumeInstances: { edges: volumes.map((node) => ({ node })) },
          },
        };
      if (query.includes("volumeCreate(")) {
        const value = {
          id: id(),
          volumeId: id(),
          serviceId: vars.input.serviceId,
          mountPath: "/data",
        };
        volumes.push(value);
        return { volumeCreate: value };
      }
      if (query.includes("serviceInstanceUpdate")) {
        assert.equal(vars.input.numReplicas, 1);
        assert.equal(vars.input.sleepApplication, false);
        return { serviceInstanceUpdate: true };
      }
      if (query.includes("serviceDomainCreate(")) {
        const value = {
          id: id(),
          domain: `site-${vars.input.environmentId.slice(0, 8)}.up.railway.app`,
        };
        domains.set(vars.input.environmentId, value);
        return { serviceDomainCreate: value };
      }
      if (query.includes("serviceInstance("))
        return {
          serviceInstance: {
            domains: {
              serviceDomains: domains.has(vars.e) ? [domains.get(vars.e)] : [],
            },
          },
        };
      if (query.includes("variableCollectionUpsert(")) {
        assert.equal(vars.input.variables.OPENAI_API_KEY, undefined);
        return { variableCollectionUpsert: true };
      }
      if (query.includes("deployment(id:"))
        return { deployment: { status: "SUCCESS" } };
      if (query.includes("environmentCreate(")) {
        environments.push(vars.input);
        return { environmentCreate: { id: id() } };
      }
      if (query.includes("services{"))
        return {
          project: {
            services: {
              edges: services
                .filter((s) => s.projectId === vars.id)
                .map((node) => ({ node })),
            },
          },
        };
      if (query.includes("environments{")) {
        const p = railwayProjects.find((p) => p.id === vars.id);
        return { project: { environments: p.environments } };
      }
      throw new Error("Unexpected Railway fixture operation " + query);
    },
  };
  const config = {
    publicUrl: "https://butler.example.test",
    dataDir: directory,
    templateDir: template,
    workerDir: new URL("../../project-worker/", import.meta.url).pathname,
  };
  const provisioner = createProvisioner(config, store, provider, {
    pause: async () => {},
    execute: async (_file, args, options) => {
      assert.equal(options.env.RAILWAY_API_TOKEN, "railway-credential-fixture");
      assert.equal(options.env.GH_TOKEN, undefined);
      assert.equal(options.env.OPENAI_API_KEY, undefined);
      uploads.push(args.at(-1));
      if (!args.at(-1).endsWith("project-worker/"))
        await assert.rejects(readFile(args.at(-1) + "/.railway/railway.ts"), {
          code: "ENOENT",
        });
      assert.equal(options.cwd, directory);
      if (!args.at(-1).endsWith("project-worker/"))
        assert.ok(
          (await readFile(args.at(-1) + "/package.json", "utf8")).includes(
            "vite",
          ),
        );
      return {
        stdout: `Build Logs: https://railway.com/project/test?id=${id()}`,
        stderr: "",
      };
    },
  });
  await provisioner.provision(
    store.get("SELECT * FROM projects WHERE id=?", projectId),
  );
  await provisioner.provision(
    store.get("SELECT * FROM projects WHERE id=?", projectId),
  );
  const project = store.get("SELECT * FROM projects WHERE id=?", projectId),
    resources = JSON.parse(project.resources);
  assert.equal(project.state, "ready");
  assert.equal(railwayProjects.length, 2);
  assert.equal(services.length, 2);
  assert.equal(volumes.length, 1);
  assert.equal(uploads.length, 2);
  assert.notEqual(resources.app.project, resources.agents.project);
  assert.equal(hooks.length, 0);
  await provisioner.deploy(project, { sha: prSha, prNumber: 7 });
  assert.equal(environments.length, 1);
  assert.equal(environments[0].projectId, resources.app.project);
  assert.equal(environments[0].sourceEnvironmentId, resources.app.environment);
  assert.notEqual(environments[0].projectId, resources.agents.project);
  const preview = store.get(
    "SELECT * FROM previews WHERE project_id=? AND pr_number=7",
    projectId,
  );
  assert.equal(preview.state, "ready");
  assert.equal(preview.commit_sha, prSha);
});
