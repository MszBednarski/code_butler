import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import {
  readAppFile,
  verifyWithGemini,
  browserCheck,
} from "../gemini-reviewer.mjs";

test("Gemini read tool cannot inspect secrets, sibling worktrees or symlink escapes", async (t) => {
  const dir = await mkdtemp("/tmp/butler-gemini-files-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(dir + "/app");
  await writeFile(dir + "/app/main.ts", "App source");
  await writeFile(dir + "/secret", "Private");
  await writeFile(dir + "/app/.env", "Private");
  await symlink(dir + "/secret", dir + "/app/link");
  assert.equal(await readAppFile(dir, "app/main.ts"), "App source");
  for (const name of ["../secret", ".env", "app/.env", "link", "/etc/passwd"])
    await assert.rejects(readAppFile(dir, name));
});
test("Gemini approval requires real successful app checks and browser assertions", async () => {
  const pr = { number: 1, head: { sha: "a".repeat(40) } },
    base = "b".repeat(40),
    events = [];
  const call = (id, name, args) => ({
    id,
    status: "requires_action",
    steps: [{ type: "function_call", id, name, arguments: args }],
  });
  let next = 0,
    builds = 0;
  const agent = {
    git: async () => ({ stdout: "App diff" }),
    reportPull: async (...args) => events.push(args),
    build: async () => {
      builds++;
    },
    api: async () =>
      [
        call("c1", "run_app_checks", {}),
        call("c2", "check_browser", {
          steps: [
            { action: "click", selector: "button" },
            { action: "expect_text", text: "1 tap" },
          ],
        }),
        call("c3", "finish_verification", {
          decision: "approve",
          summary: "Tapping now works.",
          findings: [],
        }),
      ][next++],
  };
  const options = {
    pr,
    base,
    directory: "/unused",
    home: "/unused",
    key: "test",
    checkBrowser: async () => ({
      passed: true,
      assertions: 1,
      results: [{ action: "expect_text", passed: true }],
    }),
  };
  assert.equal((await verifyWithGemini(agent, options)).decision, "approve");
  assert.equal(builds, 1);
  assert.ok(events.every((e) => e[3] === "gemini"));
  assert.match(events.at(-1)[2], /"phase":"passed"/);
  next = 2;
  const noEvidence = await verifyWithGemini(agent, options);
  assert.equal(noEvidence.decision, "block");
  next = 0;
  const failed = await verifyWithGemini(agent, {
    ...options,
    checkBrowser: async () => ({
      passed: false,
      assertions: 0,
      results: [{ action: "expect_text", passed: false }],
    }),
  });
  assert.equal(failed.decision, "block");
});
test(
  "real phone browser executes a click and fails a wrong expectation",
  { skip: !process.env.BUTLER_CHROME },
  async (t) => {
    const dir = await mkdtemp("/tmp/butler-gemini-browser-");
    t.after(() => rm(dir, { recursive: true, force: true }));
    await mkdir(dir + "/app");
    await writeFile(
      dir + "/app/package.json",
      JSON.stringify({ scripts: { start: "node server.cjs" } }),
    );
    const html = `<button id="tap" onclick="this.textContent='1 tap'">Tap</button>`;
    await writeFile(
      dir + "/app/server.cjs",
      `require('node:http').createServer((q,r)=>r.end(${JSON.stringify(html)})).listen(process.env.PORT,'127.0.0.1')`,
    );
    const good = await browserCheck(
      dir,
      dir,
      [
        { action: "click", selector: "#tap" },
        { action: "expect_text", selector: "#tap", text: "1 tap" },
      ],
      { executablePath: process.env.BUTLER_CHROME },
    );
    assert.equal(good.passed, true);
    assert.equal(good.assertions, 1);
    assert.ok(good.screenshot);
    const bad = await browserCheck(
      dir,
      dir,
      [
        { action: "click", selector: "#tap" },
        { action: "expect_text", selector: "#tap", text: "2 taps" },
      ],
      { executablePath: process.env.BUTLER_CHROME },
    );
    assert.equal(bad.passed, false);
    assert.equal(bad.assertions, 0);
  },
);
