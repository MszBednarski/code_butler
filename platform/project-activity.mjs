export const idleTimeout = 15 * 60 * 1000;

// Worker polling, health checks and deployment maintenance are not human activity.
export function projectActive(store, projectId, at = Date.now()) {
  const project = store.get(
    "SELECT last_active_at,created_at,codex_ready FROM projects WHERE id=?",
    projectId,
  );
  if (!project) return false;
  if (Math.max(project.last_active_at, project.created_at) > at - idleTimeout)
    return true;
  if (
    project.codex_ready &&
    store.get(
      `SELECT id FROM jobs WHERE project_id=? AND state IN ('queued','working','reviewing')
       AND (lease_until>? OR updated_at>?) LIMIT 1`,
      projectId,
      at,
      at - idleTimeout,
    )
  )
    return true;
  return Boolean(
    store.get(
      "SELECT id FROM tasks WHERE project_id=? AND ((state='running' AND kind!='sync-history') OR (state='queued' AND kind IN ('provision','artifact','open-pr','deploy'))) LIMIT 1",
      projectId,
    ),
  );
}
