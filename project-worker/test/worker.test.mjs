import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDeviceOutput } from "../auth.mjs";
import { safeEnvironment } from "../runtime.mjs";
import { mergeAllowed, reviewKey } from "../reviewer.mjs";
import { createWorker } from "../server.mjs";
import { randomBytes, randomUUID } from "node:crypto";
import {
  assistantUpdate,
  createProgress,
  readableFailure,
} from "../progress.mjs";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  mkdir,
} from "node:fs/promises";

test("progress forwards assistant messages and excludes reasoning, commands, and auth output", () => {
  assert.deepEqual(
    assistantUpdate({
      type: "item.completed",
      item: {
        id: "item_1",
        type: "agent_message",
        text: "I’m updating the layout.",
      },
    }),
    { key: "item_1", text: "I’m updating the layout." },
  );
  for (const type of ["reasoning", "command_execution", "mcp_tool_call"])
    assert.equal(
      assistantUpdate({
        type: "item.completed",
        item: { id: "hidden", type, text: "sensitive-fixture" },
      }),
      null,
    );
  assert.equal(
    assistantUpdate({ type: "error", message: "sensitive-fixture" }),
    null,
  );
  assert.ok(
    !readableFailure(
      { output: "sensitive-fixture" },
      "checking the app",
    ).includes("sensitive-fixture"),
  );
});
test("progress survives a lost delivery response and worker restart without duplicate events", async (t) => {
  const dataDir = await mkdtemp("/tmp/butler-progress-"),
    target = `jobs/${randomUUID()}`,
    delivered = new Set();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let lose = true;
  const api = async (_path, { events }) => {
    for (const e of events) delivered.add(e.key);
    if (lose) {
      lose = false;
      throw Error("Response lost");
    }
    return { ok: true };
  };
  await createProgress({ dataDir, api }).post(
    target,
    "attempt:item_1",
    "The app checks are running.",
    "agent",
  );
  assert.equal((await readdir(dataDir + "/events")).length, 1);
  const file = (await readdir(dataDir + "/events"))[0];
  assert.ok(
    (await readFile(dataDir + "/events/" + file, "utf8")).includes(
      "The app checks are running.",
    ),
  );
  await createProgress({ dataDir, api }).flush();
  assert.equal(delivered.size, 1);
  assert.equal((await readdir(dataDir + "/events")).length, 0);
});
test("a reviewer that changes proposed files cannot publish a validation", async (t) => {
  const { createReviewer, reviewKey } = await import("../reviewer.mjs"),
    dataDir = await mkdtemp("/tmp/butler-review-integrity-");
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await mkdir(dataDir + "/reviews");
  const pr = {
    number: 1,
    state: "open",
    draft: false,
    title: "Improve tiles",
    labels: [],
    head: {
      sha: "a".repeat(40),
      ref: "alice/task",
      repo: { full_name: "team/project" },
    },
    base: { ref: "main", repo: { full_name: "team/project" } },
  };
  let diffs = 0,
    blocked = false,
    validated = false;
  const agent = {
    stopping: false,
    github: async (operation, b) => {
      if (operation === "pulls") return [pr];
      if (operation === "pull") return pr;
      if (operation === "main") return { object: { sha: "b".repeat(40) } };
      if (operation === "reviews") return [];
      if (operation === "block") {
        blocked = true;
        assert.equal(b.retryable, true);
        assert.ok(b.text.includes("changed the checkout"));
      }
      if (operation === "status") validated = true;
      return {};
    },
    git: async (args) => ({
      code: 0,
      stdout:
        args[0] === "diff"
          ? ++diffs === 1
            ? "original proposed code"
            : "changed proposed code"
          : "",
    }),
    run: async (_file, args) => {
      assert.ok(args.includes("--dangerously-bypass-approvals-and-sandbox"));
      assert.ok(args.includes("--json"));
      const output = args[args.indexOf("--output-last-message") + 1];
      await writeFile(
        output,
        JSON.stringify({ decision: "approve", summary: "Fine", findings: [] }),
      );
    },
  };
  const reviewer = createReviewer(agent, {
    dataDir,
    auth: { status: async () => ({ state: "connected" }) },
  });
  await reviewer.one();
  assert.equal(blocked, true);
  assert.equal(validated, false);
});
test("device authentication extracts only the OpenAI authorization link and one-time code", () => {
  const value = parseDeviceOutput(
    "\x1b[32mOpen https://auth.openai.com/codex/device\nCode: ABCD-EFGH\x1b[0m",
  );
  assert.deepEqual(value, {
    url: "https://auth.openai.com/codex/device",
    code: "ABCD-EFGH",
  });
  assert.equal(
    parseDeviceOutput(
      "https://auth.openai.com.evil.test/codex/device ABCD-EFGH",
    ),
    null,
  );
  assert.equal(parseDeviceOutput("https://evil.test ABCD-EFGH"), null);
  assert.equal(parseDeviceOutput("Loading…"), null);
});

