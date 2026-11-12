/**
 * Bind a credential the way the trigger expects: project row first.
 *
 * `guard_archived_project_session_token` (migration 20261020154500000) runs on
 * every `UPDATE kortix.account_tokens` that changes `session_id`, `project_id`,
 * `account_id`, `status` or `revoked_at` of an active session token. It locks
 * the token's project row `FOR SHARE NOWAIT` and fails closed (55P03) while
 * another connection holds that row, such as the config summary build after
 * project creation. A raw fixture UPDATE lost that race under parallel flows
 * (GH-17, SCOPE-2, 2026-11-09).
 *
 * `lockProjectFirst` rewrites such an UPDATE so the same statement first takes
 * `FOR SHARE` on the project row with a blocking wait (the order archive uses:
 * project, then token). The trigger's NOWAIT then finds the share lock this
 * statement already holds. No sleep, no retry.
 *
 * The project is the `project_id = $n` the UPDATE sets, else the token's
 * current project (`token_id = $n` in its WHERE). The lock never filters rows:
 * the count is always >= 0, so a token without a project still updates.
 */
export function lockProjectFirst(update: string): string {
  const where = update.search(/\bWHERE\b/i);
  if (!/^\s*UPDATE\s+kortix\.account_tokens\b/i.test(update) || where < 0) {
    throw new Error(`lockProjectFirst expects an UPDATE kortix.account_tokens … WHERE …: ${update}`);
  }
  const set = update.slice(0, where);
  const setProject = /\bproject_id\s*=\s*(\$\d+)/i.exec(set)?.[1];
  const token = /\btoken_id\s*=\s*(\$\d+)/i.exec(update.slice(where))?.[1];
  const project = setProject
    ? `${setProject}::uuid`
    : token
      ? `(SELECT t0.project_id FROM kortix.account_tokens t0 WHERE t0.token_id = ${token}::uuid)`
      : null;
  if (!project) throw new Error(`lockProjectFirst cannot tell which project this UPDATE binds: ${update}`);
  const condition = update.slice(where).replace(/^WHERE\b/i, '').trim();
  return `WITH locked AS (SELECT 1 FROM kortix.projects WHERE project_id = ${project} FOR SHARE)
${set.trim()}
 WHERE (${condition}) AND (SELECT count(*) FROM locked) >= 0`;
}
