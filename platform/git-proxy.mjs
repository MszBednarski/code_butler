import http from "node:http";
import https from "node:https";
import { digest } from "./store.mjs";

// Repository-scoped smart-HTTP bridge: the worker never receives the owner's
// GitHub OAuth token. Only this project's repository can be fetched or pushed.
export function installGitProxy(
  app,
  store,
  { upstream = "https://github.com" } = {},
) {
  app.use("/api/git/:projectId/repo.git", (req, res) => {
    const credentials = /^Basic (.+)$/i.exec(req.headers.authorization || "");
    const value = credentials
      ? Buffer.from(credentials[1], "base64")
          .toString("utf8")
          .split(":")
          .slice(1)
          .join(":")
      : "";
    const project =
      value.length <= 100
        ? store.get(
            "SELECT * FROM projects WHERE id=? AND worker_hash=?",
            req.params.projectId,
            digest(value),
          )
        : null;
    if (!project?.repo)
      return res
        .status(401)
        .set("WWW-Authenticate", 'Basic realm="Butler project"')
        .end();
    if (
      !(
        (req.method === "GET" &&
          req.path === "/info/refs" &&
          ["git-upload-pack", "git-receive-pack"].includes(
            req.query.service,
          )) ||
        (req.method === "POST" &&
          ["/git-upload-pack", "/git-receive-pack"].includes(req.path))
      )
    )
      return res.status(404).end();
    const saved = store.connection(project.owner_id, "github");
    if (!saved?.access_token)
      return res.status(503).end("The project lead needs to reconnect GitHub.");
    const target = new URL(`/${project.repo}.git${req.path}`, upstream);
    if (req.path === "/info/refs")
      target.searchParams.set("service", req.query.service);
    const headers = {
      Authorization: `Basic ${Buffer.from(`x-access-token:${saved.access_token}`).toString("base64")}`,
      "User-Agent": "Pocket-Butler-Git",
    };
    for (const name of [
      "content-type",
      "content-length",
      "git-protocol",
      "accept",
      "accept-encoding",
    ])
      if (req.headers[name]) headers[name] = req.headers[name];
    const remote = (target.protocol === "https:" ? https : http).request(
      target,
      { method: req.method, headers, timeout: 120000 },
      (response) => {
        res.status(response.statusCode);
        for (const name of [
          "content-type",
          "content-encoding",
          "cache-control",
          "expires",
          "pragma",
        ])
          if (response.headers[name]) res.set(name, response.headers[name]);
        response.pipe(res);
      },
    );
    remote.on("error", () => {
      if (!res.headersSent)
        res.status(502).end("Repository connection interrupted.");
      else res.destroy();
    });
    remote.on("timeout", () => remote.destroy());
    req.on("aborted", () => remote.destroy());
    res.on("close", () => {
      if (!res.writableFinished) remote.destroy();
    });
    req.pipe(remote);
  });
}
