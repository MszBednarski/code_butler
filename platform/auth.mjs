import { githubAppReady, githubLoginClient } from "./github-app.mjs";
import { token, digest, now, id } from "./store.mjs";

export function cookies(req) {
  const result = Object.create(null);
  for (const part of (req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0)
      result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return result;
}
export function cookie(res, config, name, value, seconds = 30 * 86400) {
  res.append(
    "Set-Cookie",
    `${name}=${value}; HttpOnly; ${config.secure ? "Secure; " : ""}SameSite=Lax; Path=/; Max-Age=${seconds}`,
  );
}
export function publicUser(user) {
  return user
    ? {
        id: user.id,
        name: user.name,
        githubLogin: user.github_login,
        email: user.email,
        isGuest: !user.github_id && !user.email,
      }
    : null;
}
export function safeReturn(value) {
  return typeof value === "string" &&
    /^\/(?:p\/[a-f0-9-]{36}|connect\/boat|start|projects)?$/.test(value)
    ? value
    : "/";
}
function callbackOrigin(req, config) {
  const host = req.get("host");
  return (
    (config.publicAliases || []).find(
      (origin) => new URL(origin).host === host,
    ) || config.publicUrl
  );
}

export function accountForRequest(req, store) {
  const hash = cookies(req).butler_account;
  return typeof hash === "string" && hash.length <= 100
    ? store.get(
        "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires_at>?",
        digest(hash),
        now(),
      )
    : null;
}

export function installAuth(app, config, store, provider) {
  app.use((req, _res, next) => {
    req.account = accountForRequest(req, store);
    next();
  });
  const begin = (name, clientId, authorize, scopes) => (req, res) => {
    const origin = callbackOrigin(req, config);
    if (new URL(origin).host !== req.get("host"))
      return res.redirect(origin + req.originalUrl);
    clientId =
      name === "github" ? githubLoginClient(config).id : config.railwayClientId;
    if (!clientId)
      return res.status(503).json({
        error: `${name === "github" ? "GitHub" : "Railway"} connection has not been configured by the Butler operator yet.`,
      });
    if (name === "railway" && !req.account?.github_id)
      return res.redirect(
        `/auth/github?returnTo=${encodeURIComponent(safeReturn(req.query.returnTo))}`,
      );
    const state = token(),
      browser = token();
    store.run("DELETE FROM oauth_states WHERE created_at<?", now() - 600000);
    store.run(
      "INSERT INTO oauth_states VALUES(?,?,?,?,?,?)",
      digest(state),
      digest(browser),
      req.account?.id || null,
      name,
      safeReturn(req.query.returnTo),
      now(),
    );
    cookie(res, config, `butler_oauth_${name}`, browser, 600);
    const url = new URL(authorize);
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: `${callbackOrigin(req, config)}/auth/${name}/callback`,
      state,
      ...(name === "github" && githubLoginClient(config).app
        ? {}
        : { scope: scopes }),
      ...(name === "railway"
        ? { response_type: "code", prompt: "consent" }
        : {}),
    }).toString();
    res.redirect(url.href);
  };
  app.get(
    "/auth/github",
    begin(
      "github",
      config.githubClientId,
      "https://github.com/login/oauth/authorize",
      "read:user",
    ),
  );
  app.get(
    "/auth/railway",
    begin(
      "railway",
      config.railwayClientId,
      "https://backboard.railway.com/oauth/auth",
      "openid email profile offline_access workspace:admin",
    ),
  );
  for (const name of ["github", "railway"])
    app.get(`/auth/${name}/callback`, async (req, res) => {
      const state =
        typeof req.query.state === "string"
          ? store.get(
              "SELECT * FROM oauth_states WHERE hash=? AND provider=? AND created_at>?",
              digest(req.query.state),
              name,
              now() - 600000,
            )
          : null;
      if (
        !state ||
        digest(cookies(req)[`butler_oauth_${name}`] || "") !==
          state.browser_hash
      )
        return res
          .status(400)
          .send("Sign-in expired. Return to Butler and try again.");
      store.run("DELETE FROM oauth_states WHERE hash=?", state.hash);
      cookie(res, config, `butler_oauth_${name}`, "", 0);
      if (typeof req.query.code !== "string")
        return res.redirect(
          `${state.return_to}?auth_error=Authorization%20was%20not%20completed`,
        );
      try {
        const response = await provider.request(
          name === "github"
            ? "https://github.com/login/oauth/access_token"
            : "https://backboard.railway.com/oauth/token",
          {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/x-www-form-urlencoded",
              ...(name === "railway"
                ? {
                    Authorization: `Basic ${Buffer.from(`${config.railwayClientId}:${config.railwayClientSecret}`).toString("base64")}`,
                  }
                : {}),
            },
            body: new URLSearchParams({
              code: req.query.code,
              redirect_uri: `${callbackOrigin(req, config)}/auth/${name}/callback`,
              ...(name === "github"
                ? {
                    client_id: githubLoginClient(config).id,
                    client_secret: githubLoginClient(config).secret,
                  }
                : { grant_type: "authorization_code" }),
            }),
            signal: AbortSignal.timeout(30000),
          },
        );
        const credentials = await response.json();
        if (!response.ok || !credentials.access_token)
          throw new Error("Authorization was not completed. Please try again.");
        let userId = state.user_id;
        if (name === "github") {
          if (
            String(credentials.scope || "")
              .split(/[ ,]/)
              .some((scope) =>
                /^(repo|public_repo|admin:|write:|delete_repo|workflow)/.test(
                  scope,
                ),
              )
          ) {
            await provider.request(
              `${config.githubApi}/applications/${githubLoginClient(config).id}/grant`,
              {
                method: "DELETE",
                headers: {
                  Authorization: `Basic ${Buffer.from(`${githubLoginClient(config).id}:${githubLoginClient(config).secret}`).toString("base64")}`,
                  "Content-Type": "application/json",
                  "User-Agent": "Pocket-Butler",
                },
                body: JSON.stringify({
                  access_token: credentials.access_token,
                }),
                signal: AbortSignal.timeout(15000),
              },
            );
            throw new Error(
              "An older broad GitHub grant was removed. Sign in again for profile-only access.",
            );
          }
          const me = await provider.request("https://api.github.com/user", {
            headers: {
              Authorization: `Bearer ${credentials.access_token}`,
              "User-Agent": "Pocket-Butler",
              Accept: "application/vnd.github+json",
            },
            signal: AbortSignal.timeout(30000),
          });
          if (!me.ok) throw new Error("Could not read your GitHub profile.");
          const profile = await me.json();
          if (!profile.id || typeof profile.login !== "string")
            throw new Error("Invalid GitHub profile.");
          const existing = store.get(
            "SELECT * FROM users WHERE github_id=?",
            String(profile.id),
          );
          const source = userId
            ? store.get("SELECT * FROM users WHERE id=?", userId)
            : null;
          // Signing into a different GitHub account must not transfer ownership
          // of an existing lead's projects to that account.
          if (source?.github_id && source.github_id !== String(profile.id))
            userId = null;
          if (existing) {
            store.mergeUsers(userId, existing.id);
            userId = existing.id;
          } else {
            if (!userId) userId = store.guest(profile.name || profile.login).id;
            store.revokeAccess(userId);
            store.run(
              "UPDATE users SET github_id=?,github_login=?,name=? WHERE id=?",
              String(profile.id),
              profile.login,
              profile.name || profile.login,
              userId,
            );
          }
          // Sign-in identifies the person; its token is never stored or used for repositories.
        } else {
          if (!userId) throw new Error("Sign in with GitHub first.");
          store.connection(userId, name, {
            ...credentials,
            expiresAt: now() + Number(credentials.expires_in || 3600) * 1000,
          });
        }
        cookie(res, config, "butler_account", store.session(userId));
        res.redirect(state.return_to);
      } catch (error) {
        console.error(`[auth] ${name} callback failed: ${error.name}`);
        res.redirect(
          `${state.return_to}?auth_error=${encodeURIComponent("Connection failed. Please try again.")}`,
        );
      }
    });
  app.get("/auth/github/install", async (req, res) => {
    if (new URL(config.publicUrl).host !== req.get("host"))
      return res.redirect(config.publicUrl + req.originalUrl);
    if (!req.account?.github_id)
      return res.redirect(
        `/auth/github?returnTo=${encodeURIComponent(safeReturn(req.query.returnTo))}`,
      );
    if (!githubAppReady(config))
      return res
        .status(503)
        .send("Butler’s repository integration is being configured.");
    try {
      const current = await provider.app(
        `/users/${encodeURIComponent(req.account.github_login)}/installation`,
      );
      await provider.connect(req.account.id, current.id);
      return res.redirect(safeReturn(req.query.returnTo));
    } catch (error) {
      if (error.status !== 404) {
        if (error.provider)
          return res.redirect(
            `/?auth_error=${encodeURIComponent(error.message + " Update the installation on GitHub, then return to Butler and connect again.")}`,
          );
        throw error;
      }
    }
    const state = token(),
      browser = token();
    store.run("DELETE FROM oauth_states WHERE created_at<?", now() - 600000);
    store.run(
      "INSERT INTO oauth_states VALUES(?,?,?,?,?,?)",
      digest(state),
      digest(browser),
      req.account.id,
      "github-install",
      safeReturn(req.query.returnTo),
      now(),
    );
    cookie(res, config, "butler_oauth_github_install", browser, 600);
    const url = new URL(
      `https://github.com/apps/${config.githubAppSlug}/installations/new`,
    );
    url.searchParams.set("state", state);
    url.searchParams.set("suggested_target_id", req.account.github_id);
    res.redirect(url.href);
  });
  app.get("/auth/github/install/callback", async (req, res) => {
    const state =
      typeof req.query.state === "string"
        ? store.get(
            "SELECT * FROM oauth_states WHERE hash=? AND provider='github-install' AND created_at>?",
            digest(req.query.state),
            now() - 600000,
          )
        : null;
    if (
      !state ||
      state.user_id !== req.account?.id ||
      digest(cookies(req).butler_oauth_github_install || "") !==
        state.browser_hash
    )
      return res
        .status(400)
        .send("Connection expired. Return to Butler and connect GitHub again.");
    store.run("DELETE FROM oauth_states WHERE hash=?", state.hash);
    cookie(res, config, "butler_oauth_github_install", "", 0);
    const installationId = Number(req.query.installation_id);
    if (!Number.isSafeInteger(installationId) || installationId <= 0)
      return res.status(400).send("Invalid GitHub installation.");
    try {
      await provider.connect(req.account.id, installationId);
      res.redirect(state.return_to);
    } catch (error) {
      res.redirect(
        `${state.return_to}?auth_error=${encodeURIComponent(error.provider ? error.message : "GitHub connection failed. Try again.")}`,
      );
    }
  });
  app.post("/api/auth/logout", (req, res) => {
    if (cookies(req).butler_account)
      store.run(
        "DELETE FROM sessions WHERE hash=?",
        digest(cookies(req).butler_account),
      );
    cookie(res, config, "butler_account", "", 0);
    res.json({ ok: true });
  });
  app.post("/api/auth/recovery", (req, res) => {
    if (!req.account)
      return res.status(401).json({ error: "Open your invitation first." });
    const secret = req.account.recovery_secret
      ? store.open(req.account.recovery_secret)
      : token();
    store.run(
      "UPDATE users SET recovery_hash=?,recovery_secret=? WHERE id=?",
      digest(secret),
      store.seal(secret),
      req.account.id,
    );
    res.json({ url: `${config.publicUrl}/recover#token=${secret}` });
  });
  app.post("/api/auth/recover", (req, res) => {
    if (typeof req.body?.token !== "string" || req.body.token.length > 100)
      return res.status(400).json({ error: "Invalid private sign-in link." });
    let user = store.get(
      "SELECT * FROM users WHERE recovery_hash=?",
      digest(req.body.token),
    );
    if (!user || user.merged_into)
      return res.status(403).json({
        error: "This private sign-in link has expired or was replaced.",
      });
    cookie(res, config, "butler_account", store.session(user.id));
    res.json({ ok: true });
  });
  app.post("/api/auth/email", async (req, res) => {
    if (!config.emailKey || !config.emailFrom)
      return res.status(503).json({
        error:
          "Email sign-in is not configured. Save your private sign-in link instead.",
      });
    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
      return res.status(400).json({ error: "Enter a valid email address." });
    const secret = token(),
      target = safeReturn(req.body?.returnTo);
    store.run(
      "INSERT INTO email_links VALUES(?,?,?,?,?)",
      digest(secret),
      email,
      req.account?.id || null,
      target,
      now() + 600000,
    );
    const link = `${config.publicUrl}/email#token=${secret}`;
    const sent = await provider.request("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.emailKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: config.emailFrom,
        to: email,
        subject: "Your Pocket Butler sign-in link",
        text: `Sign in to Pocket Butler: ${link}\n\nThis link expires in 10 minutes. If you did not request it, ignore this email.`,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!sent.ok) {
      store.run("DELETE FROM email_links WHERE hash=?", digest(secret));
      return res
        .status(502)
        .json({ error: "Email could not be sent. Please try again." });
    }
    res.json({ ok: true });
  });
  app.post("/api/auth/email/complete", (req, res) => {
    const link =
      typeof req.body?.token === "string" && req.body.token.length <= 100
        ? store.get(
            "SELECT * FROM email_links WHERE hash=? AND expires_at>?",
            digest(req.body.token),
            now(),
          )
        : null;
    if (!link)
      return res.status(400).json({
        error: "Sign-in link expired. Request a new link from Butler.",
      });
    store.run("DELETE FROM email_links WHERE hash=?", link.hash);
    // Link a guest only in the browser that requested the email. An attacker
    // must not attach a victim's email to an attacker-controlled session.
    const source = req.account?.id === link.user_id ? link.user_id : null;
    let user = store.get(
      "SELECT * FROM users WHERE email=? OR id IN (SELECT user_id FROM email_aliases WHERE email=?) LIMIT 1",
      link.email,
      link.email,
    );
    if (user) store.mergeUsers(source, user.id);
    else {
      user = source
        ? store.get("SELECT * FROM users WHERE id=?", source)
        : store.guest(link.email.split("@")[0]);
      store.revokeAccess(user.id);
      store.run("UPDATE users SET email=? WHERE id=?", link.email, user.id);
    }
    cookie(res, config, "butler_account", store.session(user.id));
    res.json({ returnTo: link.return_to });
  });
}
