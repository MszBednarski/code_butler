import { createPrivateKey } from "node:crypto";
import { digest, token, now } from "./store.mjs";
import { cookie, cookies } from "./auth.mjs";
import {
  githubPermissions,
  githubAppReady,
  githubLoginClient,
} from "./github-app.mjs";

export function installSetup(app, config, store, request = fetch) {
  const saved = store.setting("provider-settings") || {};
  for (const key of [
    "githubClientId",
    "githubClientSecret",
    "githubAppId",
    "githubAppSlug",
    "githubAppPrivateKey",
    "githubAppWebhookSecret",
    "githubAppClientId",
    "githubAppClientSecret",
    "railwayClientId",
    "railwayClientSecret",
  ])
    if (saved[key]) config[key] = saved[key];
  if (
    config.setupToken &&
    digest(config.setupToken) !== store.setting("setup-token-hash")
  ) {
    store.setting("setup-token-hash", digest(config.setupToken));
    store.setting("setup-enabled", true);
  }
  const allowed = (req, res, next) => {
    if (
      typeof req.body?.token !== "string" ||
      req.body.token.length > 100 ||
      !store.setting("setup-enabled") ||
      digest(req.body.token) !== store.setting("setup-token-hash")
    )
      return res.status(403).json({
        error: "This private installation link has expired or is invalid.",
      });
    next();
  };
  const status = () => ({
    github: Boolean(
      githubLoginClient(config).id && githubLoginClient(config).secret,
    ),
    githubApp: githubAppReady(config),
    githubAppName: config.githubAppSlug || null,
    railway: Boolean(config.railwayClientId && config.railwayClientSecret),
    publicUrl: config.publicUrl,
    railwaySettingsUrl: config.operatorWorkspaceId
      ? `https://railway.com/workspace/developer?workspaceId=${config.operatorWorkspaceId}`
      : "https://railway.com",
  });
  app.post("/api/setup/status", allowed, (_req, res) => res.json(status()));
  app.post("/api/setup/github-app/manifest", allowed, (req, res) => {
    const state = token(),
      browser = token();
    store.run("DELETE FROM oauth_states WHERE created_at<?", now() - 600000);
    store.run(
      "INSERT INTO oauth_states VALUES(?,?,?,?,?,?)",
      digest(state),
      digest(browser),
      null,
      "github-manifest",
      "/setup",
      now(),
    );
    cookie(res, config, "butler_github_manifest", browser, 600);
    res.json({
      url: `https://github.com/settings/apps/new?state=${state}`,
      manifest: {
        name: `Pocket Butler ${digest(config.publicUrl).slice(0, 7)}`,
        url: config.publicUrl,
        description:
          "Create and collaborate on Butler project repositories. No organization administration or access to unrelated repositories.",
        public: true,
        redirect_url: `${config.publicUrl}/auth/github-app/manifest/callback`,
        callback_urls: [`${config.publicUrl}/auth/github/callback`],
        setup_url: `${config.publicUrl}/auth/github/install/callback`,
        setup_on_update: false,
        request_oauth_on_install: false,
        hook_attributes: {
          url: `${config.publicUrl}/api/hooks/github-app`,
          active: true,
        },
        default_permissions: githubPermissions,
        default_events: ["push", "pull_request"],
      },
    });
  });
  app.get("/auth/github-app/manifest/callback", async (req, res) => {
    const state =
      typeof req.query.state === "string"
        ? store.get(
            "SELECT * FROM oauth_states WHERE hash=? AND provider='github-manifest' AND created_at>?",
            digest(req.query.state),
            now() - 600000,
          )
        : null;
    if (
      !store.setting("setup-enabled") ||
      !state ||
      digest(cookies(req).butler_github_manifest || "") !==
        state.browser_hash ||
      typeof req.query.code !== "string" ||
      !/^[a-zA-Z0-9_-]{8,200}$/.test(req.query.code)
    )
      return res
        .status(400)
        .send(
          "App registration expired. Return to the private admin page and try again.",
        );
    store.run("DELETE FROM oauth_states WHERE hash=?", state.hash);
    cookie(res, config, "butler_github_manifest", "", 0);
    const response = await request(
      `${config.githubApi}/app-manifests/${req.query.code}/conversions`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "Pocket-Butler",
        },
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!response.ok)
      return res
        .status(502)
        .send(
          "GitHub could not complete app registration. Return to Butler’s private admin page and try again.",
        );
    const value = await response.json();
    for (const [permission, level] of Object.entries(value.permissions || {}))
      if (level !== "none" && githubPermissions[permission] !== level)
        return res
          .status(400)
          .send(
            "This app requests extra permissions. Register it using Butler’s limited manifest.",
          );
    if (
      !Number.isSafeInteger(value.id) ||
      !/^[a-z0-9-]+$/.test(value.slug || "") ||
      typeof value.pem !== "string" ||
      typeof value.client_id !== "string" ||
      typeof value.client_secret !== "string" ||
      value.client_secret.length < 10 ||
      typeof value.webhook_secret !== "string" ||
      value.webhook_secret.length < 10 ||
      Object.entries(githubPermissions).some(
        ([p, level]) => value.permissions?.[p] !== level,
      )
    )
      return res
        .status(400)
        .send("GitHub returned an incomplete app configuration.");
    const key = createPrivateKey(value.pem);
    if (
      key.asymmetricKeyType !== "rsa" ||
      key.asymmetricKeyDetails?.modulusLength < 2048
    )
      return res
        .status(400)
        .send("GitHub returned an invalid app signing key.");
    const updates = {
      githubAppId: value.id,
      githubAppSlug: value.slug,
      githubAppPrivateKey: value.pem,
      githubAppWebhookSecret: value.webhook_secret,
      githubAppClientId: value.client_id,
      githubAppClientSecret: value.client_secret,
    };
    store.setting("provider-settings", {
      ...(store.setting("provider-settings") || {}),
      ...updates,
    });
    Object.assign(config, updates);
    res.redirect("/setup?github_app=registered");
  });
  app.post("/api/setup/save", allowed, (req, res) => {
    const provider = req.body.provider,
      clientId = String(req.body.clientId || "").trim(),
      clientSecret = String(req.body.clientSecret || "").trim();
    if (
      !["github", "railway"].includes(provider) ||
      !/^[a-zA-Z0-9_.-]{5,200}$/.test(clientId) ||
      clientSecret.length < 10 ||
      clientSecret.length > 512 ||
      /\s/.test(clientSecret)
    )
      return res.status(400).json({
        error:
          "Paste the client ID and client secret from the provider app you just registered.",
      });
    const value = {
      ...(store.setting("provider-settings") || {}),
      [provider + "ClientId"]: clientId,
      [provider + "ClientSecret"]: clientSecret,
    };
    store.setting("provider-settings", value);
    config[provider + "ClientId"] = clientId;
    config[provider + "ClientSecret"] = clientSecret;
    res.json(status());
  });
  app.post("/api/setup/finish", allowed, (_req, res) => {
    store.setting("setup-enabled", false);
    res.json({ ok: true });
  });
}
