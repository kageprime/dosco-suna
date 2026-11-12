import { chatInstalls, projectSecrets } from '@kortix/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import {
  deleteProjectSecrets,
  readSecret,
  upsertSecret,
} from '../install-store';

export const SLACK_BOT_TOKEN = 'SLACK_BOT_TOKEN';
export const SLACK_SIGNING_SECRET = 'SLACK_SIGNING_SECRET';
export const SLACK_TEAM_ID = 'SLACK_TEAM_ID';
export const SLACK_BOT_USER_ID = 'SLACK_BOT_USER_ID';
export const SLACK_TEAM_NAME = 'SLACK_TEAM_NAME';
/** The install's bot id (`auth.test`), resolved on first use: keys the self-loop guard for agent-named posts. */
export const SLACK_BOT_ID = 'SLACK_BOT_ID';

const SLACK_KEYS = [
  SLACK_BOT_TOKEN,
  SLACK_SIGNING_SECRET,
  SLACK_TEAM_ID,
  SLACK_BOT_USER_ID,
  SLACK_TEAM_NAME,
  SLACK_BOT_ID,
] as const;

export interface SlackInstallSummary {
  workspaceId: string;
  workspaceName: string | null;
  botUserId: string | null;
  installedAt: string;
}

export interface SlackInstallInput {
  projectId: string;
  botToken: string;
  signingSecret: string;
  teamId: string;
  teamName: string | null;
  botUserId: string;
}

interface SlackOauthInstallInput {
  projectId: string;
  workspaceId: string;
  botToken: string;
  botUserId: string;
  teamName: string | null;
}

export async function saveSlackInstall(input: SlackInstallInput): Promise<SlackInstallSummary> {
  const { projectId } = input;
  // The workspace's own Slack app: its own bot and token (slack/link.ts).
  await db
    .insert(chatInstalls)
    .values({
      platform: 'slack',
      platformTeamId: input.teamId,
      projectId,
      ownApp: true,
    })
    .onConflictDoUpdate({
      target: [chatInstalls.platform, chatInstalls.platformTeamId, chatInstalls.projectId],
      // A reinstall is the newest install: it wrote the secrets (slack/link.ts).
      set: { ownApp: true, connectedAt: new Date() },
    });
  await upsertSecret(projectId, SLACK_BOT_TOKEN, input.botToken);
  await upsertSecret(projectId, SLACK_SIGNING_SECRET, input.signingSecret);
  await upsertSecret(projectId, SLACK_TEAM_ID, input.teamId);
  await upsertSecret(projectId, SLACK_BOT_USER_ID, input.botUserId);
  await upsertSecret(projectId, SLACK_TEAM_NAME, input.teamName ?? '');
  return {
    workspaceId: input.teamId,
    workspaceName: input.teamName,
    botUserId: input.botUserId,
    installedAt: new Date().toISOString(),
  };
}

/** The Dosco workspace's Slack secrets (bot token, team, bot ids), without its install rows. */
/**
 * Delete a Dosco workspace's Slack secrets. `keepSigningSecret`: its own
 * Slack app is still installed in another Slack workspace, and only that
 * app's install writes `SLACK_SIGNING_SECRET`.
 */
export async function deleteSlackSecrets(projectId: string, opts: { keepSigningSecret?: boolean } = {}): Promise<void> {
  const keys = opts.keepSigningSecret ? SLACK_KEYS.filter((k) => k !== SLACK_SIGNING_SECRET) : SLACK_KEYS;
  // The rows the install wrote (`upsertSecret`) only: connector-scoped,
  // ownerless, identifier = name. A detach runs for another Dosco workspace
  // than the caller's, and a member's own secret with one of these names stays.
  await db
    .delete(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, projectId),
        inArray(projectSecrets.name, keys),
        sql`${projectSecrets.identifier} = ${projectSecrets.name}`,
        eq(projectSecrets.scope, 'connector'),
        isNull(projectSecrets.ownerUserId),
      ),
    );
}

export async function deleteSlackInstall(projectId: string): Promise<void> {
  await deleteProjectSecrets(projectId, SLACK_KEYS);
  await db
    .delete(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'slack'), eq(chatInstalls.projectId, projectId)));
}

