// Read model of account groups: `kortix.account_groups` and
// `kortix.group_members`. Every group read outside iam/ goes through here.
//
// One reader per table and projection family (KRTX-4587): a caller that
// needs one field reads it off the full row, it does not add a new export.
import { accountGroupMembers, accountGroups, accountMembers } from '@kortix/db';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../shared/db';

/** The ids of every group the user is in, across accounts. */
export function groupIdsOfUser(userId: string) {
  return db
    .select({ groupId: accountGroupMembers.groupId })
    .from(accountGroupMembers)
    .where(eq(accountGroupMembers.userId, userId));
}

/** The user ids in one group. */
export function groupMemberUserIds(groupId: string) {
  return db
    .select({ userId: accountGroupMembers.userId })
    .from(accountGroupMembers)
    .where(eq(accountGroupMembers.groupId, groupId));
}

/** `(groupId, userId)` pairs of the groups. */
export function groupMemberRows(groupIds: string[]) {
  return db
    .select({ groupId: accountGroupMembers.groupId, userId: accountGroupMembers.userId })
    .from(accountGroupMembers)
    .where(inArray(accountGroupMembers.groupId, groupIds));
}

/** Every (user, group, group name) membership of the account's groups. */
export function accountGroupMembershipRows(accountId: string) {
  return db
    .select({
      userId: accountGroupMembers.userId,
      groupId: accountGroups.groupId,
      name: accountGroups.name,
    })
    .from(accountGroupMembers)
    .innerJoin(accountGroups, eq(accountGroupMembers.groupId, accountGroups.groupId))
    .where(eq(accountGroups.accountId, accountId));
}

/** The members of the groups that are in the account, with the super-admin flag. */
export function groupMemberAccountRows(accountId: string, groupIds: string[]) {
  return db
    .select({
      groupId: accountGroupMembers.groupId,
      isSuperAdmin: accountMembers.isSuperAdmin,
      userId: accountMembers.userId,
    })
    .from(accountGroupMembers)
    .innerJoin(
      accountMembers,
      and(
        eq(accountMembers.userId, accountGroupMembers.userId),
        eq(accountMembers.accountId, accountId),
      ),
    )
    .where(inArray(accountGroupMembers.groupId, groupIds));
}

/** The account's SCIM-sourced groups the user is in. */
export function scimGroupIdsOfUser(accountId: string, userId: string) {
  return db.select({ groupId: accountGroups.groupId }).from(accountGroups)
    .innerJoin(accountGroupMembers, eq(accountGroupMembers.groupId, accountGroups.groupId))
    .where(and(eq(accountGroups.accountId, accountId), eq(accountGroups.source, 'scim'), eq(accountGroupMembers.userId, userId)));
}

/** A group's members, oldest first, at most `cap` rows. */
export function groupMemberListRows(groupId: string, cap: number) {
  return db
    .select({
      groupId: accountGroupMembers.groupId,
      userId: accountGroupMembers.userId,
      addedAt: accountGroupMembers.addedAt,
      addedBy: accountGroupMembers.addedBy,
    })
    .from(accountGroupMembers)
    .where(eq(accountGroupMembers.groupId, groupId))
    .orderBy(asc(accountGroupMembers.addedAt))
    .limit(cap);
}

/** The account's groups the user is in, by name. */
export function groupsForMemberRows(accountId: string, userId: string) {
  return db
    .select({
      groupId: accountGroups.groupId,
      name: accountGroups.name,
      addedAt: accountGroupMembers.addedAt,
    })
    .from(accountGroupMembers)
    .innerJoin(accountGroups, eq(accountGroups.groupId, accountGroupMembers.groupId))
    .where(and(eq(accountGroups.accountId, accountId), eq(accountGroupMembers.userId, userId)))
    .orderBy(asc(accountGroups.name));
}

/** The account's groups by name, with member and project counts. */
export function accountGroupListRows(accountId: string) {
  return db
    .select({
      groupId: accountGroups.groupId,
      accountId: accountGroups.accountId,
      name: accountGroups.name,
      description: accountGroups.description,
      source: accountGroups.source,
      externalId: accountGroups.externalId,
      createdAt: accountGroups.createdAt,
      updatedAt: accountGroups.updatedAt,
      // IMPORTANT: hard-code the outer table reference in these correlated
      // subqueries. Drizzle's ${accountGroups.groupId} interpolation emits
      // the bare "group_id" without a table prefix, so Postgres resolves
      // both sides of `WHERE x.group_id = "group_id"` to the inner alias
      // and the filter degenerates to `WHERE TRUE` — counts come back as
      // table-wide totals. Aliasing the inner table doesn't help; we need
      // the OUTER reference to be unambiguously kortix.account_groups.
      memberCount: sql<number>`(
        SELECT COUNT(*)::int FROM kortix.account_group_members agm
        WHERE agm.group_id = kortix.account_groups.group_id
      )`,
      projectCount: sql<number>`(
        SELECT COUNT(*)::int FROM kortix.project_group_grants pgg
        WHERE pgg.group_id = kortix.account_groups.group_id
      )`,
    })
    .from(accountGroups)
    .where(eq(accountGroups.accountId, accountId))
    .orderBy(asc(accountGroups.name));
}

/** The full group row; `accountId` null reads by group id alone. */
export function groupRow(accountId: string | null, groupId: string) {
  return db
    .select()
    .from(accountGroups)
    .where(
      and(
        ...(accountId === null ? [] : [eq(accountGroups.accountId, accountId)]),
        eq(accountGroups.groupId, groupId),
      ),
    )
    .limit(1);
}

/**
 * The full rows of `groupIds`, or of every group of the account, ordered by
 * name. The callers keep their `length > 0` guard: an empty array still
 * builds an `inArray`, it never means "no fence".
 */
export function groupRows(opts: { accountId?: string; groupIds?: string[] }) {
  return db
    .select()
    .from(accountGroups)
    .where(
      and(
        ...(opts.accountId ? [eq(accountGroups.accountId, opts.accountId)] : []),
        ...(opts.groupIds ? [inArray(accountGroups.groupId, opts.groupIds)] : []),
      ),
    )
    .orderBy(asc(accountGroups.name));
}

/** The ids of every group of the account. */
export function accountGroupIds(accountId: string) {
  return db
    .select({ groupId: accountGroups.groupId })
    .from(accountGroups)
    .where(eq(accountGroups.accountId, accountId));
}

/** The account's SSO-sourced group with this name. */
export function ssoGroupByNameRow(accountId: string, name: string) {
  return db
    .select({ groupId: accountGroups.groupId })
    .from(accountGroups)
    .where(
      and(
        eq(accountGroups.accountId, accountId),
        eq(accountGroups.name, name),
        eq(accountGroups.source, 'sso'),
      ),
    )
    .limit(1);
}
