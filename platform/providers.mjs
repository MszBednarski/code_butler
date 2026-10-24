import { createGithubAccess } from "./github-app.mjs";
export class ProviderError extends Error {
  constructor(provider, status, message) {
    super(`${provider}: ${message}`);
    this.provider = provider;
    this.status = status;
  }
}

export function providers(config, store, { fetch: request = fetch } = {}) {
  const refreshes = new Map();
  async function railwayToken(userId) {
    let saved = store.connection(userId, "railway");
    if (!saved)
      throw new ProviderError("Railway", 401, "Connect Railway to continue.");
    if (saved.expiresAt > Date.now() + 120000) return saved.access_token;
    if (!refreshes.has(userId))
      refreshes.set(
        userId,
        (async () => {
          if (!saved.refresh_token)
            throw new ProviderError(
              "Railway",
              401,
              "Reconnect Railway to continue.",
            );
          const response = await request(
            "https://backboard.railway.com/oauth/token",
            {
              method: "POST",
              headers: {
                Authorization: `Basic ${Buffer.from(`${config.railwayClientId}:${config.railwayClientSecret}`).toString("base64")}`,
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: saved.refresh_token,
              }),
              signal: AbortSignal.timeout(30000),
            },
          );
          const value = await response.json();
          if (!response.ok || !value.access_token)
            throw new ProviderError(
              "Railway",
              401,
              "Reconnect Railway to continue.",
            );
          saved = {
            ...saved,
            ...value,
            expiresAt: Date.now() + value.expires_in * 1000,
          };
          store.connection(userId, "railway", saved);
          return saved.access_token;
        })().finally(() => refreshes.delete(userId)),
      );
    return refreshes.get(userId);
  }
  const githubAccess = createGithubAccess(config, store, request);
  async function railway(userId, query, variables = {}) {
    const response = await request(config.railwayApi, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await railwayToken(userId)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(60000),
    });
    const result = await response.json();
    if (!response.ok || result.errors)
      throw new ProviderError(
        "Railway",
        response.status,
        result.errors?.[0]?.message || "Request failed.",
      );
    return result.data;
  }
  async function worker(project, endpoint, method = "GET", body) {
    if (!project.worker_url) return { state: "provisioning" };
    const response = await request(`${project.worker_url}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${store.open(project.worker_secret)}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new ProviderError(
        "Workspace",
        response.status,
        "Workspace is starting. Please try again shortly.",
      );
    return response.json();
  }
  return { ...githubAccess, railway, railwayToken, worker, request };
}
