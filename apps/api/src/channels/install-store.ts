// Compatibility export door and project-channel teardown orchestration.
// Platform installs import shared secret plumbing from core/install-secrets.
import { chatChannelBindings } from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../shared/db';
export { decryptChannelSecret, encryptChannelSecret, deleteProjectSecrets, listProjectsForWorkspace, upsertSecret, readSecret } from './core/install-secrets';
import { deleteSlackInstall } from './slack/installs';
import { deleteTeamsInstall } from './teams/installs';
import { releaseTelegramBot } from './telegram/installs';
import { releaseDiscordInstall } from './discord/installs';

export * from './slack/installs';
export * from './email/installs';
export * from './teams/installs';
export * from './telegram/installs';
export * from './discord/installs';

/**
 * The project delete releases its chat channels; the tombstone keeps their rows
 * (no FK cascade), and the routers would keep resolving to it. Each platform
 * goes the way its disconnect goes, and the Slack and Teams channel bindings
 * go with them. The email inbox stays: a mail to it gets the deleted project's
 * notice (email/session.ts).
 */
export async function releaseProjectChannels(projectId: string): Promise<void> {
  await releaseTelegramBot(projectId);
  await releaseDiscordInstall(projectId);
  await deleteSlackInstall(projectId);
  await deleteTeamsInstall(projectId);
  await db
    .delete(chatChannelBindings)
    .where(and(eq(chatChannelBindings.projectId, projectId), inArray(chatChannelBindings.platform, ['slack', 'teams'])));
}
