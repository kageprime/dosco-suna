/**
 * THE rule for reading a grant's scope (Workspaces R2a, design.md §4 step 7).
 *
 * Release 2b step 11 rewrites `kortix.role_assignments` to one scope,
 * `scope_type = 'workspace'` with `scope_id = <workspace id>`, and the stored
 * action strings to their `workspace.*` names. R2a and R2b pods run side by
 * side, so every reader here already reads that form:
 *
 *   - a `workspace` row with no object whose role is an account role
 *     (`roles.scope_type = 'account'`) is an ACCOUNT grant on its `account_id`;
 *   - every other `workspace` row (a project role, a custom project role, an
 *     object grant) is a PROJECT grant on `scope_id` (the workspace id is the
 *     project id).
 *
 * The canonical writer refuses a non-object assignment whose scope differs
 * from its role's (`assignments.ts`), so the role's scope decides without
 * ambiguity. Today no row has the workspace form: each predicate below is the
 * old one OR a disjunct that is false for every existing row, so no verdict
 * changes before R2b. The same predicates are in the views
 * (`20261114162256000_role_assignments_workspace_scope.sql`).
 *
 * A stored action string is read through `storedAction` (`toLegacyAction`), so a
 * renamed `workspace.*` row equals the legacy name the engine compares.
 */
import { roleAssignments, iamRoles } from '@kortix/db';
import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { toLegacyAction } from '@kortix/shared/workspace-actions';
import { qualifiedColumn } from '../shared/sql-qualified-column';

/** The scope a grant row reads as. */
export type GrantScope = 'account' | 'project';

/** The three columns the rule reads. */
export interface GrantScopeColumns {
  scopeType: SQLWrapper;
  objectType: SQLWrapper;
  /** The role's own `roles.scope_type`. */
  roleScopeType: SQLWrapper;
}

/** The scope one fetched row reads as; `null` for a value no release writes. Pure. */
export function grantScopeOf(row: {
  scopeType: string;
  roleScopeType?: string | null;
  objectType?: string | null;
}): GrantScope | null {
  if (row.scopeType === 'account' || row.scopeType === 'project') return row.scopeType;
  if (row.scopeType !== 'workspace') return null;
  if (row.objectType) return 'project';
  return row.roleScopeType === 'account' ? 'account' : 'project';
}

/** The `scope_id` a read model reports: NULL for an account grant, as the legacy form stores it. Pure. */
export function grantScopeIdOf(row: {
  scopeType: string;
  scopeId: string | null;
  roleScopeType?: string | null;
  objectType?: string | null;
}): string | null {
  return grantScopeOf(row) === 'account' ? null : row.scopeId;
}

/** SQL: the row is an account grant. Index-friendly: `scope_type IN (…)` first. */
export function accountScopeSql(c: GrantScopeColumns): SQL {
  return sql`(${c.scopeType} IN ('account', 'workspace') AND (${c.scopeType} = 'account' OR (${c.objectType} IS NULL AND ${c.roleScopeType} = 'account')))`;
}

/** SQL: the row is a project grant (its `scope_id` is the project / workspace id). */
export function projectScopeSql(c: GrantScopeColumns): SQL {
  return sql`(${c.scopeType} IN ('project', 'workspace') AND (${c.scopeType} = 'project' OR ${c.objectType} IS NOT NULL OR ${c.roleScopeType} <> 'account'))`;
}

/** `role_assignments` joined with `roles` (`iamRoles`) in the same query. */
const JOINED: GrantScopeColumns = {
  scopeType: roleAssignments.scopeType,
  objectType: roleAssignments.objectType,
  roleScopeType: iamRoles.scopeType,
};

/** `role_assignments` with no `roles` join: the role's scope by a correlated subquery. */
function unjoined(): GrantScopeColumns {
  return {
    scopeType: roleAssignments.scopeType,
    objectType: roleAssignments.objectType,
    roleScopeType: sql`(SELECT wsr.scope_type FROM kortix.roles wsr WHERE wsr.role_id = ${qualifiedColumn(roleAssignments.roleId)})`,
  };
}

/** Account grants, in a Drizzle query that joins `iamRoles`. */
export const accountScoped = (): SQL => accountScopeSql(JOINED);
/** Project grants, in a Drizzle query that joins `iamRoles`. */
export const projectScoped = (): SQL => projectScopeSql(JOINED);
/** Account grants, in a Drizzle query on `role_assignments` alone. */
export const accountScopedNoJoin = (): SQL => accountScopeSql(unjoined());
/** Project grants, in a Drizzle query (or DELETE) on `role_assignments` alone. */
export const projectScopedNoJoin = (): SQL => projectScopeSql(unjoined());
/**
 * Object grants (`object_type IS NOT NULL`) are always project grants, so a
 * query that filters on an object needs no role join.
 */
export const objectGrantScoped = (): SQL => sql`${roleAssignments.scopeType} IN ('project', 'workspace')`;

/** A stored action string (`role_permissions.action`, `permissions.action`, `implies`), as the engine compares it. */
export const storedAction = (action: string): string => toLegacyAction(action);
