import { sign } from "node:crypto";

export const githubPermissions = Object.freeze({
  metadata: "read",
  contents: "write",
  pull_requests: "write",
  statuses: "write",
  checks: "read",
  repository_creation: "write",
});
export const repositoryPermissions = Object.freeze(
  Object.fromEntries(
    Object.entries(githubPermissions).filter(
      ([name]) => name !== "repository_creation",
    ),
  ),
);
export const githubAppReady = (config) =>
  Boolean(
    config.githubAppId &&
    config.githubAppSlug &&
    config.githubAppPrivateKey &&
    config.githubAppWebhookSecret,
  );
export const githubLoginClient = (config) =>
  config.githubAppClientId && config.githubAppClientSecret
    ? {
        id: config.githubAppClientId,
        secret: config.githubAppClientSecret,
        app: true,
      }
    : {
        id: config.githubClientId,
        secret: config.githubClientSecret,
        app: false,
      };
export function githubJwt(config) {
  const at = Math.floor(Date.now() / 1000);
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: at - 60, exp: at + 540, iss: String(config.githubAppId) })}`;
  return `${body}.${sign("RSA-SHA256", Buffer.from(body), config.githubAppPrivateKey).toString("base64url")}`;
}
export function accessError(message, status = 403) {
  return Object.assign(new Error(message), { provider: "GitHub", status });
}
export function validateInstallation(config, user, installation) {
  if (
    String(installation.app_id) !== String(config.githubAppId) ||
    String(installation.account?.id) !== String(user.github_id) ||
    installation.account?.type !== "User" ||
    installation.suspended_at
  )
    throw accessError(
      "Install Butler on your own GitHub account to connect this team.",
    );
  if (installation.repository_selection !== "selected")
    throw accessError(
      "Choose Only select repositories in Butler’s GitHub installation settings. Butler does not accept access to all repositories.",
    );
  for (const [permission, level] of Object.entries(
    installation.permissions || {},
  ))
    if (level !== "none" && githubPermissions[permission] !== level)
      throw accessError(
        "This GitHub installation has extra permissions. Restore Butler’s limited app permissions before connecting.",
      );
  for (const [permission, level] of Object.entries(githubPermissions))
    if (installation.permissions?.[permission] !== level)
      throw accessError(
        "Approve Butler’s required project permissions in GitHub before connecting.",
      );
  return installation;
}

export function createGithubAccess(config, store, request = fetch) {
  const tokens = new Map();
  async function api(endpoint, credential, method = "GET", body, raw = false) {
    const response = await request(`${config.githubApi}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${credential}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        "Content-Type": "application/json",
        "User-Agent": "Pocket-Butler",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(raw ? 120000 : 30000),
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw accessError(
        detail.message || "Repository connection failed.",
        response.status,
      );
    }
    if (raw) return response;
    return response.status === 204 ? null : response.json();
  }
  const app = (endpoint, method, body) => {
    if (!githubAppReady(config))
      throw accessError(
        "Butler’s repository integration is being configured.",
        503,
      );
    return api(endpoint, githubJwt(config), method, body);
  };
  async function installation(userId) {
    const saved = store.connection(userId, "github_installation"),
      user = store.get("SELECT * FROM users WHERE id=?", userId);
    if (!saved || !user?.github_id)
      throw accessError("Connect Butler’s repository access to continue.", 401);
    return validateInstallation(
      config,
      user,
      await app(`/app/installations/${saved.id}`),
    );
  }
  async function connect(userId, installationId) {
    const user = store.get("SELECT * FROM users WHERE id=?", userId);
    const value = validateInstallation(
      config,
      user,
      await app(`/app/installations/${installationId}`),
    );
    store.connection(userId, "github_installation", {
      id: value.id,
      accountId: value.account.id,
      accountLogin: value.account.login,
    });
    return value;
  }
  async function token(userId, repositoryId, permissions) {
    const value = await installation(userId);
    const key = `${config.githubAppId}:${value.id}:${repositoryId || "bootstrap"}:${JSON.stringify(permissions)}`;
    const cached = tokens.get(key);
    if (cached?.expires > Date.now() + 90000) return cached.token;
    const created = await app(
      `/app/installations/${value.id}/access_tokens`,
      "POST",
      {
        ...(repositoryId ? { repository_ids: [repositoryId] } : {}),
        permissions,
      },
    );
    if (!created.token || !Number.isFinite(Date.parse(created.expires_at)))
      throw accessError(
        "GitHub did not issue a valid short-lived repository credential.",
        502,
      );
    tokens.set(key, {
      token: created.token,
      expires: Date.parse(created.expires_at),
    });
    return created.token;
  }
  async function repositoryToken(userId, repo) {
    const project = store.get(
      "SELECT * FROM projects WHERE owner_id=? AND repo=? COLLATE NOCASE",
      userId,
      repo,
    );
    if (!project)
      throw accessError(
        "This repository is not assigned to your Butler project.",
      );
    let resources = JSON.parse(project.resources);
    const installed = await installation(userId);
    if (
      !Number.isSafeInteger(resources.githubRepositoryId) ||
      !resources.githubRepositoryId ||
      resources.githubInstallationId !== installed.id
    ) {
      const metadata = await token(userId, null, { metadata: "read" });
      const found = await api(`/repos/${repo}`, metadata);
      if (
        !Number.isSafeInteger(found.id) ||
        found.owner?.id !== installed.account.id ||
        found.full_name?.toLowerCase() !== repo.toLowerCase() ||
        (resources.githubRepositoryId &&
          resources.githubRepositoryId !== found.id)
      )
        throw accessError(
          "The selected GitHub repository does not match this saved project.",
          409,
        );
      resources = {
        ...JSON.parse(
          store.get("SELECT resources FROM projects WHERE id=?", project.id)
            .resources,
        ),
        githubRepositoryId: found.id,
        githubInstallationId: installed.id,
      };
      store.run(
        "UPDATE projects SET resources=? WHERE id=?",
        JSON.stringify(resources),
        project.id,
      );
    }
    return token(userId, resources.githubRepositoryId, repositoryPermissions);
  }
  async function github(userId, endpoint, method = "GET", body, raw = false) {
    const match = /^\/repos\/([a-z\d_.-]+\/[a-z\d_.-]+)(?:\/|$)/i.exec(
      endpoint,
    );
    if (!match)
      throw accessError("Only this project’s repository can be accessed.");
    return api(
      endpoint,
      await repositoryToken(userId, match[1]),
      method,
      body,
      raw,
    );
  }
  async function createRepository(project) {
    const installed = await installation(project.owner_id);
    const owner = installed.account.login,
      name = `butler-${project.slug}`;
    let found;
    const metadata = await token(project.owner_id, null, { metadata: "read" });
    try {
      found = await api(`/repos/${owner}/${name}`, metadata);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    if (!found) {
      const creation = await token(project.owner_id, null, {
        metadata: "read",
        repository_creation: "write",
      });
      found = await api("/user/repos", creation, "POST", {
        name,
        private: true,
        auto_init: true,
        description: `Pocket Butler project ${project.id}`,
      });
    }
    if (
      found.description !== `Pocket Butler project ${project.id}` ||
      !Number.isSafeInteger(found.id) ||
      found.owner?.id !== installed.account.id
    )
      throw accessError(
        "A different repository already has this project name.",
        409,
      );
    const current = JSON.parse(
      store.get("SELECT resources FROM projects WHERE id=?", project.id)
        .resources,
    );
    store.run(
      "UPDATE projects SET repo=?,resources=? WHERE id=?",
      found.full_name,
      JSON.stringify({
        ...current,
        githubRepositoryId: found.id,
        githubInstallationId: installed.id,
      }),
      project.id,
    );
    project.repo = found.full_name;
    return found;
  }
  return {
    app,
    connect,
    installation,
    repositoryToken,
    createRepository,
    github,
  };
}

