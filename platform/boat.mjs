export const boatActions = Object.freeze([
  "account.read",
  "sandbox.create",
  "sandbox.read",
  "sandbox.update",
  "sandbox.resume",
  "exec",
  "file.write",
  "host",
]);
const problem = (message, status = 502, code) =>
  Object.assign(new Error(message), { provider: "Boat", status, code });
export function createBoat(config, store, request = fetch) {
  const origin = config.boatOrigin || "https://boat.dev",
    inFlight = new Map(),
    last = new Map();
  async function call(path, method = "GET", body, credential, extra = {}) {
    const response = await request(origin + path, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "Pocket-Butler",
        ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
        ...extra.headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    const value = response.status === 204 ? {} : await response.json();
    if (!response.ok || value.ok === false)
      throw problem(
        value.message ||
          value.error?.message ||
          "Boat could not complete this request.",
        response.status,
        value.code || value.error?.code || value.error,
      );
    return value;
  }
  const token = (user) => {
    const saved = store.connection(user, "boat");
    if (
      !saved?.access_token ||
      !saved.environmentId ||
      !(Date.parse(saved.expiresAt) > Date.now())
    )
      throw problem("Reconnect Boat to continue.", 401);
    return saved.access_token;
  };
  const api = (user, path, method, body, extra) =>
    call("/api/v1" + path, method, body, token(user), extra);
  async function start(user) {
    const connected = store.connection(user, "boat");
    if (connected?.access_token && Date.parse(connected.expiresAt) > Date.now())
      return { state: "connected" };
    const old = store.connection(user, "boat_pending");
    if (old && (old.token || Date.parse(old.expiresAt) > Date.now() + 30000))
      return status(user);
    const value = await call("/api/boat/cli/login/start", "POST", {});
    const url = new URL(value.login_url);
    if (
      url.origin !== origin ||
      typeof value.poll_token !== "string" ||
      typeof value.user_code !== "string" ||
      !Number.isFinite(Date.parse(value.expires_at))
    )
      throw problem("Boat returned an invalid sign-in link.");
    store.connection(user, "boat_pending", {
      url: url.href,
      pollToken: value.poll_token,
      code: value.user_code,
      expiresAt: value.expires_at,
    });
    last.delete(user);
    return status(user);
  }
  async function retireDevice(user, credential) {
    store.transaction(() => {
      store.connection(user, "boat_session_revoke", { token: credential });
      store.run(
        "DELETE FROM connections WHERE user_id=? AND provider='boat_pending'",
        user,
      );
    });
    try {
      await call("/api/boat/auth/logout", "POST", {}, credential);
      store.run(
        "DELETE FROM connections WHERE user_id=? AND provider='boat_session_revoke'",
        user,
      );
    } catch {}
  }
  async function finish(user, pending) {
    const me = await call("/api/v1/me", "GET", undefined, pending.token);
    if (!me.user?.id) throw problem("Boat did not return an account identity.");
    const previous = store.connection(user, "boat");
    if (
      previous?.accountId &&
      previous.accountId !== me.user.id &&
      store.get(
        "SELECT id FROM projects WHERE owner_id=? AND hosting_provider='boat' LIMIT 1",
        user,
      )
    )
      throw problem(
        "Sign in to the Boat account that owns your saved projects.",
        409,
      );
    const limits = await call(
      "/api/v1/limits",
      "GET",
      undefined,
      pending.token,
    );
    const catalog = await call(
      "/api/v1/api-keys",
      "GET",
      undefined,
      pending.token,
    );
    if (catalog.catalog?.scopedCreationEnabled !== true) {
      await retireDevice(user, pending.token);
      throw problem(
        "Boat has not enabled limited API credentials for this account. Butler will not save an unrestricted account key.",
        409,
        "scoped_credentials_unavailable",
      );
    }
    if (!limits.canStart) {
      if (!limits.checkoutRequired)
        throw problem(
          "Boat cannot start a workspace right now. Check your quota or billing in Boat.",
          409,
        );
      if (!pending.billingUrl) {
        const checkout = await billing(user);
        pending = { ...pending, billingUrl: checkout.url };
        store.connection(user, "boat_pending", pending);
      }
      return {
        state: "billing",
        url: pending.billingUrl,
        message:
          "Activate your Boat account to start a workspace. Boat handles card details and any charges on its own checkout page.",
      };
    }
    const name = `butler-${user}`;
    let environment = pending.environment;
    if (!environment) {
      const listed = await call(
        "/api/v1/environments",
        "GET",
        undefined,
        pending.token,
      );
      environment = listed.environments?.find((e) => e.name === name);
      if (!environment) {
        const made = await call(
          "/api/v1/environments",
          "POST",
          { name },
          pending.token,
        );
        environment = made.environments?.find((e) => e.name === name);
      }
      if (!environment?.id)
        throw problem("Boat did not create the Butler environment.");
      await call(
        `/api/v1/environments/${environment.id}`,
        "PUT",
        {
          safeForThirdParties: true,
          passGithub: false,
          passSecrets: false,
          passSandboxCredentials: false,
          passAgentsCredentials: false,
          proxyAiCredentials: false,
          repositories: [],
          envContents: "",
          secretFiles: [],
        },
        pending.token,
      );
      pending = { ...pending, environment: { id: environment.id, name } };
      store.connection(user, "boat_pending", pending);
    }
    const key = await call(
      "/api/v1/api-keys/scoped",
      "POST",
      {
        name: "Pocket Butler",
        ttl: "90d",
        actions: boatActions,
        environmentIds: [pending.environment.id],
      },
      pending.token,
    );
    if (typeof key.secret !== "string" || !key.apiKey?.id)
      throw problem("Boat did not issue a limited credential.");
    const scope = key.apiKey.scope;
    if (
      key.apiKey.credentialLane !== "scoped-v1" ||
      !Array.isArray(scope?.actions) ||
      JSON.stringify([...scope.actions].sort()) !==
        JSON.stringify([...boatActions].sort()) ||
      JSON.stringify(scope.environments) !==
        JSON.stringify([pending.environment.id]) ||
      !Array.isArray(scope.sandboxes) ||
      scope.sandboxes.length ||
      !(Date.parse(key.apiKey.expiresAt) > Date.now())
    ) {
      await call(
        `/api/v1/api-keys/${key.apiKey.id}`,
        "DELETE",
        undefined,
        pending.token,
      ).catch(() => {});
      throw problem("Boat returned unexpected credential permissions.");
    }
    store.connection(user, "boat", {
      access_token: key.secret,
      accountId: me.user.id,
      keyId: key.apiKey.id,
      environmentId: pending.environment.id,
      environmentName: pending.environment.name,
      expiresAt: key.apiKey.expiresAt,
      trial:
        limits.accessTier === "trial" ||
        limits.subscriptionStatus === "trialing",
    });
    await retireDevice(user, pending.token);
    return { state: "connected" };
  }
  async function check(user) {
    const connected = store.connection(user, "boat");
    if (connected?.access_token && Date.parse(connected.expiresAt) > Date.now())
      return { state: "connected" };
    const pending = store.connection(user, "boat_pending");
    if (!pending) return { state: "signed_out" };
    if (!pending.token) {
      if (Date.parse(pending.expiresAt) <= Date.now())
        return {
          state: "expired",
          message: "This Boat sign-in expired. Start again to get a new link.",
        };
      const poll = await call(
        "/api/boat/cli/login/poll/" + encodeURIComponent(pending.pollToken),
      );
      if (typeof poll.token !== "string")
        return {
          state: "pending",
          url: pending.url,
          code: pending.code,
          expiresAt: pending.expiresAt,
        };
      pending.token = poll.token;
      pending.tokenReceivedAt = Date.now();
      store.connection(user, "boat_pending", pending);
    }
    if (
      pending.tokenReceivedAt &&
      Date.now() - pending.tokenReceivedAt > 3600000
    ) {
      await retireDevice(user, pending.token);
      return {
        state: "expired",
        message: "Boat setup expired. Start again to reconnect.",
      };
    }
    return finish(user, pending);
  }
  async function status(user) {
    if (last.get(user)?.until > Date.now()) return last.get(user).value;
    if (!inFlight.has(user))
      inFlight.set(
        user,
        check(user)
          .then((value) => {
            last.set(user, { until: Date.now() + 5000, value });
            return value;
          })
          .finally(() => inFlight.delete(user)),
      );
    return inFlight.get(user);
  }
  async function billing(user) {
    const pending = store.connection(user, "boat_pending");
    if (!pending?.token) throw problem("Sign in to Boat first.", 409);
    const value = await call(
      "/api/boat/billing/checkout",
      "POST",
      { kind: "subscription" },
      pending.token,
    );
    const url = new URL(value.url);
    if (
      url.protocol !== "https:" ||
      !["checkout.stripe.com", "boat.dev"].includes(url.hostname)
    )
      throw problem("Boat returned an invalid billing link.");
    return { url: url.href };
  }
  async function retire() {
    for (const row of store.all(
      "SELECT user_id FROM connections WHERE provider='boat_pending'",
    )) {
      const saved = store.connection(row.user_id, "boat_pending");
      if (
        saved.token &&
        saved.tokenReceivedAt &&
        Date.now() - saved.tokenReceivedAt > 3600000
      )
        await retireDevice(row.user_id, saved.token);
    }
    for (const row of store.all(
      "SELECT user_id FROM connections WHERE provider='boat_session_revoke'",
    )) {
      const saved = store.connection(row.user_id, "boat_session_revoke");
      try {
        await call("/api/boat/auth/logout", "POST", {}, saved.token);
        store.run(
          "DELETE FROM connections WHERE user_id=? AND provider='boat_session_revoke'",
          row.user_id,
        );
      } catch {}
    }
  }
  return {
    boat: api,
    boatToken: token,
    boatAuth: { start, status, billing, retire },
    boatCall: call,
  };
}
