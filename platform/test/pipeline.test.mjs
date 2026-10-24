import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, cp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore, id, token, digest, now } from "../store.mjs";
import { createPlatform } from "../server.mjs";
import { createAgent } from "../../project-worker/agent.mjs";
import { createReviewer } from "../../project-worker/reviewer.mjs";
const exec = promisify(execFile);

test("real git transport and app builds carry a teammate request through PR review and merge without provider credentials in the worker", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "butler-pipeline-")),
    remoteRoot = path.join(dir, "remote"),
    bare = path.join(remoteRoot, "team/project.git"),
    seed = path.join(dir, "seed"),
    data = path.join(dir, "worker");
  const git = async (args, cwd = seed) =>
    (await exec("git", args, { cwd })).stdout.trim();
  await mkdir(path.dirname(bare), { recursive: true });
  await exec("git", ["init", "--bare", "--initial-branch=main", bare]);
  await exec("git", ["--git-dir", bare, "config", "http.receivepack", "true"]);
  await cp(new URL("../template/", import.meta.url), seed, { recursive: true });
  await git(["init", "--initial-branch=main"]);
  await git(["config", "user.name", "Test"]);
  await git(["config", "user.email", "test@example.test"]);
  await git(["add", "."]);
  await git(["commit", "-m", "Initial website"]);
  await git(["remote", "add", "origin", bare]);
  await git(["push", "origin", "main"]);
  let authorizedGitRequests = 0;
  const upstream = createServer((req, res) => {
    if (
      req.headers.authorization !==
      `Basic ${Buffer.from("x-access-token:owner-github-fixture").toString("base64")}`
    ) {
      res.writeHead(401);
      res.end();
      return;
    }
    authorizedGitRequests++;
    const url = new URL(req.url, "http://localhost"),
      child = spawn("git", ["http-backend"], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: remoteRoot,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: req.method,
          CONTENT_TYPE: req.headers["content-type"] || "",
          CONTENT_LENGTH: req.headers["content-length"] || "",
          REMOTE_USER: "butler",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
    let header = Buffer.alloc(0),
      sent = false;
    child.stdout.on("data", (chunk) => {
      if (sent) {
        res.write(chunk);
        return;
      }
      header = Buffer.concat([header, chunk]);
      const at = header.indexOf("\r\n\r\n");
      if (at < 0) return;
      const values = {};
      let status = 200;
      for (const line of header.subarray(0, at).toString().split("\r\n")) {
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        const key = line.slice(0, colon),
          value = line.slice(colon + 1).trim();
        if (key === "Status") status = Number(value.split(" ")[0]);
        else values[key] = value;
      }
      res.writeHead(status, values);
      sent = true;
      res.write(header.subarray(at + 4));
      header = Buffer.alloc(0);
    });
    child.stderr.resume();
    child.on("close", () => res.end());
    child.on("error", () => {
      res.statusCode = 500;
      res.end();
    });
    req.pipe(child.stdin);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const store = createStore(path.join(dir, "platform")),
    lead = store.guest("Lead");
  store.run(
    "UPDATE users SET github_id=?,github_login=? WHERE id=?",
    "42",
    "team",
    lead.id,
  );
  store.connection(lead.id, "github", {
    access_token: "owner-github-fixture",
    scope: "repo",
  });
  store.connection(lead.id, "railway", {
    access_token: "owner-railway-fixture",
  });
  let pr = null,
    statuses = [];
  const sha = async (ref) =>
    (await exec("git", ["--git-dir", bare, "rev-parse", ref])).stdout.trim();
  const currentPull = async () =>
    pr ? { ...pr, head: { ...pr.head, sha: await sha(pr.head.ref) } } : null;
  const provider = {
    github: async (_user, endpoint, method = "GET", body) => {
      const suffix = endpoint.replace("/repos/team/project", "");
      if (suffix === "/git/ref/heads/main")
        return { object: { sha: await sha("main") } };
      if (suffix.startsWith("/pulls?"))
        return pr?.state === "open" ? [await currentPull()] : [];
      if (suffix === "/pulls" && method === "POST") {
        pr = {
          number: 1,
          state: "open",
          draft: false,
          labels: [],
          user: { login: "team" },
          title: body.title,
          body: body.body,
          head: { ref: body.head, repo: { full_name: "team/project" } },
          base: { ref: "main", repo: { full_name: "team/project" } },
        };
        return currentPull();
      }
      if (suffix === "/pulls/1") return currentPull();
      if (suffix.startsWith("/pulls/1/reviews"))
        return method === "POST" ? { id: 1 } : [];
      if (suffix.startsWith("/statuses/")) {
        statuses = [{ context: body.context, state: body.state }];
        return {};
      }
      if (suffix.includes("/check-runs")) return { check_runs: [] };
      if (suffix.match(/\/commits\/[^/]+\/status/)) return { statuses };
      if (suffix === "/pulls/1/merge") {
        await git(["fetch", "origin"]);
        await git(["switch", "main"]);
        await git(["merge", "--squash", body.sha]);
        await git(["commit", "-m", "Publish teammate change"]);
        await git(["push", "origin", "main"]);
        pr.state = "closed";
        pr.merged = true;
        pr.merge_commit_sha = await sha("main");
        throw new Error(
          "Simulated lost response after GitHub completed the merge",
        );
      }
      throw new Error(`Unexpected mocked GitHub endpoint ${method} ${suffix}`);
    },
    worker: async () => ({ state: "connected" }),
  };
  const config = {
    publicUrl: "http://127.0.0.1",
    secure: false,
    frontend: "/missing",
    dataDir: path.join(dir, "platform"),
    commit: "test",
  };
  const platform = createPlatform(config, {
    store,
    provider,
    provisioner: {},
    gitOptions: { upstream: `http://127.0.0.1:${upstream.address().port}` },
  });
  await new Promise((resolve) =>
    platform.server.listen(0, "127.0.0.1", resolve),
  );
  config.publicUrl = `http://127.0.0.1:${platform.server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => platform.server.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const call = async (url, body, cookie = "") =>
    fetch(config.publicUrl + url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin: config.publicUrl,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const owner = `butler_account=${store.session(lead.id)}`;
  const created = await (
      await call(
        "/api/projects",
        {
          name: "Together",
          description: "A friendly team website",
          requestKey: id(),
        },
        owner,
      )
    ).json(),
    projectId = created.id;
  store.run(
    "UPDATE projects SET state='ready',repo='team/project' WHERE id=?",
    projectId,
  );
  store.run("UPDATE jobs SET state='unchanged'");
  const project = store.get("SELECT * FROM projects WHERE id=?", projectId),
    secret = store.open(project.worker_secret),
    invitation = store.open(project.invite_secret);
  const joined = await call("/api/invites/join", {
      token: invitation,
      name: "Alice",
    }),
    memberCookie = joined.headers.get("set-cookie").split(";")[0];
  await call(
    `/api/projects/${projectId}/messages`,
    { text: "Change the heading to Hello Team", requestKey: id() },
    memberCookie,
  );
  const bin = path.join(dir, "bin");
  await mkdir(bin);
  const fakeCodex = `#!${process.execPath}\nconst fs=require('fs'),crypto=require('crypto');const args=process.argv.slice(2),out=args[args.indexOf('--output-last-message')+1];if(args.includes('--output-schema')){fs.writeFileSync(out,JSON.stringify({decision:'approve',summary:'No blocking findings in the test review.',findings:[]}));}else{let p=fs.readFileSync('app/src/main.tsx','utf8');fs.writeFileSync('app/src/main.tsx',p.replace('__PROJECT_NAME__','Hello Team'));const resume=args.indexOf('resume'),thread=resume>=0?args[resume+1]:crypto.randomUUID();fs.appendFileSync(process.env.HOME+'/invocations.jsonl',JSON.stringify(args)+'\\n');console.log(JSON.stringify({type:'thread.started',thread_id:thread}));fs.writeFileSync(out,'Changed the heading to Hello Team.');}\n`;
  await writeFile(path.join(bin, "codex"), fakeCodex, { mode: 0o700 });
  const originalPath = process.env.PATH;
  process.env.PATH = bin + ":" + originalPath;
  t.after(() => {
    process.env.PATH = originalPath;
  });
  const auth = { status: async () => ({ state: "connected" }) },
    agent = createAgent({
      dataDir: data,
      platform: config.publicUrl,
      projectId,
      secret,
      auth,
      request: (url, options) =>
        url.endsWith("/thread")
          ? Promise.resolve(
              Response.json(
                { error: "Temporary thread persistence failure" },
                { status: 503 },
              ),
            )
          : fetch(url, options),
    }),
    reviewer = createReviewer(agent, { dataDir: data, auth });
  await agent.initialize();
  await agent.codeOne();
  const job = store.get(
    "SELECT * FROM jobs WHERE project_id=? AND state=?",
    projectId,
    "reviewing",
  );
  assert.ok(job);
  assert.equal(job.pr_number, 1);
  const member = store.get("SELECT * FROM members WHERE id=?", job.member_id);
  assert.match(member.thread_id, /^[a-f0-9-]{36}$/);
  assert.ok(authorizedGitRequests > 0);
  assert.ok(
    !(await readFile(path.join(data, "repo/.git/config"), "utf8")).includes(
      "owner-github-fixture",
    ),
  );
  const page = await (
    await call(`/api/projects/${projectId}`, undefined, memberCookie)
  ).json();
  assert.equal(page.messages.at(-1).role, "assistant");
  assert.ok(page.jobs[0].prUrl.endsWith("/pull/1"));
  await reviewer.one();
  const candidate = (await currentPull()).head.sha;
  store.run(
    "INSERT INTO previews(project_id,pr_number,state,url,commit_sha) VALUES(?,1,'ready','https://preview.example.test',?)",
    projectId,
    candidate,
  );
  // Waiting for a preview must not create a new commit on every poll.
  await reviewer.one();
  assert.equal((await currentPull()).head.sha, candidate);
  await assert.rejects(reviewer.finish(), /Something interrupted this request/);
  assert.equal(
    store.get("SELECT state FROM jobs WHERE id=?", job.id).state,
    "reviewing",
  );
  await reviewer.finish();
  assert.equal(pr.state, "closed");
  assert.equal(
    store.get("SELECT state FROM jobs WHERE id=?", job.id).state,
    "deploying",
  );
  const published = (
    await exec("git", ["--git-dir", bare, "show", "main:app/src/main.tsx"])
  ).stdout;
  assert.ok(published.includes("Hello Team"));
  assert.ok(
    store.get(
      "SELECT id FROM tasks WHERE project_id=? AND kind='deploy' AND dedupe_key LIKE 'main:%'",
      projectId,
    ),
  );
  // A new worker object uses the same disk and resumes this member's exact conversation.
  store.run("UPDATE members SET thread_id=NULL WHERE id=?", member.id);
  const resumed = createAgent({
    dataDir: data,
    platform: config.publicUrl,
    projectId,
    secret,
    auth,
  });
  await resumed.initialize();
  await call(
    `/api/projects/${projectId}/messages`,
    { text: "Keep the heading Hello Team", requestKey: id() },
    memberCookie,
  );
  await resumed.codeOne();
  const invocations = (
    await readFile(
      path.join(data, "home", member.id, "invocations.jsonl"),
      "utf8",
    )
  )
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(invocations.length, 2);
  assert.ok(invocations[1].includes("resume"));
  assert.ok(invocations[1].includes(member.thread_id));
});