export async function retireLegacyGithub(config, store, request = fetch) {
  const rows = store.all(
    "SELECT user_id FROM connections WHERE provider='github'",
  );
  let revoked = 0,
    pending = 0;
  for (const row of rows) {
    const saved = store.connection(row.user_id, "github");
    if (!saved?.access_token) {
      store.run(
        "DELETE FROM connections WHERE user_id=? AND provider='github'",
        row.user_id,
      );
      continue;
    }
    // Quarantine before network I/O: old grants are never used for app work.
    store.connection(row.user_id, "github_legacy_revoke", saved);
    store.run(
      "DELETE FROM connections WHERE user_id=? AND provider='github'",
      row.user_id,
    );
  }
  for (const row of store.all(
    "SELECT user_id FROM connections WHERE provider='github_legacy_revoke'",
  )) {
    const saved = store.connection(row.user_id, "github_legacy_revoke");
    try {
      const response = await request(
        `${config.githubApi}/applications/${config.githubClientId}/grant`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Basic ${Buffer.from(`${config.githubClientId}:${config.githubClientSecret}`).toString("base64")}`,
            "Content-Type": "application/json",
            Accept: "application/vnd.github+json",
            "User-Agent": "Pocket-Butler",
          },
          body: JSON.stringify({ access_token: saved.access_token }),
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!response.ok && ![404, 422].includes(response.status))
        throw new Error("Revocation interrupted");
      store.run(
        "DELETE FROM connections WHERE user_id=? AND provider='github_legacy_revoke'",
        row.user_id,
      );
      revoked++;
    } catch {
      pending++;
    }
  }
  return { revoked, pending };
}
