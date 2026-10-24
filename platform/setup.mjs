import { digest } from "./store.mjs";

export function installSetup(app, config, store) {
  const saved = store.setting("provider-settings") || {};
  for (const key of [
    "githubClientId",
    "githubClientSecret",
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
    github: Boolean(config.githubClientId && config.githubClientSecret),
    railway: Boolean(config.railwayClientId && config.railwayClientSecret),
    publicUrl: config.publicUrl,
    railwaySettingsUrl: config.operatorWorkspaceId
      ? `https://railway.com/workspace/${config.operatorWorkspaceId}/settings`
      : "https://railway.com",
  });
  app.post("/api/setup/status", allowed, (_req, res) => res.json(status()));
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
