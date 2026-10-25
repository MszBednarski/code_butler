import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import { createStore, id, now } from "../store.mjs";
import { installGeminiWorker } from "../gemini.mjs";

test("Gemini broker fixes model/tools, binds results and accounts, excludes thoughts, resumes, and caps paid turns", async (t) => {
  const dir = await mkdtemp("/tmp/butler-gemini-"),
    store = createStore(dir);
  const lead = store.guest("Lead"),
    member = store.guest("Member"),
    projectId = id(),
    memberId = id(),
    jobId = id();
  store.run(
    "INSERT INTO projects(id,owner_id,name,description,slug,invite_hash,invite_secret,worker_secret,worker_hash,webhook_secret,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    projectId,
    lead.id,
    "Game",
    "A game",
    "game",
    "a",
    "b",
    "c",
    "d",
    "e",
    now(),
  );
  store.run(
    "INSERT INTO members(id,project_id,user_id,name,prefix,created_at) VALUES(?,?,?,?,?,?)",
    memberId,
    projectId,
    member.id,
    "Member",
    "member",
    now(),
  );
  store.run(
    "INSERT INTO jobs(id,project_id,member_id,request_key,text,pr_number,approved_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
    jobId,
    projectId,
    memberId,
    id(),
    "Make tapping work",
    1,
    now(),
    now(),
    now(),
  );
  const project = store.get("SELECT * FROM projects WHERE id=?", projectId),
    head = "a".repeat(40),
    base = "b".repeat(40);
  store.connection(lead.id, "gemini_verification", {
    apiKey: "fixture-leader-".repeat(3),
  });
  store.connection(member.id, "gemini_verification", {
    apiKey: "fixture-member-".repeat(3),
  });
  const requests = [],
    keys = [];
  let generation = 0;
  const result = () => ({
    id: "interaction-" + generation,
    status: "requires_action",
    steps: [
      { type: "thought", text: "private reasoning fixture" },
      {
        type: "function_call",
        id: "check-" + generation,
        name: "run_app_checks",
        arguments: {},
      },
    ],
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.project = project;
    next();
  });
  installGeminiWorker(
    app,
    store,
    {
      github: async (_user, path) =>
        path.includes("/pulls/")
          ? {
              state: "open",
              draft: false,
              head: { sha: head, repo: { full_name: "team/game" } },
              base: { ref: "main" },
              title: "Fix tapping",
            }
          : { object: { sha: base } },
    },
    {
      client: (key) => {
        keys.push(key);
        return {
          interactions: {
            create: async (body) => {
              requests.push(body);
              generation++;
              return result();
            },
            get: async () => result(),
          },
        };
      },
    },
  );
  store.run("UPDATE projects SET repo='team/game' WHERE id=?", projectId);
  project.repo = "team/game";
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}/api/worker/pulls/1/gemini`;
  const call = (body) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ head, base, ...body }),
    });
  const first = await (
    await call({ operation: "start", context: "app diff" })
  ).json();
  assert.equal(first.id, "interaction-1");
  assert.ok(!JSON.stringify(first).includes("private reasoning"));
  assert.equal(keys[0], "fixture-member-".repeat(3));
  assert.equal(requests[0].model, "gemini-4-argon");
  assert.equal(requests[0].background, true);
  assert.equal(requests[0].generation_config.thinking_level, "medium");
  assert.deepEqual(
    requests[0].tools.map((t) => t.name),
    ["read_app_file", "run_app_checks", "check_browser", "finish_verification"],
  );
  await call({ operation: "start", context: "retry" });
  assert.equal(requests.length, 1);
  assert.equal(
    (
      await call({
        operation: "continue",
        interactionId: first.id,
        input: [
          {
            type: "function_result",
            call_id: "other",
            name: "run_app_checks",
            result: [],
          },
        ],
      })
    ).status,
    400,
  );
  for (let n = 1; n < 8; n++) {
    const response = await call({
      operation: "continue",
      interactionId: "interaction-" + n,
      input: [
        {
          type: "function_result",
          call_id: "check-" + n,
          name: "run_app_checks",
          result: [{ type: "text", text: '{"passed":true}' }],
        },
      ],
    });
    assert.equal(response.status, 200);
  }
  assert.equal(requests.length, 8);
  assert.equal(
    (
      await call({
        operation: "continue",
        interactionId: "interaction-8",
        input: [
          {
            type: "function_result",
            call_id: "check-8",
            name: "run_app_checks",
            result: [],
          },
        ],
      })
    ).status,
    429,
  );
  assert.equal(requests.length, 8);
  assert.equal(
    (await call({ operation: "start", head: "c".repeat(40), context: "stale" }))
      .status,
    409,
  );
  assert.ok(
    !JSON.stringify(await (await fetch(url)).json()).includes("fixture-key"),
  );
});