// Universal Dosco Slack App install. Records this project's install of the
// Slack workspace and stores the bot token and workspace metadata for it. One
// Slack workspace has one linked Dosco workspace on the shared app
// (slack/link.ts): the OAuth completion moves the link here, which detaches
// the others, so the token is never fanned out to another project. The
// signing secret is the master Dosco one and stays server-side.
export async function saveSlackOauthInstall(
  input: SlackOauthInstallInput,
): Promise<SlackInstallSummary> {
  await db
    .insert(chatInstalls)
    .values({
      platform: 'slack',
      platformTeamId: input.workspaceId,
      projectId: input.projectId,
      ownApp: false,
    })
    .onConflictDoUpdate({
      target: [chatInstalls.platform, chatInstalls.platformTeamId, chatInstalls.projectId],
      set: { ownApp: false, connectedAt: new Date() },
    });
  await upsertSecret(input.projectId, SLACK_BOT_TOKEN, input.botToken);
  await upsertSecret(input.projectId, SLACK_TEAM_ID, input.workspaceId);
  await upsertSecret(input.projectId, SLACK_BOT_USER_ID, input.botUserId);
  await upsertSecret(input.projectId, SLACK_TEAM_NAME, input.teamName ?? '');
  return {
    workspaceId: input.workspaceId,
    workspaceName: input.teamName,
    botUserId: input.botUserId,
    installedAt: new Date().toISOString(),
  };
}

export async function loadSlackInstall(projectId: string): Promise<SlackInstallSummary | null> {
  // Read scope-agnostically: Slack credentials are stored with scope='connector'
  // (kept out of the sandbox env), which listProjectSecrets deliberately drops —
  // so status must go through readSecret, matching the Teams install read path.
  const teamId = await readSecret(projectId, SLACK_TEAM_ID);
  if (!teamId) return null;
  const [row] = await db
    .select({ updatedAt: projectSecrets.updatedAt })
    .from(projectSecrets)
    .where(and(eq(projectSecrets.projectId, projectId), eq(projectSecrets.name, SLACK_TEAM_ID)))
    .limit(1);
  return {
    workspaceId: teamId,
    workspaceName: (await readSecret(projectId, SLACK_TEAM_NAME)) || null,
    botUserId: (await readSecret(projectId, SLACK_BOT_USER_ID)) || null,
    installedAt: row?.updatedAt?.toISOString() ?? new Date().toISOString(),
  };
}

export async function loadSlackTokenForProject(projectId: string): Promise<string | null> {
  return readSecret(projectId, SLACK_BOT_TOKEN);
}

export async function loadSlackSigningSecretForProject(projectId: string): Promise<string | null> {
  return readSecret(projectId, SLACK_SIGNING_SECRET);
}

export async function loadSlackBotUserIdForProject(projectId: string): Promise<string | null> {
  return readSecret(projectId, SLACK_BOT_USER_ID);
}

export async function loadSlackBotIdForProject(projectId: string): Promise<string | null> {
  return readSecret(projectId, SLACK_BOT_ID);
}

/**
 * The install's bot id, asking Slack (`auth.test`) once and storing it. A post
 * under an agent's name arrives back with no `event.user`, so the self-loop
 * guard keys it on this id; without it no post carries a persona.
 */
export async function ensureSlackBotId(projectId: string, token: string): Promise<string | null> {
  const known = await readSecret(projectId, SLACK_BOT_ID);
  if (known) return known;
  // Lazy: this module sits under every Slack import, and slack-api does not need to.
  const { authTestBotId } = await import('../slack-api');
  const botId = await authTestBotId(token);
  if (botId) await upsertSecret(projectId, SLACK_BOT_ID, botId);
  return botId;
}

export async function loadSlackTeamIdForProject(projectId: string): Promise<string | null> {
  return readSecret(projectId, SLACK_TEAM_ID);
}

export async function loadSlackTeamNameForProject(projectId: string): Promise<string | null> {
  return readSecret(projectId, SLACK_TEAM_NAME);
}
