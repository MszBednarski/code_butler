import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  readdir,
  readFile,
  mkdtemp,
  writeFile,
  rm,
  cp,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { x as extract } from "tar";
import { setTimeout as delay } from "node:timers/promises";
import { now } from "./store.mjs";
import { createBoatProvisioner } from "./boat-provision.mjs";

const exec = promisify(execFile);
const ENVIRONMENTS = "environments{edges{node{id name}}}";
const SHA = /^[a-f0-9]{40}$/;

async function files(root, directory = root) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(root, file)));
    else if (entry.isFile())
      result.push({
        path: path.relative(root, file).split(path.sep).join("/"),
        data: await readFile(file),
      });
  }
  return result;
}

export function createProvisioner(
  config,
  store,
  provider,
  { execute = exec, pause = delay } = {},
) {
  let stopped = false,
    active = false;
  const boat = createBoatProvisioner(config, store, provider, {
    source,
    markPublished,
    pause,
    isStopped: () => stopped,
  });
  function resources(project) {
    return JSON.parse(
      store.get("SELECT resources FROM projects WHERE id=?", project.id)
        .resources,
    );
  }
  function save(project, changes) {
    const value = { ...resources(project), ...changes };
    store.run(
      "UPDATE projects SET resources=? WHERE id=?",
      JSON.stringify(value),
      project.id,
    );
    return value;
  }
  const state = (project, value) =>
    store.run(
      "UPDATE projects SET state=?,error=NULL WHERE id=?",
      value,
      project.id,
    );
  async function repo(project) {
    const found = await provider.createRepository(project);
    if (resources(project).seeded) return;
    if (found.default_branch !== "main") {
      try {
        const original = await provider.github(
          project.owner_id,
          `/repos/${found.full_name}/git/ref/heads/${encodeURIComponent(found.default_branch)}`,
        );
        await provider.github(
          project.owner_id,
          `/repos/${found.full_name}/git/refs`,
          "POST",
          { ref: "refs/heads/main", sha: original.object.sha },
        );
      } catch (error) {
        if (error.status !== 422) throw error;
      }
    }
    const base = await provider.github(
      project.owner_id,
      `/repos/${found.full_name}/git/ref/heads/main`,
    );
    const entries = [];
    for (const entry of await files(config.templateDir)) {
      const data =
        entry.path === "app/src/main.tsx"
          ? Buffer.from(
              entry.data
                .toString()
                .replaceAll(
                  "__PROJECT_NAME__",
                  JSON.stringify(project.name).slice(1, -1),
                ),
            )
          : entry.data;
      const blob = await provider.github(
        project.owner_id,
        `/repos/${found.full_name}/git/blobs`,
        "POST",
        { content: data.toString("base64"), encoding: "base64" },
      );
      entries.push({
        path: entry.path,
        mode: "100644",
        type: "blob",
        sha: blob.sha,
      });
    }
    const tree = await provider.github(
      project.owner_id,
      `/repos/${found.full_name}/git/trees`,
      "POST",
      { tree: entries },
    );
    const commit = await provider.github(
      project.owner_id,
      `/repos/${found.full_name}/git/commits`,
      "POST",
      {
        message: "Create a Pocket Butler team project",
        tree: tree.sha,
        parents: [base.object.sha],
      },
    );
    await provider.github(
      project.owner_id,
      `/repos/${found.full_name}/git/refs/heads/main`,
      "PATCH",
      { sha: commit.sha },
    );
    save(project, { seeded: true, initialSha: commit.sha });
    // Validation is enforced by the controller; repository administration is not granted.
    save(project, { protectedMain: false });
  }

  async function projectResource(project, kind) {
    let value = resources(project)[kind];
    if (value) return value;
    const name = `butler-${project.slug}-${kind}`;
    let found, cursor;
    do {
      const data = await provider.railway(
        project.owner_id,
        `query($workspace:String!,$after:String){projects(workspaceId:$workspace,first:100,after:$after){edges{node{id name ${ENVIRONMENTS}}} pageInfo{hasNextPage endCursor}}}`,
        { workspace: project.workspace_id, after: cursor || null },
      );
      found = data.projects.edges.find((x) => x.node.name === name)?.node;
      cursor =
        !found && data.projects.pageInfo.hasNextPage
          ? data.projects.pageInfo.endCursor
          : null;
    } while (cursor);
    if (!found)
      found = (
        await provider.railway(
          project.owner_id,
          `mutation($input:ProjectCreateInput!){projectCreate(input:$input){id ${ENVIRONMENTS}}}`,
          {
            input: {
              name,
              workspaceId: project.workspace_id,
              defaultEnvironmentName: "production",
              prDeploys: false,
              description: `Pocket Butler ${project.id} ${kind}`,
            },
          },
        )
      ).projectCreate;
    const env =
      found.environments.edges.find((e) => e.node.name === "production")
        ?.node || found.environments.edges[0]?.node;
    if (!env)
      throw new Error(
        "Railway has not created the production environment yet.",
      );
    value = { project: found.id, environment: env.id };
    save(project, { [kind]: value });
    return value;
  }
  async function serviceResource(project, kind) {
    let value = await projectResource(project, kind);
    if (!value.service) {
      const existing = await provider.railway(
        project.owner_id,
        "query($id:String!){project(id:$id){services{edges{node{id name}}}}}",
        { id: value.project },
      );
      const service =
        existing.project.services.edges.find(
          (e) => e.node.name === (kind === "agents" ? "agents" : "web"),
        )?.node ||
        (
          await provider.railway(
            project.owner_id,
            "mutation($input:ServiceCreateInput!){serviceCreate(input:$input){id}}",
            {
              input: {
                projectId: value.project,
                name: kind === "agents" ? "agents" : "web",
              },
            },
          )
        ).serviceCreate;
      value = { ...value, service: service.id };
      save(project, { [kind]: value });
    }
    await provider.railway(
      project.owner_id,
      "mutation($e:String!,$s:String!,$input:ServiceInstanceUpdateInput!){serviceInstanceUpdate(environmentId:$e,serviceId:$s,input:$input)}",
      {
        e: value.environment,
        s: value.service,
        input: {
          healthcheckPath: kind === "agents" ? "/healthz" : "/",
          restartPolicyType: "ALWAYS",
          numReplicas: 1,
          sleepApplication: false,
        },
      },
    );
    if (!value.domain) {
      const instance = await provider.railway(
        project.owner_id,
        "query($e:String!,$s:String!){serviceInstance(environmentId:$e,serviceId:$s){domains{serviceDomains{id domain}}}}",
        { e: value.environment, s: value.service },
      );
      const domain =
        instance.serviceInstance.domains.serviceDomains[0] ||
        (
          await provider.railway(
            project.owner_id,
            "mutation($input:ServiceDomainCreateInput!){serviceDomainCreate(input:$input){id domain}}",
            {
              input: {
                environmentId: value.environment,
                serviceId: value.service,
                targetPort: 3000,
              },
            },
          )
        ).serviceDomainCreate;
      value = { ...value, domain: `https://${domain.domain}` };
      save(project, { [kind]: value });
    }
    return value;
  }
  async function variables(project, resource, values) {
    await provider.railway(
      project.owner_id,
      "mutation($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}",
      {
        input: {
          projectId: resource.project,
          environmentId: resource.environment,
          serviceId: resource.service,
          skipDeploys: true,
          variables: values,
        },
      },
    );
  }
  async function upload(project, resource, directory) {
    const credential = await provider.railwayToken(project.owner_id);
    const env = {
      PATH: process.env.PATH,
      HOME: config.dataDir,
      TMPDIR: tmpdir(),
      CI: "1",
      NO_COLOR: "1",
      RAILWAY_API_TOKEN: credential,
    };
    const output = await execute(
      "railway",
      [
        "up",
        "--project",
        resource.project,
        "--service",
        resource.service,
        "--environment",
        resource.environment,
        "--detach",
        "--path-as-root",
        directory,
      ],
      {
        env,
        cwd: config.dataDir,
        timeout: 240000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    const deployment = `${output.stdout}\n${output.stderr}`.match(
      /[?&]id=([a-f0-9-]{36})/i,
    )?.[1];
    if (!deployment)
      throw new Error(
        "Railway upload did not return a deployment ID. Retry setup.",
      );
    return deployment;
  }
  async function wait(project, deployment) {
    for (let attempt = 0; attempt < 180; attempt++) {
      if (stopped)
        throw new Error(
          "Butler is restarting; the deployment will be checked again.",
        );
      const result = await provider.railway(
        project.owner_id,
        "query($id:String!){deployment(id:$id){status}}",
        { id: deployment },
      );
      if (result.deployment.status === "SUCCESS") return;
      if (
        ["FAILED", "CRASHED", "CANCELED", "CANCELLED", "REMOVED"].includes(
          result.deployment.status,
        )
      ) {
        const error = new Error(
          "Railway could not deploy this build. Check the Railway deployment log and retry.",
        );
        error.failedDeployment = deployment;
        throw error;
      }
      await pause(5000);
    }
    throw new Error(
      "Railway is still building. Butler will check again automatically.",
    );
  }
  async function provision(project) {
    if (project.hosting_provider === "boat") {
      state(project, "repository");
      await repo(project);
      return boat.provision(project);
    }
    if (!store.connection(project.owner_id, "railway"))
      throw new Error("Connect Railway to prepare this project.");
    if (!project.workspace_id) {
      const me = await provider.railway(
        project.owner_id,
        "query{me{workspaces{id name}}}",
      );
      if (!me.me.workspaces[0])
        throw new Error("Authorize a Railway workspace to continue.");
      project.workspace_id = me.me.workspaces[0].id;
      store.run(
        "UPDATE projects SET workspace_id=? WHERE id=?",
        project.workspace_id,
        project.id,
      );
    }
    state(project, "repository");
    await repo(project);
    state(project, "infrastructure");
    const agents = await serviceResource(project, "agents");
    store.run(
      "UPDATE projects SET worker_url=? WHERE id=?",
      agents.domain,
      project.id,
    );
    if (!resources(project).volume) {
      const existing = await provider.railway(
        project.owner_id,
        "query($id:String!){environment(id:$id){volumeInstances{edges{node{volumeId serviceId mountPath}}}}}",
        { id: agents.environment },
      );
      const volume = existing.environment.volumeInstances.edges.find(
        (e) =>
          e.node.serviceId === agents.service && e.node.mountPath === "/data",
      )?.node;
      const result = volume
        ? { volumeCreate: { id: volume.volumeId } }
        : await provider.railway(
            project.owner_id,
            "mutation($input:VolumeCreateInput!){volumeCreate(input:$input){id}}",
            {
              input: {
                projectId: agents.project,
                environmentId: agents.environment,
                serviceId: agents.service,
                mountPath: "/data",
              },
            },
          );
      save(project, { volume: result.volumeCreate.id });
    }
    await variables(project, agents, {
      PORT: "3000",
      PLATFORM_URL: config.publicUrl,
      PROJECT_ID: project.id,
      WORKER_SECRET: store.open(project.worker_secret),
      REQUIRE_PERSISTENT_VOLUME: "1",
      IS_SANDBOX: "1",
    });
    const app = await serviceResource(project, "app");
    store.run(
      "UPDATE projects SET app_url=? WHERE id=?",
      app.domain,
      project.id,
    );
    await variables(project, app, { PORT: "3000" });
    state(project, "deploying");
    let workerDeployment = resources(project).workerDeployment;
    if (!workerDeployment) {
      workerDeployment = await upload(project, agents, config.workerDir);
      save(project, { workerDeployment });
    }
    await wait(project, workerDeployment);
    if (!resources(project).appDeployed) {
      await deploy(project, { sha: resources(project).initialSha });
      save(project, { appDeployed: true });
    }
    // Events arrive through the GitHub App webhook, without repository hook/admin permissions.
    state(project, "ready");
  }
  async function source(project, sha) {
    if (!SHA.test(sha)) throw new Error("Invalid deployment revision.");
    const response = await provider.github(
      project.owner_id,
      `/repos/${project.repo}/tarball/${sha}`,
      "GET",
      undefined,
      true,
    );
    const directory = await mkdtemp(path.join(tmpdir(), "butler-source-"));
    try {
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 32 * 1024 * 1024)
        throw new Error("Project archive is too large.");
      const archive = path.join(directory, "source.tgz");
      await writeFile(archive, bytes, { mode: 0o600 });
      await extract({
        file: archive,
        cwd: directory,
        strip: 1,
        strict: true,
        preservePaths: false,
        filter: (_entry, item) =>
          ![
            "SymbolicLink",
            "Link",
            "CharacterDevice",
            "BlockDevice",
            "FIFO",
          ].includes(item.type),
      });
      return directory;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  async function previewResource(project, number) {
    const app = resources(project).app;
    let saved = store.get(
      "SELECT * FROM previews WHERE project_id=? AND pr_number=?",
      project.id,
      number,
    );
    if (!saved) {
      store.run(
        "INSERT INTO previews(project_id,pr_number) VALUES(?,?)",
        project.id,
        number,
      );
      saved = store.get(
        "SELECT * FROM previews WHERE project_id=? AND pr_number=?",
        project.id,
        number,
      );
    }
    if (!saved.environment_id) {
      const envs = await provider.railway(
        project.owner_id,
        `query($id:String!){project(id:$id){${ENVIRONMENTS}}}`,
        { id: app.project },
      );
      const env =
        envs.project.environments.edges.find(
          (e) => e.node.name === `pr-${number}`,
        )?.node ||
        (
          await provider.railway(
            project.owner_id,
            "mutation($input:EnvironmentCreateInput!){environmentCreate(input:$input){id}}",
            {
              input: {
                projectId: app.project,
                name: `pr-${number}`,
                sourceEnvironmentId: app.environment,
                skipInitialDeploys: true,
              },
            },
          )
        ).environmentCreate;
      store.run(
        "UPDATE previews SET environment_id=? WHERE project_id=? AND pr_number=?",
        env.id,
        project.id,
        number,
      );
      saved.environment_id = env.id;
    }
    if (!saved.url) {
      const instance = await provider.railway(
        project.owner_id,
        "query($e:String!,$s:String!){serviceInstance(environmentId:$e,serviceId:$s){domains{serviceDomains{domain}}}}",
        { e: saved.environment_id, s: app.service },
      );
      const domain =
        instance.serviceInstance.domains.serviceDomains[0] ||
        (
          await provider.railway(
            project.owner_id,
            "mutation($input:ServiceDomainCreateInput!){serviceDomainCreate(input:$input){domain}}",
            {
              input: {
                environmentId: saved.environment_id,
                serviceId: app.service,
                targetPort: 3000,
              },
            },
          )
        ).serviceDomainCreate;
      saved.url = `https://${domain.domain}`;
      store.run(
        "UPDATE previews SET url=? WHERE project_id=? AND pr_number=?",
        saved.url,
        project.id,
        number,
      );
    }
    return { ...app, environment: saved.environment_id, domain: saved.url };
  }
  async function markPublished(project, sha) {
    if (!SHA.test(sha || "")) return;
    for (const job of store.all(
      "SELECT id,merge_sha FROM jobs WHERE project_id=? AND state IN ('deploying','publish_failed')",
      project.id,
    )) {
      if (!job.merge_sha) continue;
      const comparison = await provider.github(
        project.owner_id,
        `/repos/${project.repo}/compare/${job.merge_sha}...${sha}`,
      );
      if (["ahead", "identical"].includes(comparison.status))
        store.run(
          "UPDATE jobs SET state='live',error=NULL,updated_at=? WHERE id=?",
          now(),
          job.id,
        );
    }
  }
  async function deploy(project, payload) {
    if (project.hosting_provider === "boat")
      return boat.deploy(project, payload);
    const { sha, prNumber } = payload;
    if (!SHA.test(sha)) throw new Error("Invalid deployment revision.");
    const app = resources(project).app;
    if (!app) throw new Error("Project hosting is still being prepared.");
    if (!prNumber && resources(project).deployedSha === sha) {
      await markPublished(project, sha);
      return;
    }
    if (prNumber) {
      const pr = await provider.github(
        project.owner_id,
        `/repos/${project.repo}/pulls/${prNumber}`,
      );
      if (pr.state !== "open" || pr.head.sha !== sha) return;
    } else if (resources(project).appDeployed) {
      const main = await provider.github(
        project.owner_id,
        `/repos/${project.repo}/git/ref/heads/main`,
      );
      if (main.object.sha !== sha) {
        await markPublished(project, resources(project).deployedSha);
        return;
      }
    }
    const target = prNumber ? await previewResource(project, prNumber) : app;
    const repository = await source(project, sha);
    const directory = await mkdtemp(path.join(tmpdir(), "butler-upload-"));
    try {
      // Source-controlled IaC must never execute in the credentialed platform
      // process. Only a clean app snapshot is passed to the Railway uploader.
      const excluded = new Set([
        ".railway",
        "railway.ts",
        "railway.json",
        "railway.toml",
        "railway.config.ts",
        "railway.config.js",
        ".railwayignore",
        "Dockerfile",
        ".git",
        "node_modules",
      ]);
      await cp(path.join(repository, "app"), directory, {
        recursive: true,
        filter: (file) =>
          !excluded.has(path.basename(file)) &&
          !path.basename(file).startsWith(".env"),
      });
      await writeFile(
        path.join(directory, "railway.json"),
        JSON.stringify({
          build: { builder: "RAILPACK" },
          deploy: {
            startCommand: "npm start",
            healthcheckPath: "/",
            restartPolicyType: "ALWAYS",
          },
        }),
      );
      await variables(project, target, {
        BUTLER_COMMIT_SHA: sha,
        PORT: "3000",
      });
      await wait(project, await upload(project, target, directory));
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(repository, { recursive: true, force: true });
    }
    if (prNumber) {
      store.run(
        "UPDATE previews SET state='ready',commit_sha=? WHERE project_id=? AND pr_number=?",
        sha,
        project.id,
        prNumber,
      );
      store.run(
        "UPDATE jobs SET preview_url=?,error=CASE WHEN state='preview_failed' THEN NULL ELSE error END,state=CASE WHEN state='preview_failed' THEN 'reviewing' ELSE state END,updated_at=? WHERE project_id=? AND pr_number=?",
        target.domain,
        now(),
        project.id,
        prNumber,
      );
      const marker = `<!-- butler-preview:${sha} -->`;
      const comments = await provider.github(
        project.owner_id,
        `/repos/${project.repo}/issues/${prNumber}/comments?per_page=100`,
      );
      if (!comments.some((comment) => comment.body?.includes(marker)))
        await provider.github(
          project.owner_id,
          `/repos/${project.repo}/issues/${prNumber}/comments`,
          "POST",
          {
            body: `${marker}\nPreview ready: ${target.domain}`,
          },
        );
    } else {
      save(project, { deployedSha: sha });
      await markPublished(project, sha);
    }
  }
  async function cleanup(project, { prNumber }) {
    if (project.hosting_provider === "boat")
      return boat.cleanup(project, { prNumber });
    const preview = store.get(
      "SELECT * FROM previews WHERE project_id=? AND pr_number=?",
      project.id,
      prNumber,
    );
    if (preview?.environment_id)
      await provider.railway(
        project.owner_id,
        "mutation($id:String!){environmentDelete(id:$id)}",
        { id: preview.environment_id },
      );
    store.run(
      "DELETE FROM previews WHERE project_id=? AND pr_number=?",
      project.id,
      prNumber,
    );
  }
  async function tick() {
    if (active || stopped) return;
    active = true;
    try {
      const task = store.transaction(() => {
        const found = store.get(
          "SELECT * FROM tasks WHERE state='queued' AND available_at<=? ORDER BY available_at LIMIT 1",
          now(),
        );
        if (found)
          store.run(
            "UPDATE tasks SET state='running',updated_at=? WHERE id=?",
            now(),
            found.id,
          );
        return found;
      });
      if (!task) return;
      const project = store.get(
        "SELECT * FROM projects WHERE id=?",
        task.project_id,
      );
      try {
        if (task.kind === "provision") await provision(project);
        else if (task.kind === "deploy")
          await deploy(project, JSON.parse(task.payload));
        else if (task.kind === "cleanup")
          await cleanup(project, JSON.parse(task.payload));
        else if (task.kind === "boat-wake") await boat.ensure(project);
        else throw new Error("Unknown background task");
        store.run(
          "UPDATE tasks SET state='done',error=NULL,updated_at=? WHERE id=?",
          now(),
          task.id,
        );
      } catch (error) {
        const message = error.message.slice(0, 350);
        if (
          error.failedDeployment &&
          resources(project).workerDeployment === error.failedDeployment
        )
          save(project, { workerDeployment: null });
        const attempts = task.attempts + 1;
        store.run(
          "UPDATE tasks SET state=?,error=?,attempts=?,available_at=?,updated_at=? WHERE id=?",
          attempts < 5 ? "queued" : "failed",
          message,
          attempts,
          now() + Math.min(300000, 15000 * 2 ** attempts),
          now(),
          task.id,
        );
        if (task.kind === "provision")
          store.run(
            "UPDATE projects SET state=?,error=? WHERE id=?",
            attempts < 5 ? "retrying" : "failed",
            message,
            project.id,
          );
        if (task.kind === "deploy" && attempts >= 5) {
          const payload = JSON.parse(task.payload);
          if (payload.prNumber) {
            store.run(
              "UPDATE previews SET state='failed' WHERE project_id=? AND pr_number=?",
              project.id,
              payload.prNumber,
            );
            store.run(
              "UPDATE jobs SET state='preview_failed',error=?,updated_at=? WHERE project_id=? AND pr_number=? AND state IN ('reviewing','preview_failed')",
              message,
              now(),
              project.id,
              payload.prNumber,
            );
          } else
            store.run(
              "UPDATE jobs SET state='publish_failed',error=?,updated_at=? WHERE project_id=? AND state='deploying'",
              message,
              now(),
              project.id,
            );
        }
        console.error(`[tasks] ${task.kind} ${project.id}: ${error.name}`);
      }
    } finally {
      active = false;
    }
  }
  return {
    tick,
    provision,
    deploy,
    start() {
      store.run("UPDATE tasks SET state='queued' WHERE state='running'");
      const timer = setInterval(
        () => tick().catch((error) => console.error(`[tasks] ${error.name}`)),
        2000,
      );
      tick().catch((error) => console.error(`[tasks] ${error.name}`));
      return () => {
        stopped = true;
        clearInterval(timer);
      };
    },
  };
}
