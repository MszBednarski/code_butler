import express from "express";
import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createCodexAuth } from "./auth.mjs";
import { createAgent } from "./agent.mjs";
import { createReviewer } from "./reviewer.mjs";
import { sleep } from "./runtime.mjs";

export async function createWorker({
  platform,
  projectId,
  secret,
  dataDir = "/data",
  auth,
  agent,
  reviewer,
} = {}) {
  if (
    !/^https:\/\//.test(platform || "") &&
    !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(platform || "")
  )
    throw new Error("PLATFORM_URL must be the HTTPS Butler origin.");
  if (
    !/^[a-f0-9-]{36}$/.test(projectId || "") ||
    !/^[\w-]{43}$/.test(secret || "")
  )
    throw new Error("PROJECT_ID and WORKER_SECRET must be configured.");
  auth ||= await createCodexAuth({ dataDir });
  agent ||= createAgent({ dataDir, platform, projectId, secret, auth });
  reviewer ||= createReviewer(agent, { dataDir, auth });
  const app = express(),
    server = createServer(app);
  let stopped = false;
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.get("/healthz", (_req, res) => res.type("text").send("ok"));
  app.use((req, res, next) => {
    const actual = createHash("sha256")
        .update(req.headers.authorization || "")
        .digest(),
      expected = createHash("sha256").update(`Bearer ${secret}`).digest();
    if (!timingSafeEqual(actual, expected)) return res.sendStatus(401);
    next();
  });
  app.post("/auth/start", async (_req, res) => res.json(await auth.start()));
  app.get("/auth/status", async (_req, res) => res.json(await auth.status()));
  app.use((_req, res) => res.sendStatus(404));
  app.use((error, _req, res, _next) => {
    console.error(`[worker] ${error.name}`);
    res
      .status(503)
      .json({ error: "The workspace is starting. Try again shortly." });
  });
  async function loop() {
    let ready = false;
    while (!stopped) {
      try {
        if (!ready) {
          await agent.initialize();
          ready = true;
        }
        await reviewer.finish();
        await agent.codeOne();
        await reviewer.one();
      } catch (error) {
        console.error(`[worker] Background request interrupted: ${error.name}`);
      }
      if (!stopped) await sleep(5000);
    }
  }
  return {
    app,
    server,
    auth,
    agent,
    start: () => loop(),
    stop() {
      stopped = true;
      agent.stop();
      reviewer.stop();
      auth.stop();
    },
  };
}

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  process.umask(0o077);
  if (
    process.env.RAILWAY_ENVIRONMENT_ID ||
    process.env.REQUIRE_PERSISTENT_VOLUME === "1"
  ) {
    if (
      !readFileSync("/proc/self/mountinfo", "utf8")
        .split("\n")
        .some((line) => line.split(" ")[4] === "/data")
    )
      throw new Error("Project worker requires a persistent volume at /data.");
  }
  const worker = await createWorker({
    platform: process.env.PLATFORM_URL,
    projectId: process.env.PROJECT_ID,
    secret: process.env.WORKER_SECRET,
  });
  worker.server.listen(Number(process.env.PORT || 3000), "0.0.0.0", () =>
    console.log("Project workspace is ready for connections."),
  );
  worker.start().catch((error) => console.error(`[worker] ${error.name}`));
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => {
      worker.stop();
      worker.server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 10000).unref();
    });
}
