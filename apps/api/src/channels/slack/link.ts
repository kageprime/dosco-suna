import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { chatChannelBindings, chatInstalls, projectSessions } from '@kortix/db';
import { db } from '../../shared/db';
import { logger } from '../../lib/logger';
import { projectsView } from '../../workspaces/rows';

/**
 * One Slack workspace, one Kortix workspace.
 *
 * The shared Kortix Slack app has one bot token per Slack workspace. When
 * several Kortix workspaces held that token, every read and write needed a
 * per-channel ownership check (`chat_channel_bindings`), a picker on the first
 * mention, and cross-workspace thread routing. Usage showed every Slack
 * workspace in use talks to one Kortix workspace, so the token now belongs to
 * exactly one: the LINKED install. Agents move through that Slack workspace
 * under their own connector rules; channels are settings, not ownership.
 *
 * The invariant holds in three places:
 *   1. An install moves the link (`moveSlackLink`): the other shared-app
 *      installs of that Slack workspace are detached.
 *   2. Resolution heals what predates the move (`linkedSlackProject`): of
 *      several installs it keeps the one Slack actually used and detaches the
 *      rest, once.
 *   3. The connector gate refuses a call from a Kortix workspace that is not
 *      the linked one (`slackProjectLink`), so a detach that has not run yet
 *      never lets two workspaces read with one token.
 *
 * A Kortix workspace's OWN Slack app (BYO) has its own bot and token, so it is
 * always linked to its Slack workspace. Membership and the own-app flag come
 * from `chat_installs`, which only the install paths write, never from a
 * secret a workspace admin can write.
 */

/** The active Kortix workspaces on the shared app in this Slack workspace, newest install first. */
async function sharedInstalls(teamId: string): Promise<string[]> {
  const rows = await db
    .select({ projectId: chatInstalls.projectId })
    .from(chatInstalls)
    .innerJoin(
      projectsView,
      and(eq(projectsView.projectId, chatInstalls.projectId), eq(projectsView.status, 'active')),
    )
    .where(and(eq(chatInstalls.platform, 'slack'), eq(chatInstalls.platformTeamId, teamId), eq(chatInstalls.ownApp, false)))
    .orderBy(desc(chatInstalls.connectedAt));
  return rows.map((r) => r.projectId);
}

/**
 * Of several installs, the one to keep: the Kortix workspace with the most
 * recent session started from this Slack workspace, else the newest install.
 * Keeps the workspace people actually use; the others had no Slack session.
 */
async function primaryOf(teamId: string, projectIds: string[]): Promise<string> {
  const [used] = await db
    .select({ projectId: projectSessions.projectId })
    .from(projectSessions)
    .where(
      and(
        inArray(projectSessions.projectId, projectIds),
        sql`${projectSessions.metadata}->>'source' = 'slack'`,
        sql`${projectSessions.metadata}->'slack'->>'team_id' = ${teamId}`,
      ),
    )
    .orderBy(desc(projectSessions.createdAt))
    .limit(1);
  return used?.projectId ?? projectIds[0]!;
}

/**
 * Remove a Kortix workspace's shared-app install of one Slack workspace: its
 * install row and Slack secrets, its channel settings there, and the Slack
 * connector they back. Its sessions and their threads stay, as after a
 * disconnect.
 */
/** The Slack workspace a Kortix workspace's stored bot token is for, or null (no token, or Slack did not answer). */
async function slackTokenTeam(projectId: string): Promise<string | null> {
  const { loadSlackTokenForProject } = await import('./installs');
  const token = await loadSlackTokenForProject(projectId);
  if (!token) return null;
  const { authTestTeamId } = await import('../slack-api');
  return authTestTeamId(token);
}

async function detach(teamId: string, projectId: string, reason: string): Promise<void> {
  // This Slack workspace's install only: the Kortix workspace may hold other
  // Slack workspaces. Its Slack secrets are one set per Kortix workspace: they
  // go when their token is this Slack workspace's. Slack says whose it is
  // (`auth.test`), never a secret a member can write. When Slack does not
  // answer, the newest install decides: it wrote the token, as far as the rows
  // know. A wrong guess deletes the other Slack workspace's token, and its
  // admin reinstalls. Keeping it instead could leave this Slack workspace's
  // token behind, and the connector would then post here under the other
  // workspace's link.
  const tokenTeam = await slackTokenTeam(projectId);
  const [newest] = await db
    .select({ teamId: chatInstalls.platformTeamId })
    .from(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'slack'), eq(chatInstalls.projectId, projectId)))
    .orderBy(desc(chatInstalls.connectedAt))
    .limit(1);
  await db
    .delete(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'slack'), eq(chatInstalls.platformTeamId, teamId), eq(chatInstalls.projectId, projectId)));
  if ((tokenTeam ?? newest?.teamId) === teamId) {
    const [ownApp] = await db
      .select({ installId: chatInstalls.installId })
      .from(chatInstalls)
      .where(and(eq(chatInstalls.platform, 'slack'), eq(chatInstalls.projectId, projectId), eq(chatInstalls.ownApp, true)))
      .limit(1);
    const { deleteSlackSecrets } = await import('./installs');
    await deleteSlackSecrets(projectId, { keepSigningSecret: Boolean(ownApp) });
  }
  await db
    .delete(chatChannelBindings)
    .where(
      and(
        eq(chatChannelBindings.platform, 'slack'),
        eq(chatChannelBindings.platformTeamId, teamId),
        eq(chatChannelBindings.projectId, projectId),
      ),
    );
  // Lazy: the connector sync imports the channel modules. Best effort: the
  // install is gone either way, and the next sync removes the connector.
  try {
    const { reconcileChannelConnectors } = await import('../../connectors/sync');
    await reconcileChannelConnectors(projectId);
  } catch (err) {
    logger.warn('[slack-link] the detached Slack connector was not reconciled', { projectId, err: (err as Error)?.message });
  }
  logger.info('[slack-link] detached a Kortix workspace from a Slack workspace', { teamId, projectId, reason });
}