test("coding and build processes do not inherit controller/provider secrets", () => {
  process.env.WORKER_SECRET = "sensitive-fixture";
  process.env.GH_TOKEN = "sensitive-fixture";
  process.env.RAILWAY_API_TOKEN = "sensitive-fixture";
  process.env.OPENAI_API_KEY = "sensitive-fixture";
  const environment = safeEnvironment("/data/teammate", true);
  for (const key of [
    "WORKER_SECRET",
    "GH_TOKEN",
    "RAILWAY_API_TOKEN",
    "OPENAI_API_KEY",
    "NANOCODEX_API_KEY",
  ])
    assert.equal(environment[key], undefined);
  assert.ok(environment.CODEX_HOME);
  assert.equal(safeEnvironment("/data/build").CODEX_HOME, undefined);
});

test("merge guard rejects changed heads, bases, held PRs, drafts and closed PRs", () => {
  const pr = {
    state: "open",
    draft: false,
    base: { ref: "main" },
    head: { sha: "head" },
    labels: [],
  };
  assert.equal(mergeAllowed(pr, "head", "base", "base"), true);
  for (const p of [
    { ...pr, state: "closed" },
    { ...pr, draft: true },
    { ...pr, head: { sha: "new" } },
    { ...pr, labels: [{ name: "hold" }] },
    { ...pr, base: { ref: "other" } },
  ])
    assert.equal(mergeAllowed(p, "head", "base", "base"), false);
  assert.equal(mergeAllowed(pr, "head", "base", "new-main"), false);
});

test("worker exposes health publicly and protects Codex device authorization with the project secret", async (t) => {
  const secret = randomBytes(32).toString("base64url");
  let started = 0;
  const auth = {
    start: async () => {
      started++;
      return {
        state: "pending",
        code: "ABCD-EFGH",
        url: "https://auth.openai.com/codex/device",
      };
    },
    status: async () => ({ state: "signed_out" }),
    stop() {},
  };
  const worker = await createWorker({
    platform: "http://127.0.0.1:3000",
    projectId: randomUUID(),
    secret,
    auth,
    agent: { stop() {} },
    reviewer: { stop() {} },
  });
  await new Promise((resolve) => worker.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => worker.server.close(resolve)));
  const url = `http://127.0.0.1:${worker.server.address().port}`;
  assert.equal((await fetch(url + "/healthz")).status, 200);
  assert.equal((await fetch(url + "/auth/status")).status, 401);
  assert.equal(
    (
      await fetch(url + "/auth/start", {
        method: "POST",
        headers: { authorization: "Bearer wrong" },
      })
    ).status,
    401,
  );
  assert.equal(started, 0);
  const response = await fetch(url + "/auth/start", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).code, "ABCD-EFGH");
  assert.equal(started, 1);
});

