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
export const creationPermissions = Object.freeze({
  metadata: "read",
  repository_creation: "write",
});
export function creationCredential(config, store, userId) {
  const saved = store.connection(userId, "github_creation");
  const user = store.get("SELECT github_id FROM users WHERE id=?", userId);
  return saved?.appId === String(config.githubAppId) &&
    saved.accountId === user?.github_id &&
    saved.expiresAt > Date.now() + 60000
    ? saved.token
    : null;
}
export async function saveCreationCredential(
  config,
  store,
  userId,
  credentials,
  request,
) {
  const user = store.get("SELECT github_id FROM users WHERE id=?", userId);
  const response = await request(
    `${config.githubApi}/applications/${config.githubAppClientId}/token/scoped`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.githubAppClientId}:${config.githubAppClientSecret}`).toString("base64")}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": "Pocket-Butler",
      },
      body: JSON.stringify({
        access_token: credentials.access_token,
        target_id: Number(user.github_id),
        permissions: creationPermissions,
      }),
      signal: AbortSignal.timeout(30000),
    },
  );
  const value = await response.json();
  // GitHub returns scoped-token grants in the installation envelope.
  const permissions = value.installation?.permissions;
  if (
    !response.ok ||
    !value.token ||
    Object.entries(creationPermissions).some(
      ([key, level]) => permissions?.[key] !== level,
    ) ||
    Object.entries(permissions || {}).some(
      ([key, level]) => level !== "none" && creationPermissions[key] !== level,
    )
  )
    throw Object.assign(accessError(
      "GitHub could not authorize new project creation. Try connecting again.",
      403,
      "creation_scope_failed",
    ), { authDiagnostic: {
      upstreamStatus: response.status,
      hasToken: Boolean(value.token),
      hasInstallation: Boolean(value.installation),
      missingPermissions: Object.entries(creationPermissions)
        .filter(([key, level]) => permissions?.[key] !== level).map(([key]) => key),
      expandedPermissions: Object.keys(githubPermissions)
        .filter((key) => permissions?.[key] && permissions[key] !== "none" && permissions[key] !== creationPermissions[key]),
      messageKind: /installation/i.test(value.message || "") ? "installation"
        : /target/i.test(value.message || "") ? "target"
        : /permission/i.test(value.message || "") ? "permission"
        : /not found/i.test(value.message || "") ? "not_found" : "other",
      validationFields: Array.isArray(value.errors) ? value.errors.flatMap((error) =>
        ["access_token", "target", "target_id", "permissions", "permissions.repository_creation", "permissions.metadata"].includes(error.field) ? [error.field] : [],
      ) : [],
    } });
  const expiresAt = Math.min(
    Date.now() + 3600000,
    value.expires_at ? Date.parse(value.expires_at) : Infinity,
  );
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + 60000)
    throw accessError(
      "GitHub project authorization has expired. Connect again.",
      401,
    );
  store.connection(userId, "github_creation", {
    token: value.token,
    accountId: user.github_id,
    appId: String(config.githubAppId),
    expiresAt,
  });
}
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
export function accessError(message, status = 403, code) {
  return Object.assign(new Error(message), {
    provider: "GitHub",
    status,
    code,
  });
}
const repositoryApproval = () =>
  accessError(
    "Your project files are created. Approve access to this project in GitHub, then return to Butler to continue.",
    403,
    "github_repository_access_required",
  );
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
      throw Object.assign(
        accessError(
          detail.message || "Repository connection failed.",
          response.status,
        ),
        { details: detail.errors },
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
  async function token(userId, repositoryId, permissions, fresh = false) {
    const value = await installation(userId);
    const key = `${config.githubAppId}:${value.id}:${repositoryId || "bootstrap"}:${JSON.stringify(permissions)}`;
    const cached = tokens.get(key);
    if (!fresh && cached?.expires > Date.now() + 90000) return cached.token;
    let created;
    try {
      created = await app(
        `/app/installations/${value.id}/access_tokens`,
        "POST",
        {
          ...(repositoryId ? { repository_ids: [repositoryId] } : {}),
          permissions,
        },
      );
    } catch (error) {
      if (
        repositoryId &&
        error.status === 422 &&
        /not accessible to the parent installation/.test(error.message)
      )
        throw repositoryApproval();
      throw error;
    }
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
      let found;
      try {
        found = await api(`/repos/${repo}`, metadata);
      } catch (error) {
        if (error.status === 404) throw repositoryApproval();
        throw error;
      }
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
    const user = store.get("SELECT * FROM users WHERE id=?", project.owner_id);
    const owner = user.github_login,
      name = `butler-${project.slug}`;
    const saved = store.get(
        "SELECT repo,resources FROM projects WHERE id=?",
        project.id,
      ),
      existing = JSON.parse(saved.resources),
      target = saved.repo || `${owner}/${name}`;
    let found, installed;
    if (saved.repo) {
      try {
        installed = await installation(project.owner_id);
      } catch (error) {
        if (error.status === 401 || error.status === 404)
          throw repositoryApproval();
        throw error;
      }
      const metadata = await token(
        project.owner_id,
        existing.githubRepositoryId || null,
        { metadata: "read" },
        true,
      );
      try {
        found = await api(`/repos/${target}`, metadata);
      } catch (error) {
        if (error.status === 404) throw repositoryApproval();
        throw error;
      }
    } else {
      // Personal repository creation requires a GitHub App USER token, not an installation token.
      const creation = creationCredential(config, store, project.owner_id);
      if (!creation)
        throw accessError(
          "Reconnect GitHub to create your new project.",
          401,
          "github_creation_authorization_required",
        );
      const createApi = async (...args) => {
        try {
          return await api(...args);
        } catch (error) {
          if (error.status === 401) {
            store.run(
              "DELETE FROM connections WHERE user_id=? AND provider='github_creation'",
              project.owner_id,
            );
            throw accessError(
              "Reconnect GitHub to create your new project.",
              401,
              "github_creation_authorization_required",
            );
          }
          throw error;
        }
      };
      try {
        found = await createApi(`/repos/${target}`, creation);
      } catch (error) {
        if (error.status !== 404) throw error;
      }
      if (!found) {
        try {
          found = await createApi("/user/repos", creation, "POST", {
            name,
            private: true,
            auto_init: true,
            description: `Pocket Butler project ${project.id}`,
          });
        } catch (error) {
          if (
            error.status !== 422 ||
            !Array.isArray(error.details) ||
            !error.details.some(
              (item) =>
                item.field === "name" &&
                (item.code === "already_exists" ||
                  /already exists/i.test(item.message || "")),
            )
          )
            throw error;
          // Recover the deterministic repository after a lost successful create response.
          found = await createApi(`/repos/${target}`, creation);
        }
      }
    }
    if (
      found.description !== `Pocket Butler project ${project.id}` ||
      !Number.isSafeInteger(found.id) ||
      String(found.owner?.id) !== user.github_id ||
      found.full_name?.toLowerCase() !== target.toLowerCase() ||
      (existing.githubRepositoryId && existing.githubRepositoryId !== found.id)
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
        ...(installed ? { githubInstallationId: installed.id } : {}),
      }),
      project.id,
    );
    project.repo = found.full_name;
    // Do not seed or provision hosting until access to this newly created repository is approved.
    if (!installed) throw repositoryApproval();
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
