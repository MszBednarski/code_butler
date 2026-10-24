import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

export function configuration(env = process.env) {
  const publicUrl =
    env.PUBLIC_URL ||
    (env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${env.RAILWAY_PUBLIC_DOMAIN}`
      : "http://localhost:3000");
  const url = new URL(publicUrl);
  if (
    url.origin !== publicUrl ||
    (url.protocol !== "https:" &&
      !["localhost", "127.0.0.1"].includes(url.hostname))
  )
    throw new Error("PUBLIC_URL must be an HTTPS origin");
  if (
    env.RAILWAY_ENVIRONMENT_ID &&
    !readFileSync("/proc/self/mountinfo", "utf8")
      .split("\n")
      .some((line) => line.split(" ")[4] === "/data")
  )
    throw new Error("Platform requires a persistent Railway volume at /data");
  return {
    publicUrl,
    secure: url.protocol === "https:",
    port: Number(env.PORT || 3000),
    dataDir: env.DATA_DIR || "/data",
    frontend:
      env.FRONTEND_DIR || path.resolve(import.meta.dirname, "../app/dist"),
    templateDir:
      env.TEMPLATE_DIR || path.resolve(import.meta.dirname, "template"),
    workerDir:
      env.WORKER_DIR || path.resolve(import.meta.dirname, "../project-worker"),
    githubClientId: env.GITHUB_OAUTH_CLIENT_ID,
    githubClientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
    railwayClientId: env.RAILWAY_OAUTH_CLIENT_ID,
    railwayClientSecret: env.RAILWAY_OAUTH_CLIENT_SECRET,
    setupToken: env.SETUP_TOKEN,
    operatorWorkspaceId: env.OPERATOR_WORKSPACE_ID,
    emailKey: env.RESEND_API_KEY,
    emailFrom: env.EMAIL_FROM,
    githubApi: "https://api.github.com",
    railwayApi: "https://backboard.railway.app/graphql/v2",
    commit: env.RAILWAY_GIT_COMMIT_SHA || "dev",
  };
}
