import { eq, ilike, or, sql } from 'drizzle-orm';
import { accountIdsWithMemberEmailLikeSql } from '../iam/membership-read';
import { qualifiedColumn } from '../shared/sql-qualified-column';
import { escapeLike } from '../shared/sql-like';
import { isUuid } from '../shared/validate';
import { accountsView, projectsView } from '../workspaces/rows';

/**
 * Shared search predicate for the fleet projects page and its filtered count:
 * the project name, the account name or any member's email contains the term,
 * or the term is the project id or the account id (exact). An operator holding
 * a workspace link has only its id.
 */
export function adminProjectsSearchCondition(search: string) {
  const pattern = `%${escapeLike(search)}%`;
  const id = search.trim().toLowerCase();
  return or(
    ilike(projectsView.name, pattern),
    ilike(accountsView.name, pattern),
    sql`${qualifiedColumn(projectsView.accountId)} IN (${accountIdsWithMemberEmailLikeSql(pattern)})`,
    ...(isUuid(id) ? [eq(projectsView.projectId, id), eq(projectsView.accountId, id)] : []),
  );
}