test("a failed proposed merge build is recorded and does not starve later PRs", async (t) => {
  const { mkdtemp, rm, mkdir } = await import("node:fs/promises"),
    { save, load } = await import("../runtime.mjs"),
    { createReviewer } = await import("../reviewer.mjs");
  const dir = await mkdtemp("/tmp/butler-review-");
  await mkdir(dir + "/reviews");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base = "a".repeat(40),
    candidate = "c".repeat(40),
    pulls = [1, 2].map((number) => ({
      number,
      state: "open",
      draft: false,
      title: "Request " + number,
      labels: [],
      head: {
        sha: String(number).repeat(40),
        ref: "member/task-" + number,
        repo: { full_name: "team/project" },
      },
      base: { ref: "main", repo: { full_name: "team/project" } },
    }));
  for (const pr of pulls)
    await save(`${dir}/reviews/${pr.number}.json`, {
      key: reviewKey(pr.head.sha, base),
      decision: "reviewed",
      verdict: { decision: "approve", summary: "Fine", findings: [] },
    });
  let active,
    blocked = [];
  const agent = {
    stopping: false,
    github: async (operation, b) => {
      if (operation === "pulls") return pulls;
      if (operation === "pull") {
        active = b.number;
        return pulls.find((p) => p.number === b.number);
      }
      if (operation === "main") return { object: { sha: base } };
      if (operation === "reviews") return [];
      if (operation === "block") {
        blocked.push(b.number);
        return {};
      }
      return {};
    },
    git: async (args) => ({
      code: 0,
      stdout:
        args[0] === "rev-parse" && args[1] === "HEAD"
          ? candidate
          : args[0] === "ls-files"
            ? ""
            : "",
    }),
    build: async () => {
      if (active === 1) throw new Error("Compilation failed.");
    },
  };
  const reviewer = createReviewer(agent, {
    dataDir: dir,
    auth: { status: async () => ({ state: "connected" }) },
  });
  await reviewer.one();
  assert.deepEqual(blocked, [1]);
  assert.equal((await load(`${dir}/reviews/1.json`)).decision, "block");
  assert.equal((await load(`${dir}/reviews/2.json`)).decision, "validated");
});

test("empty polls wait thirty seconds; completed work polls promptly; failures back off", async () => {
  const pauses = [],
    order = [];
  let cycle = 0,
    worker;
  worker = await createWorker({
    platform: "http://127.0.0.1:3000",
    projectId: randomUUID(),
    secret: randomBytes(32).toString("base64url"),
    auth: { stop() {} },
    agent: {
      initialize: async () => {},
      codeOne: async () => {
        order.push("claim");
        return cycle === 1;
      },
      stop() {},
    },
    reviewer: {
      finish: async () => {
        order.push("finish");
        if (cycle === 2) throw Error("temporary failure");
      },
      one: async () => order.push("review"),
      stop() {},
    },
    pause: async (ms) => {
      pauses.push(ms);
      if (++cycle === 3) worker.stop();
    },
  });
  await worker.start();
  assert.deepEqual(pauses, [30000, 5000, 30000]);
  assert.deepEqual(order, [
    "finish",
    "claim",
    "review",
    "finish",
    "claim",
    "review",
    "finish",
  ]);
});

test("authenticated worker status reports busy during review and idle between polls", async (t) => {
  const secret = randomBytes(32).toString("base64url");
  let release, started, worker, url;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const status = () =>
    fetch(url + "/status", {
      headers: { authorization: `Bearer ${secret}` },
    }).then((r) => r.json());
  worker = await createWorker({
    platform: "http://127.0.0.1:3000",
    projectId: randomUUID(),
    secret,
    auth: { stop() {} },
    agent: {
      initialize: async () => {},
      codeOne: async () => false,
      stop() {},
    },
    reviewer: {
      finish: async () => {
        started();
        await held;
      },
      one: async () => {},
      stop() {},
    },
    pause: async () => {
      assert.equal((await status()).busy, false);
      worker.stop();
    },
  });
  await new Promise((resolve) => worker.server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${worker.server.address().port}`;
  t.after(() => new Promise((resolve) => worker.server.close(resolve)));
  const running = worker.start();
  await entered;
  try {
    assert.equal((await fetch(url + "/status")).status, 401);
    assert.equal((await status()).busy, true);
  } finally {
    release();
  }
  await running;
});
