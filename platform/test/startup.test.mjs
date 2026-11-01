import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createStore } from "../store.mjs";

test("health becomes available while legacy credential revocation is stalled", async (t) => {
  const directory = await mkdtemp("/tmp/butler-startup-test-"),
    store = createStore(directory);
  const user = store.guest("Lead");
  store.connection(user.id, "github", {
    access_token: "legacy-revocation-fixture",
  });
  store.close();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const preload = directory + "/offline.mjs";
  await writeFile(
    preload,
    'globalThis.fetch = () => { console.log("fixture revocation started"); return new Promise(() => {}); };\n',
  );
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(
    process.execPath,
    ["--import", preload, new URL("../server.mjs", import.meta.url).pathname],
    {
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        PORT: String(port),
        PUBLIC_URL: `http://127.0.0.1:${port}`,
        DATA_DIR: directory,
        GITHUB_OAUTH_CLIENT_ID: "fixture-client",
        GITHUB_OAUTH_CLIENT_SECRET: "fixture-secret",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(async () => {
    child.kill("SIGKILL");
    await exited;
  });
  let output = "";
  child.stdout.on("data", (bytes) => (output += bytes));
  child.stderr.resume();
  let healthy = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      healthy = (
        await fetch(`http://127.0.0.1:${port}/healthz`, {
          signal: AbortSignal.timeout(300),
        })
      ).ok;
    } catch {}
    if (healthy) break;
    await delay(75);
  }
  assert.ok(output.includes("fixture revocation started"));
  assert.ok(healthy, "A provider outage must not block Butler's healthcheck");
  const reopened = createStore(directory);
  assert.equal(reopened.connection(user.id, "github"), null);
  assert.ok(reopened.connection(user.id, "github_legacy_revoke"));
  reopened.close();
});
