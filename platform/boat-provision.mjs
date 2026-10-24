import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  writeFile,
  rm,
  cp,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { c as archive } from "tar";
import { setTimeout as delay } from "node:timers/promises";
import { now } from "./store.mjs";
const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
const root = "/home/user/butler",
  SHA = /^[a-f0-9]{40}$/;
const webDockerfile = `FROM node:22-bookworm-slim AS build
WORKDIR /build
ARG BUTLER_COMMIT_SHA=dev
ENV BUTLER_COMMIT_SHA=$BUTLER_COMMIT_SHA
COPY . .
RUN npm ci --no-audit --no-fund && npm run typecheck --if-present && npm run test --if-present && npm run build
FROM node:22-bookworm-slim
RUN npm install -g serve@14.2.5
COPY --from=build /build/dist /site
CMD ["serve","-s","/site","-l","tcp://0.0.0.0:3000"]
`;
export function createBoatProvisioner(
  config,
  store,
  provider,
  { source, markPublished, pause = delay, isStopped = () => false } = {},
) {
  const resources = (p) =>
    JSON.parse(
      store.get("SELECT resources FROM projects WHERE id=?", p.id).resources,
    );
  const save = (p, delta) =>
    store.run(
      "UPDATE projects SET resources=? WHERE id=?",
      JSON.stringify({ ...resources(p), ...delta }),
      p.id,
    );
  const api = (p, endpoint, method, body, extra) =>
    provider.boat(p.owner_id, endpoint, method, body, extra);
  async function ensure(p) {
    const saved = resources(p).boat;
    if (!saved?.id) return null;
    let value = await api(p, `/sandboxes/${saved.id}`);
    if (value.sandbox.state === "archived") {
      await api(p, `/sandboxes/${saved.id}/resume`, "POST", {
        noEnv: true,
        ttlSeconds: saved.ttlSeconds,
      });
    } else if (
      saved.ttlSeconds &&
      Date.parse(value.sandbox.archiveAfter) < Date.now() + 1800000
    )
      await api(p, `/sandboxes/${saved.id}`, "PATCH", {
        ttlSeconds: saved.ttlSeconds,
      });
    for (let i = 0; i < 120; i++) {
      if (isStopped())
        throw new Error(
          "Butler is restarting; the workspace will be checked again.",
        );
      if (["ready", "idle", "running"].includes(value.sandbox.state))
        return saved;
      if (["error", "cancelled"].includes(value.sandbox.state))
        throw new Error(
          "Boat could not start this workspace. Retry setup or check its Boat dashboard.",
        );
      await pause(2000);
      value = await api(p, `/sandboxes/${saved.id}`);
    }
    throw new Error(
      "Boat is still preparing the workspace. Butler will retry.",
    );
  }
  async function put(p, name, bytes) {
    const vm = resources(p).boat.id,
      remote = `${root}/${name}`;
    if (bytes.length <= 5 * 1024 * 1024)
      await api(p, `/sandboxes/${vm}/files`, "PUT", {
        path: remote,
        content: bytes.toString("base64"),
        encoding: "base64",
      });
    else {
      const target = await api(p, `/sandboxes/${vm}/files/upload-url`, "POST", {
        path: remote,
      });
      if (new URL(target.url).protocol !== "https:")
        throw new Error("Boat returned an invalid upload URL.");
      const response = await provider.request(target.url, {
        method: "PUT",
        body: bytes,
        signal: AbortSignal.timeout(120000),
      });
      if (!response.ok) throw new Error("Boat source upload was interrupted.");
    }
    return remote;
  }
  async function pack(directory, entries) {
    const dir = await mkdtemp(path.join(tmpdir(), "butler-boat-archive-"));
    try {
      const file = path.join(dir, "source.tgz");
      await archive({ gzip: true, cwd: directory, file }, entries || ["."]);
      return await readFile(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  async function job(p, key, script, container, image) {
    const vm = resources(p).boat.id;
    const hash = createHash("sha256").update(key).digest("hex").slice(0, 24),
      prefix = `${root}/jobs/${hash}`;
    const running = `test "$(sudo docker inspect -f '{{.State.Running}}' ${quote(container)} 2>/dev/null)" = true && test "$(sudo docker inspect -f '{{.Config.Image}}' ${quote(container)} 2>/dev/null)" = ${quote(image)}`;
    const jobScript = `#!/bin/bash\nset -euo pipefail\nmkdir -p ${quote(root + "/jobs")}\nexec 9>${quote(prefix + ".lock")}\nflock 9\nif test -f ${quote(prefix + ".done")} && ${running}; then exit 0; fi\n${script}\ntouch ${quote(prefix + ".done")}\n`;
    const remote = await put(p, `jobs/${hash}.sh`, Buffer.from(jobScript));
    // A persistent flock + completion marker make retries safe even if the start response is lost.
    const started = await api(p, `/sandboxes/${vm}/commands`, "POST", {
      command: `bash ${quote(remote)}`,
      detached: true,
    });
    if (!Number.isSafeInteger(started.processId))
      throw new Error("Boat did not return a build process ID.");
    for (let i = 0; i < 240; i++) {
      if (isStopped())
        throw new Error(
          "Butler is restarting; this saved build will be checked again.",
        );
      const status = await api(
        p,
        `/sandboxes/${vm}/commands/${started.processId}?tailBytes=2048`,
      );
      if (!status.running) {
        if (status.exitCode === 0) return;
        throw new Error(
          "The Boat build stopped before it passed. Its source and workspace are saved; inspect the build in Boat and retry.",
        );
      }
      await pause(3000);
    }
    throw new Error(
      "Boat is still building. Butler will check this saved build again.",
    );
  }
  async function host(p, port, title) {
    const value = await api(
      p,
      `/sandboxes/${resources(p).boat.id}/host`,
      "POST",
      { port, public: true, title },
    );
    const url = new URL(value.url);
    if (
      url.protocol !== "https:" ||
      !url.hostname.endsWith(".on.boat.dev") ||
      url.searchParams.has("_token")
    )
      throw new Error("Boat did not issue a public application URL.");
    return url.origin;
  }
  async function healthy(url) {
    for (let i = 0; i < 90; i++) {
      if (isStopped()) throw new Error("Butler is restarting.");
      try {
        const response = await provider.request(url, {
          signal: AbortSignal.timeout(10000),
        });
        if (response.ok) return;
      } catch {}
      await pause(2000);
    }
    throw new Error(
      "The Boat service has not passed its health check. Retry setup.",
    );
  }
  async function provision(p) {
    let saved = resources(p).boat;
    if (!saved?.id) {
      const connection = store.connection(p.owner_id, "boat");
      if (!connection?.environmentName)
        throw new Error("Connect Boat before starting the workspace.");
      const limits = await api(p, "/limits");
      const ttlSeconds =
        limits.accessTier === "trial" || connection.trial ? 7200 : null;
      const created = await api(
        p,
        "/sandboxes",
        "POST",
        {
          name: `Butler ${p.id}`,
          type: "default",
          ttlSeconds,
          noEnv: true,
          snapshots: true,
          environment: connection.environmentName,
          visibility: "private",
          env: { BUTLER_PROJECT_ID: p.id },
        },
        { headers: { "Idempotency-Key": `butler-project-${p.id}` } },
      );
      if (!/^bx_[a-z0-9]+$/.test(created.sandbox?.id || ""))
        throw new Error("Boat did not return a valid workspace ID.");
      saved = { id: created.sandbox.id, ttlSeconds };
      save(p, { boat: saved });
    }
    store.run(
      "UPDATE projects SET state='infrastructure',error=NULL WHERE id=?",
      p.id,
    );
    await ensure(p);
    const entries = (await readdir(config.workerDir))
      .filter(
        (name) =>
          [
            "Dockerfile",
            ".dockerignore",
            "package.json",
            "package-lock.json",
            "verdict.schema.json",
          ].includes(name) || /\.mjs$/.test(name),
      )
      .sort();
    const fingerprint = createHash("sha256");
    for (const entry of entries)
      fingerprint
        .update(entry)
        .update(await readFile(path.join(config.workerDir, entry)));
    const hash = fingerprint.digest("hex").slice(0, 24);
    const remote = await put(
      p,
      `uploads/worker-${hash}.tgz`,
      await pack(config.workerDir, entries),
    );
    await put(
      p,
      "worker.env",
      Buffer.from(
        `PORT=3000\nPLATFORM_URL=${config.publicUrl}\nPROJECT_ID=${p.id}\nWORKER_SECRET=${store.open(p.worker_secret)}\nREQUIRE_PERSISTENT_VOLUME=1\nIS_SANDBOX=1\n`,
      ),
    );
    await job(
      p,
      `worker:${hash}`,
      `sudo systemctl enable --now docker\nmkdir -p ${quote(root + "/data")} ${quote(root + "/worker-source")}\ntar -xzf ${quote(remote)} -C ${quote(root + "/worker-source")}\nsudo docker build -t butler-worker:${hash} ${quote(root + "/worker-source")}\nsudo docker rm -f butler-worker >/dev/null 2>&1 || true\nsudo docker run -d --restart unless-stopped --name butler-worker -p 3100:3000 --env-file ${quote(root + "/worker.env")} -v ${quote(root + "/data:/data")} butler-worker:${hash}`,
      "butler-worker",
      `butler-worker:${hash}`,
    );
    const workerUrl = await host(p, 3100, "Butler agent");
    await healthy(workerUrl + "/healthz");
    store.run(
      "UPDATE projects SET worker_url=?,state='deploying' WHERE id=?",
      workerUrl,
      p.id,
    );
    if (!resources(p).appDeployed) {
      await deploy(p, { sha: resources(p).initialSha });
      save(p, { appDeployed: true });
    }
    store.run("UPDATE projects SET state='ready',error=NULL WHERE id=?", p.id);
  }
  async function previewPort(p, number) {
    let saved = store.get(
      "SELECT * FROM previews WHERE project_id=? AND pr_number=?",
      p.id,
      number,
    );
    if (!saved) {
      store.run(
        "INSERT INTO previews(project_id,pr_number) VALUES(?,?)",
        p.id,
        number,
      );
      saved = {};
    }
    const used = new Set(
      store
        .all(
          "SELECT environment_id FROM previews WHERE project_id=? AND pr_number<>? AND state<>'closed'",
          p.id,
          number,
        )
        .map((row) => Number(row.environment_id?.slice(5))),
    );
    const previous = Number(saved.environment_id?.slice(5));
    const port =
      previous >= 4000 && previous < 4048 && !used.has(previous)
        ? previous
        : Array.from({ length: 48 }, (_, i) => 4000 + i).find(
            (port) => !used.has(port),
          );
    if (!port)
      throw new Error(
        "Close an older PR preview before creating another; Boat allows 50 hosted ports per workspace.",
      );
    store.run(
      "UPDATE previews SET environment_id=? WHERE project_id=? AND pr_number=?",
      `boat:${port}`,
      p.id,
      number,
    );
    return port;
  }
  async function deploy(p, { sha, prNumber }) {
    if (!SHA.test(sha)) throw new Error("Invalid deployment revision.");
    if (prNumber) {
      const pr = await provider.github(
        p.owner_id,
        `/repos/${p.repo}/pulls/${prNumber}`,
      );
      if (pr.state !== "open" || pr.head.sha !== sha) return;
    } else if (resources(p).appDeployed) {
      const main = await provider.github(
        p.owner_id,
        `/repos/${p.repo}/git/ref/heads/main`,
      );
      if (main.object.sha !== sha) {
        await markPublished(p, resources(p).deployedSha);
        return;
      }
    }
    if (!prNumber && resources(p).deployedSha === sha) {
      await markPublished(p, sha);
      return;
    }
    await ensure(p);
    const directory = await source(p, sha),
      staging = await mkdtemp(path.join(tmpdir(), "butler-boat-app-"));
    const port = prNumber ? await previewPort(p, prNumber) : 3000,
      name = prNumber ? `butler-preview-${prNumber}` : "butler-web";
    try {
      await cp(path.join(directory, "app"), staging, {
        recursive: true,
        filter: (file) =>
          !file
            .split(path.sep)
            .some(
              (part) =>
                part === "node_modules" ||
                part === ".git" ||
                part === ".railway" ||
                part === "dist" ||
                [
                  ".codex",
                  ".ssh",
                  ".boat",
                  "auth.json",
                  "master.key",
                  ".git-credentials",
                  ".netrc",
                ].includes(part) ||
                /\.(pem|key|p12|pfx|db|sqlite3?)(-|$)/.test(part) ||
                part.startsWith(".env"),
            ),
      });
      await writeFile(path.join(staging, "Dockerfile"), webDockerfile);
      await writeFile(
        path.join(staging, ".dockerignore"),
        "node_modules\ndist\n.git\n.env*\n.railway\n",
      );
      const remote = await put(
        p,
        `uploads/app-${sha}.tgz`,
        await pack(staging),
      );
      const appSource = `${root}/sources/${sha}`;
      await job(
        p,
        `app:${prNumber || "main"}:${sha}`,
        `mkdir -p ${quote(appSource)}\ntar -xzf ${quote(remote)} -C ${quote(appSource)}\nsudo docker build --build-arg BUTLER_COMMIT_SHA=${sha} -t butler-web:${sha} ${quote(appSource)}\nsudo docker rm -f ${quote(name)} >/dev/null 2>&1 || true\nsudo docker run -d --restart unless-stopped --name ${quote(name)} -p ${port}:3000 butler-web:${sha}`,
        name,
        `butler-web:${sha}`,
      );
      const url = await host(
        p,
        port,
        prNumber ? `PR #${prNumber}` : "Live app",
      );
      await healthy(url);
      if (prNumber) {
        store.run(
          "UPDATE previews SET state='ready',url=?,commit_sha=? WHERE project_id=? AND pr_number=?",
          url,
          sha,
          p.id,
          prNumber,
        );
        store.run(
          "UPDATE jobs SET preview_url=?,error=NULL,state=CASE WHEN state='preview_failed' THEN 'reviewing' ELSE state END WHERE project_id=? AND pr_number=?",
          url,
          p.id,
          prNumber,
        );
        const marker = `<!-- butler-preview:${prNumber}:${sha} -->`,
          comments = await provider.github(
            p.owner_id,
            `/repos/${p.repo}/issues/${prNumber}/comments?per_page=100`,
          );
        if (!comments.some((comment) => comment.body?.includes(marker)))
          await provider.github(
            p.owner_id,
            `/repos/${p.repo}/issues/${prNumber}/comments`,
            "POST",
            { body: `${marker}\nPreview ready: ${url}` },
          );
      } else {
        store.run("UPDATE projects SET app_url=? WHERE id=?", url, p.id);
        save(p, { deployedSha: sha });
        await markPublished(p, sha);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(staging, { recursive: true, force: true });
    }
  }
  async function cleanup(p, { prNumber }) {
    await ensure(p);
    const vm = resources(p).boat.id;
    await api(p, `/sandboxes/${vm}/commands`, "POST", {
      command: `sudo docker rm -f ${quote(`butler-preview-${prNumber}`)} >/dev/null 2>&1 || true`,
      timeoutSeconds: 30,
    });
    // Closed previews stop serving. Their ports may be reused without adding hosted URLs.
    store.run(
      "UPDATE previews SET state='closed',url=NULL,commit_sha=NULL WHERE project_id=? AND pr_number=?",
      p.id,
      prNumber,
    );
  }
  return { provision, deploy, cleanup, ensure };
}