/**
 * The Kortix workspace this Slack workspace is linked to on the shared app,
 * or null when none is. Detaches any other shared-app install it finds.
 */
export async function linkedSlackProject(teamId: string): Promise<string | null> {
  if (!teamId) return null;
  const installs = await sharedInstalls(teamId);
  if (installs.length <= 1) return installs[0] ?? null;
  // Own-app installs are not here (`own_app`): each runs its own bot beside
  // the shared app, and none of them is ever detached by the shared link.
  const primary = await primaryOf(teamId, installs);
  for (const other of installs) {
    if (other === primary) continue;
    await detach(teamId, other, 'one Slack workspace, one Kortix workspace');
  }
  return primary;
}

/**
 * Link this Slack workspace to `projectId`: every other shared-app install of
 * it is detached. Called once the install row exists. Returns the Kortix
 * workspaces it detached, for the install's confirmation.
 */
export async function moveSlackLink(teamId: string, projectId: string): Promise<string[]> {
  const others = (await sharedInstalls(teamId)).filter((id) => id !== projectId);
  for (const other of others) await detach(teamId, other, 'the Slack workspace was installed in another Kortix workspace');
  return others;
}

/**
 * The Slack workspace this Kortix workspace may act in, or null when it may
 * act in none: no install on record, or another Kortix workspace holds the
 * link. The connector gates call it before any Slack read or write.
 */
export async function slackProjectLink(projectId: string): Promise<{ teamId: string } | null> {
  const [row] = await db
    .select({ teamId: chatInstalls.platformTeamId })
    .from(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'slack'), eq(chatInstalls.projectId, projectId)))
    .orderBy(desc(chatInstalls.connectedAt))
    .limit(1);
  if (!row?.teamId) return null;
  return (await holdsSlackWorkspace(projectId, row.teamId)) ? { teamId: row.teamId } : null;
}


/**
 * Does this Kortix workspace hold THIS Slack workspace: its own Slack app is
 * installed there, or it is the shared app's linked install there?
 */
export async function holdsSlackWorkspace(projectId: string, teamId: string): Promise<boolean> {
  const [row] = await db
    .select({ ownApp: chatInstalls.ownApp })
    .from(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'slack'), eq(chatInstalls.projectId, projectId), eq(chatInstalls.platformTeamId, teamId)))
    .limit(1);
  if (!row) return false;
  return row.ownApp || (await linkedSlackProject(teamId)) === projectId;
}

// Records the channel for its settings (the agent and model new threads there
// start with, and the web channel list). It routes nothing: the Slack
// workspace's link decides where every event runs (`linkedSlackProject`). Runs on
// every event, so it inserts only when the row is missing and never reads the
// channel name (the settings page backfills it).
export async function recordSlackChannel(
  projectId: string,
  teamId: string,
  channelId: string,
): Promise<void> {
  if (!projectId || !teamId || !channelId) return;
  // Only a workspace that holds this Slack workspace keeps settings in it.
  if (!(await holdsSlackWorkspace(projectId, teamId))) return;
  const where = and(
    eq(chatChannelBindings.platform, 'slack'),
    eq(chatChannelBindings.platformTeamId, teamId),
    eq(chatChannelBindings.channelId, channelId),
  );
  const inserted = await db
    .insert(chatChannelBindings)
    .values({ platform: 'slack', platformTeamId: teamId, channelId, projectId, pickerTs: null })
    .onConflictDoNothing({
      target: [chatChannelBindings.platform, chatChannelBindings.platformTeamId, chatChannelBindings.channelId],
    })
    .returning({ id: chatChannelBindings.bindingId });
  if (inserted.length > 0) return;
  // A row of another Kortix workspace (or an unanswered picker of the old
  // model) is taken over with its settings cleared: they named that
  // workspace's agents.
  const [row] = await db.select({ projectId: chatChannelBindings.projectId }).from(chatChannelBindings).where(where).limit(1);
  if (!row || row.projectId === projectId) return;
  // One settings row per channel, kept by the workspace that recorded it while
  // it still holds this Slack workspace: an own app's row keeps its agent,
  // model and policy beside the shared app. Each caller reads only its own
  // row (`currentChannelSelection` with its `projectId`) and changes only its
  // own (`other_workspace`). A row of a workspace that no longer holds this
  // Slack workspace is taken over.
  if (row.projectId && (await holdsSlackWorkspace(row.projectId, teamId))) return;
  await db
    .update(chatChannelBindings)
    .set({ projectId, agentName: null, model: null, conversationPolicy: 'project_open', pickerTs: null })
    .where(where);
}
