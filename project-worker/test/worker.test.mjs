import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDeviceOutput } from "../auth.mjs";
import { safeEnvironment } from "../runtime.mjs";
import { mergeAllowed } from "../reviewer.mjs";
import { createWorker } from "../server.mjs";
import { randomBytes, randomUUID } from "node:crypto";

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
