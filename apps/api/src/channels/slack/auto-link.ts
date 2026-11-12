import { sql } from 'drizzle-orm';
// The Slack API, the install store and the account emails load on first use:
// every Slack message imports this module, and most never need a link.
import { db } from '../../shared/db';
import { logger } from '../../lib/logger';
import {
  type ChatActor,
  type ChatUser,
  chatUser,
  isAccountMember,
  linkChatIdentity,
  lookupChatIdentity,
  lookupChatUserForKortixUser,
  resolveChatActor,
} from '../core/identity';

/**
 * A Slack person and a Kortix member with the same email are one person: the
 * link between them is made without `/kortix login`.
 *
 * Both sides must have confirmed the address (Slack's `is_email_confirmed`,
 * Kortix's `email_confirmed_at`), and the Kortix user must be a member of the
 * Kortix workspace this Slack workspace is linked to. A Slack admin who could
 * set a member's email already controls who is in that Slack workspace, and
 * a Kortix admin chose to link it, so this trusts nothing new. The link is
 * made without a second factor: an account that requires one still asks for
 * `/kortix login` from a session that passed it: no link is made by email in
 * an account that requires MFA.
 * A live link to another Kortix user is never replaced, and a link its person
 * revoked with `/kortix logout` is never revived: only a Slack person with no
 * link row at all is linked by email (`createOnly`).
 */

/**
 * Does this account require a second factor? A link made by email carries
 * none, and `authorize` lets a super admin past the account-MFA gate, so an
 * email link would act at full authority there: such accounts keep
 * `/kortix login` from a session that passed MFA.
 */
async function accountRequiresMfa(accountId: string): Promise<boolean> {
  try {
    const rows = (await db.execute(
      sql`SELECT mfa_required AS "mfaRequired" FROM kortix.accounts WHERE account_id = ${accountId}::uuid LIMIT 1`,
    )) as unknown as Array<{ mfaRequired: boolean }>;
    // Unknown is treated as required: a missed link only asks for /kortix login.
    return rows[0]?.mfaRequired !== false;
  } catch {
    return true;
  }
}

/** The confirmed, live Kortix user with this email, or null (none, banned, deleted, or more than one). */
async function kortixUserByEmail(email: string): Promise<string | null> {
  try {
    const rows = (await db.execute(
      sql`SELECT id::text AS id FROM auth.users
          WHERE lower(email) = ${email} AND email_confirmed_at IS NOT NULL
            AND deleted_at IS NULL AND (banned_until IS NULL OR banned_until <= now())
          LIMIT 2`,
    )) as unknown as Array<{ id: string }>;
    return rows.length === 1 ? rows[0]!.id : null;
  } catch {
    return null;
  }
}

/** Link a Slack person to the Kortix member with their confirmed email. True when a link was made. */
export async function autoLinkSlackPerson(input: {
  teamId: string;
  slackUserId: string;
  accountId: string;
  token: string;
}): Promise<boolean> {
  const { slackConfirmedEmail } = await import('../slack-api');
  const email = await slackConfirmedEmail(input.token, input.slackUserId);
  if (!email) return false;
  const userId = await kortixUserByEmail(email);
  if (!userId || !(await isAccountMember(userId, input.accountId))) return false;
  if (await accountRequiresMfa(input.accountId)) return false;
  const linked = await linkChatIdentity(chatUser('slack', input.teamId, input.slackUserId), userId, { createOnly: true });
  if (linked.ok) logger.info('[slack-auto-link] linked a Slack person by confirmed email', { teamId: input.teamId });
  return linked.ok;
}

/**
 * The Slack person a Kortix user is in this Slack workspace: the live link,
 * else the person with their confirmed email (linked on the way). Null when
 * there is none.
 */
export async function slackPersonForKortixUser(input: {
  teamId: string;
  userId: string;
  token: string;
  /** The Kortix workspace the link is for: no link is made in an account that requires MFA. */
  projectId?: string;
}): Promise<string | null> {
  const linked = await lookupChatUserForKortixUser('slack', input.teamId, input.userId);
  if (linked) return linked;
  const { lookupEmailsByUserIds } = await import('../../accounts/core/owner-emails');
  const { slackPersonByEmail } = await import('../slack-api');
  const email = (await lookupEmailsByUserIds([input.userId])).get(input.userId)?.trim().toLowerCase();
  // Only a confirmed Kortix address counts, and only as this user's own.
  if (!email || (await kortixUserByEmail(email)) !== input.userId) return null;
  const slackUserId = await slackPersonByEmail(input.token, email);
  if (!slackUserId) return null;
  // A requester link reads private Slack content for its person: none made
  // without a second factor in an account that requires one.
  const { accountKeyOfWorkspace } = await import('../../workspaces/rows');
  const projectAccount = input.projectId ? await accountKeyOfWorkspace(input.projectId) : null;
  if (!projectAccount || (await accountRequiresMfa(projectAccount))) return null;
  const result = await linkChatIdentity(chatUser('slack', input.teamId, slackUserId), input.userId, { createOnly: true });
  // That Slack person is linked to someone else, or logged out: they are not this user here.
  return result.ok ? slackUserId : null;
}

/**
 * Link an unlinked Slack person of `projectId`'s Slack workspace by confirmed
 * email. False when they are linked already (a link without a second factor
 * stays for `/kortix login`), have no matching member, or anything fails: a
 * missed link only asks them to log in, as before. Logged out counts as linked:
 * they log in again with `/kortix login`.
 */
export async function linkSlackPersonByEmail(user: ChatUser, projectId: string, accountId?: string): Promise<boolean> {
  if (user.platform !== 'slack' || !user.workspaceId || !user.platformUserId) return false;
  try {
    if (await lookupChatIdentity(user)) return false;
    const { accountKeyOfWorkspace } = await import('../../workspaces/rows');
    const account = accountId ?? (await accountKeyOfWorkspace(projectId));
    const { loadSlackTokenForProject } = await import('../install-store');
    const token = account ? await loadSlackTokenForProject(projectId) : null;
    if (!account || !token) return false;
    return await autoLinkSlackPerson({ teamId: user.workspaceId, slackUserId: user.platformUserId, accountId: account, token });
  } catch (err) {
    logger.warn('[slack-auto-link] linking by email failed; the person is asked to log in', { err: (err as Error)?.message });
    return false;
  }
}

/**
 * `resolveChatActor` for a Slack person, who needs no `/kortix login` when
 * their confirmed email is a member's: an unlinked person is linked by email
 * once, then resolved again.
 */
export async function resolveSlackActor(
  user: ChatUser,
  project: { projectId: string; accountId: string },
  action?: string,
): Promise<ChatActor> {
  const actor = await resolveChatActor(user, project, action);
  if (!('reason' in actor) || actor.reason !== 'unlinked') return actor;
  return (await linkSlackPersonByEmail(user, project.projectId, project.accountId))
    ? resolveChatActor(user, project, action)
    : actor;
}
