// Shared project-secret plumbing for the chat-channel installs. Each platform
// owns its install rows and secret keys in its own module (slack/installs.ts,
// email/installs.ts, teams/installs.ts); this module owns the shared secret
// upsert/read/delete plumbing and re-exports the platform modules, so the
// established '../install-store' and `channels` import paths keep working.
//
// The cycle (a platform module importing this module while this module
// re-exports it) is safe: every shared helper is a hoisted function
// declaration, and the platform modules touch those helpers only at call time,
// long after both sides of the cycle have finished evaluating.
import { chatInstalls, projectSecrets } from '@kortix/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { encryptProjectSecret, getProjectSecretValueForConsumer } from '../projects/secrets';
import { db } from '../shared/db';

export * from './slack/installs';
export * from './email/installs';
export * from './teams/installs';
export * from './telegram/installs';

export async function deleteProjectSecrets(
  projectId: string,
  names: readonly string[],
): Promise<void> {
<<<<<<< HEAD
  const keys = agentMailKeys(connectionSlug);
  const install = await loadAgentMailInstall(projectId, connectionSlug);
  for (const name of Object.values(keys)) {
    await db
      .delete(projectSecrets)
      .where(and(eq(projectSecrets.projectId, projectId), eq(projectSecrets.name, name)));
  }
  if (install?.inboxId) {
    await db
      .delete(chatChannelBindings)
      .where(
        and(
          eq(chatChannelBindings.platform, 'email'),
          eq(chatChannelBindings.projectId, projectId),
          eq(chatChannelBindings.workspaceId, install.inboxId),
          eq(
            chatChannelBindings.channelId,
            (connectionSlug || 'kortix_email').trim() || 'kortix_email',
          ),
        ),
      );
    await db
      .delete(chatInstalls)
      .where(
        and(
          eq(chatInstalls.platform, 'email'),
          eq(chatInstalls.projectId, projectId),
          eq(chatInstalls.workspaceId, install.inboxId),
        ),
      );
  } else if (!connectionSlug || connectionSlug === 'kortix_email') {
    await db
      .delete(chatChannelBindings)
      .where(
        and(
          eq(chatChannelBindings.platform, 'email'),
          eq(chatChannelBindings.projectId, projectId),
        ),
      );
    await db
      .delete(chatInstalls)
      .where(and(eq(chatInstalls.platform, 'email'), eq(chatInstalls.projectId, projectId)));
  }
}

function agentMailConnectionSlugFromInboxSecret(name: string): string | null {
  if (!name.startsWith(AGENTMAIL_INBOX_ID)) return null;
  const suffix = name.slice(AGENTMAIL_INBOX_ID.length);
  if (!suffix) return 'kortix_email';
  return suffix.replace(/^_+/, '').toLowerCase() || null;
}

export async function listAgentMailInstalls(projectId: string): Promise<AgentMailInstallSummary[]> {
  const rows = await db
    .select({ name: projectSecrets.name })
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, projectId),
        like(projectSecrets.name, `${AGENTMAIL_INBOX_ID}%`),
        isNull(projectSecrets.ownerUserId),
      ),
    );

  const installs: AgentMailInstallSummary[] = [];
  for (const row of rows) {
    const connectionSlug = agentMailConnectionSlugFromInboxSecret(row.name);
    if (!connectionSlug) continue;
    try {
      // Skip malformed or stale secret envelopes without poisoning the whole list.
      if (!(await readSecret(projectId, row.name))) continue;
      const install = await loadAgentMailInstall(projectId, connectionSlug);
      if (install) installs.push(install);
    } catch {}
  }
  return installs.sort((a, b) => a.connectionSlug.localeCompare(b.connectionSlug));
}

export async function updateAgentMailSenderPolicy(
  projectId: string,
  connectionSlug: string | null | undefined,
  senderPolicy: AgentMailSenderPolicy,
): Promise<AgentMailInstallSummary | null> {
  const install = await loadAgentMailInstall(projectId, connectionSlug);
  if (!install) return null;
  await upsertSecret(
    projectId,
    agentMailKeys(connectionSlug).senderPolicy,
    JSON.stringify(normalizeSenderPolicy(senderPolicy)),
  );
  return loadAgentMailInstall(projectId, connectionSlug);
}

export async function loadAgentMailInstall(
  projectId: string,
  connectionSlug?: string | null,
): Promise<AgentMailInstallSummary | null> {
  const keys = agentMailKeys(connectionSlug);
  const [inboxId, email, displayName, webhookId, senderPolicyRaw] = await Promise.all([
      readSecret(projectId, keys.inboxId),
      readSecret(projectId, keys.email),
      readSecret(projectId, keys.displayName),
      readSecret(projectId, keys.webhookId),
      readSecret(projectId, keys.senderPolicy),
    ]);
  if (!inboxId || !email) return null;
  const [row] = await db
    .select({ updatedAt: projectSecrets.updatedAt })
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, projectId),
        eq(projectSecrets.name, keys.inboxId),
        isNull(projectSecrets.ownerUserId),
      ),
    )
    .limit(1);
  return {
    connectionSlug: connectionSlug || 'kortix_email',
    inboxId,
    email,
    displayName: displayName || null,
    webhookId: webhookId || null,
    senderPolicy: parseSenderPolicy(senderPolicyRaw),
    installedAt: row?.updatedAt?.toISOString() ?? new Date().toISOString(),
  };
}

export async function loadAgentMailApiKeyForProject(
  projectId: string,
  connectionSlug?: string | null,
): Promise<string | null> {
  return readSecret(projectId, agentMailKeys(connectionSlug).apiKey);
}

export async function loadAgentMailApiKeyForInbox(
  projectId: string,
  inboxId: string,
): Promise<string | null> {
  const rows = await db
    .select({ name: projectSecrets.name })
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, projectId),
        like(projectSecrets.name, `${AGENTMAIL_INBOX_ID}%`),
        isNull(projectSecrets.ownerUserId),
      ),
    );

  for (const row of rows) {
    const value = await readSecret(projectId, row.name);
    if (value !== inboxId) continue;
    const suffix = row.name.slice(AGENTMAIL_INBOX_ID.length);
    return readSecret(projectId, `${AGENTMAIL_API_KEY}${suffix}`);
  }
  return null;
}

export async function loadAgentMailWebhookSecretForProject(
  projectId: string,
): Promise<string | null> {
  return readSecret(projectId, AGENTMAIL_WEBHOOK_SECRET);
}

export async function loadAgentMailWebhookSecretForInbox(
  projectId: string,
  inboxId: string,
): Promise<string | null> {
  const rows = await db
    .select({ name: projectSecrets.name })
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, projectId),
        like(projectSecrets.name, `${AGENTMAIL_INBOX_ID}%`),
        isNull(projectSecrets.ownerUserId),
      ),
    );

  for (const row of rows) {
    const value = await readSecret(projectId, row.name);
    if (value !== inboxId) continue;
    const suffix = row.name.slice(AGENTMAIL_INBOX_ID.length);
    return readSecret(projectId, `${AGENTMAIL_WEBHOOK_SECRET}${suffix}`);
  }
  return null;
}

export async function loadAgentMailSenderPolicyForInbox(
  projectId: string,
  inboxId: string,
): Promise<AgentMailSenderPolicy> {
  const rows = await db
    .select({ name: projectSecrets.name })
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, projectId),
        like(projectSecrets.name, `${AGENTMAIL_INBOX_ID}%`),
        isNull(projectSecrets.ownerUserId),
      ),
    );

  for (const row of rows) {
    const value = await readSecret(projectId, row.name);
    if (value !== inboxId) continue;
    const suffix = row.name.slice(AGENTMAIL_INBOX_ID.length);
    return parseSenderPolicy(await readSecret(projectId, `${AGENTMAIL_SENDER_POLICY}${suffix}`));
  }
  return DEFAULT_AGENTMAIL_SENDER_POLICY;
}

export interface SlackOauthInstallInput {
  projectId: string;
  workspaceId: string;
  botToken: string;
  botUserId: string;
  teamName: string | null;
}

// Universal Dosco Slack App install. Records this project's membership of the
// workspace, then fans the bot token + workspace metadata out to every project
// on the workspace — Slack issues one token per (app, workspace) and a re-auth
// rotates it, so all sharing projects must be kept current. The signing secret
// is the master Dosco one and stays server-side; it is never persisted here.
export async function saveSlackOauthInstall(
  input: SlackOauthInstallInput,
): Promise<SlackInstallSummary> {
=======
  if (names.length === 0) return;
>>>>>>> upstream-dev
  await db
    .delete(projectSecrets)
    .where(and(eq(projectSecrets.projectId, projectId), inArray(projectSecrets.name, [...names])));
}

export async function listProjectsForWorkspace(
  platform: string,
  workspaceId: string,
): Promise<string[]> {
  const rows = await db
    .select({ projectId: chatInstalls.projectId })
    .from(chatInstalls)
    .where(and(eq(chatInstalls.platform, platform), eq(chatInstalls.workspaceId, workspaceId)));
  return rows.map((r) => r.projectId);
}

<<<<<<< HEAD
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

export async function loadSlackTeamIdForProject(projectId: string): Promise<string | null> {
  return readSecret(projectId, SLACK_TEAM_ID);
}

export async function loadSlackTeamNameForProject(projectId: string): Promise<string | null> {
  return readSecret(projectId, SLACK_TEAM_NAME);
}

// ─── Microsoft Teams ──────────────────────────────────────────────────────

export const MS_TEAMS_TENANT_ID = 'MS_TEAMS_TENANT_ID';
export const MS_TEAMS_SERVICE_URL = 'MS_TEAMS_SERVICE_URL';
export const MS_TEAMS_TEAM_ID = 'MS_TEAMS_TEAM_ID';
export const MS_TEAMS_TEAM_NAME = 'MS_TEAMS_TEAM_NAME';
export const MS_TEAMS_BOT_ID = 'MS_TEAMS_BOT_ID';
export const MS_TEAMS_APP_ID = 'MS_TEAMS_APP_ID';
export const MS_TEAMS_APP_PASSWORD = 'MS_TEAMS_APP_PASSWORD';
export const MS_TEAMS_ORG_INSTALLED = 'MS_TEAMS_ORG_INSTALLED';
export const MS_TEAMS_CATALOG_APP_ID = 'MS_TEAMS_CATALOG_APP_ID';
// Outcome of the one-click org-catalog publish (teams-oauth.ts), so the
// dashboard can show "publishing…", "pending review", or the Graph rejection
// instead of a redirect status nothing reads.
export const MS_TEAMS_PUBLISH_STATE = 'MS_TEAMS_PUBLISH_STATE';
export const MS_TEAMS_PUBLISH_ERROR = 'MS_TEAMS_PUBLISH_ERROR';
// The app manifest version the org catalog serves, read at each publish. A
// team on a version older than the read permissions refuses thread reads.
export const MS_TEAMS_APP_VERSION = 'MS_TEAMS_APP_VERSION';

const TEAMS_KEYS = [
  MS_TEAMS_TENANT_ID,
  MS_TEAMS_SERVICE_URL,
  MS_TEAMS_TEAM_ID,
  MS_TEAMS_TEAM_NAME,
  MS_TEAMS_BOT_ID,
  MS_TEAMS_APP_ID,
  MS_TEAMS_APP_PASSWORD,
  MS_TEAMS_ORG_INSTALLED,
  MS_TEAMS_CATALOG_APP_ID,
  MS_TEAMS_PUBLISH_STATE,
  MS_TEAMS_PUBLISH_ERROR,
  MS_TEAMS_APP_VERSION,
] as const;

export type TeamsPublishState = 'publishing' | 'published' | 'review' | 'failed';

const TEAMS_PUBLISH_STATES: ReadonlySet<string> = new Set(['publishing', 'published', 'review', 'failed']);

function parsePublishState(value: string | undefined): TeamsPublishState | null {
  return value && TEAMS_PUBLISH_STATES.has(value) ? (value as TeamsPublishState) : null;
}

export interface TeamsInstallSummary {
  tenantId: string;
  teamId: string | null;
  teamName: string | null;
  botId: string | null;
  serviceUrl: string | null;
  byo: boolean;
  orgInstalled: boolean;
  catalogAppId: string | null;
  /** Null until a one-click install has run (manual + BYO installs never publish). */
  publishState: TeamsPublishState | null;
  /** The Graph rejection when `publishState === 'failed'`; null otherwise. */
  publishError: string | null;
  /** The app version the org catalog serves; null when no publish recorded it. */
  appVersion: string | null;
  /** The app version this deployment publishes. */
  latestAppVersion: string;
  /**
   * A one-click install whose catalog serves an older app, or one published
   * before Dosco recorded the version. Publishing again sends the latest.
   */
  appUpdateAvailable: boolean;
  installedAt: string;
}

export interface TeamsInstallInput {
  projectId: string;
  tenantId: string;
  teamId?: string | null;
  teamName?: string | null;
  botId?: string | null;
  serviceUrl?: string | null;
  appId?: string | null;
  appPassword?: string | null;
}

export interface TeamsBotCredentials {
  appId: string;
  appPassword: string;
}

export async function saveTeamsInstall(input: TeamsInstallInput): Promise<TeamsInstallSummary> {
  const { projectId, tenantId } = input;
  // One tenant per project (MS_TEAMS_TENANT_ID is single-valued). A reconnect
  // to another tenant retires the old tenant's row, so the install record the
  // inbound routes and the file proxy trust names only the tenant proven last.
  await db
    .delete(chatInstalls)
    .where(
      and(
        eq(chatInstalls.platform, 'teams'),
        eq(chatInstalls.projectId, projectId),
        ne(chatInstalls.workspaceId, tenantId),
      ),
    );
  await db
    .insert(chatInstalls)
    .values({ platform: 'teams', workspaceId: tenantId, projectId })
    .onConflictDoNothing();

  await upsertSecret(projectId, MS_TEAMS_TENANT_ID, tenantId);
  if (input.teamId != null) await upsertSecret(projectId, MS_TEAMS_TEAM_ID, input.teamId);
  if (input.teamName != null) await upsertSecret(projectId, MS_TEAMS_TEAM_NAME, input.teamName);
  if (input.botId != null) await upsertSecret(projectId, MS_TEAMS_BOT_ID, input.botId);
  if (input.serviceUrl != null) await upsertSecret(projectId, MS_TEAMS_SERVICE_URL, input.serviceUrl);
  if (input.appId != null) await upsertSecret(projectId, MS_TEAMS_APP_ID, input.appId);
  if (input.appPassword != null) await upsertSecret(projectId, MS_TEAMS_APP_PASSWORD, input.appPassword);

  return {
    tenantId,
    teamId: input.teamId ?? null,
    teamName: input.teamName ?? null,
    botId: input.botId ?? null,
    serviceUrl: input.serviceUrl ?? null,
    byo: Boolean(input.appId),
    orgInstalled: false,
    catalogAppId: null,
    publishState: null,
    publishError: null,
    appVersion: null,
    latestAppVersion: TEAMS_MANIFEST_VERSION,
    appUpdateAvailable: false,
    installedAt: new Date().toISOString(),
  };
}

export async function setTeamsPublishState(
  projectId: string,
  state: TeamsPublishState,
  error?: string | null,
): Promise<void> {
  await upsertSecret(projectId, MS_TEAMS_PUBLISH_STATE, state);
  await upsertSecret(projectId, MS_TEAMS_PUBLISH_ERROR, state === 'failed' ? (error ?? '').slice(0, 500) : '');
}

export async function setTeamsOrgInstalled(projectId: string, installed: boolean): Promise<void> {
  await upsertSecret(projectId, MS_TEAMS_ORG_INSTALLED, installed ? '1' : '');
}

export async function setTeamsCatalogAppId(projectId: string, catalogAppId: string): Promise<void> {
  await upsertSecret(projectId, MS_TEAMS_CATALOG_APP_ID, catalogAppId);
}

export async function setTeamsAppVersion(projectId: string, version: string): Promise<void> {
  await upsertSecret(projectId, MS_TEAMS_APP_VERSION, version);
}

export async function loadTeamsBotCredentials(projectId: string): Promise<TeamsBotCredentials | null> {
  const secrets = await readTeamsSecrets(projectId);
  const appId = secrets[MS_TEAMS_APP_ID];
  const appPassword = secrets[MS_TEAMS_APP_PASSWORD];
  if (!appId || !appPassword) return null;
  return { appId, appPassword };
}

export async function loadTeamsAppIdForProject(projectId: string): Promise<string | null> {
  return readSecret(projectId, MS_TEAMS_APP_ID);
}

/** Update just the conversation serviceUrl — refreshed from each inbound activity. */
export async function saveTeamsServiceUrl(projectId: string, serviceUrl: string): Promise<void> {
  if (!serviceUrl) return;
  await upsertSecret(projectId, MS_TEAMS_SERVICE_URL, serviceUrl);
}

export async function loadTeamsInstall(projectId: string): Promise<TeamsInstallSummary | null> {
  const secrets = await readTeamsSecrets(projectId);
  const tenantId = secrets[MS_TEAMS_TENANT_ID];
  if (!tenantId) return null;
  const [row] = await db
    .select({ updatedAt: projectSecrets.updatedAt })
    .from(projectSecrets)
    .where(and(eq(projectSecrets.projectId, projectId), eq(projectSecrets.name, MS_TEAMS_TENANT_ID)))
    .limit(1);
  const byo = Boolean(secrets[MS_TEAMS_APP_ID]);
  const orgInstalled = Boolean(secrets[MS_TEAMS_ORG_INSTALLED]);
  const publishState = parsePublishState(secrets[MS_TEAMS_PUBLISH_STATE]);
  const appVersion = secrets[MS_TEAMS_APP_VERSION] || null;
  // In the org catalog and settled. A null state is an install published
  // before Dosco recorded it; publishing, review and failed say what to do.
  const catalogSettled = orgInstalled && !byo && (publishState === null || publishState === 'published');
  return {
    tenantId,
    teamId: secrets[MS_TEAMS_TEAM_ID] || null,
    teamName: secrets[MS_TEAMS_TEAM_NAME] || null,
    botId: secrets[MS_TEAMS_BOT_ID] || null,
    serviceUrl: secrets[MS_TEAMS_SERVICE_URL] || null,
    byo,
    orgInstalled,
    catalogAppId: secrets[MS_TEAMS_CATALOG_APP_ID] || null,
    publishState,
    publishError: secrets[MS_TEAMS_PUBLISH_ERROR] || null,
    appVersion,
    latestAppVersion: TEAMS_MANIFEST_VERSION,
    appUpdateAvailable: catalogSettled && isOlderAppVersion(appVersion),
    installedAt: row?.updatedAt?.toISOString() ?? new Date().toISOString(),
  };
}

/** Null is older: the install was published before Dosco recorded the version. */
function isOlderAppVersion(version: string | null): boolean {
  return version === null || version.localeCompare(TEAMS_MANIFEST_VERSION, 'en', { numeric: true }) < 0;
}

/**
 * The tenant the project's Teams install proved, from `chat_installs`.
 *
 * Not the `MS_TEAMS_TENANT_ID` secret: this tenant selects whose Microsoft
 * Graph data the connector reads, with the managed app every customer shares.
 * A secret a project writer could overwrite would let one customer's project
 * name another customer's tenant (found in the 2026-09-29 permissions audit).
 */
export async function loadTeamsTenantForProject(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ workspaceId: chatInstalls.workspaceId })
    .from(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'teams'), eq(chatInstalls.projectId, projectId)))
    .limit(1);
  return row?.workspaceId || null;
}

export async function loadTeamsServiceUrlForProject(projectId: string): Promise<string | null> {
  return readSecret(projectId, MS_TEAMS_SERVICE_URL);
}

export async function deleteTeamsInstall(projectId: string): Promise<void> {
  for (const name of TEAMS_KEYS) {
    await db
      .delete(projectSecrets)
      .where(and(eq(projectSecrets.projectId, projectId), eq(projectSecrets.name, name)));
  }
  await db
    .delete(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'teams'), eq(chatInstalls.projectId, projectId)));
}

async function upsertSecret(projectId: string, name: string, value: string): Promise<void> {
=======
export async function upsertSecret(projectId: string, name: string, value: string): Promise<void> {
>>>>>>> upstream-dev
  const valueEnc = encryptProjectSecret(projectId, value);
  const updated = await updateSharedSecret(projectId, name, valueEnc);
  if (updated) return;

  try {
    await db.insert(projectSecrets).values({
      projectId,
      identifier: name,
      name,
      valueEnc,
      scope: 'connector',
      strategy: 'broker',
      consumer: 'connector',
      rotatedAt: new Date(),
    });
  } catch (err) {
    if (!isUniqueConflict(err)) throw err;
    const retryUpdated = await updateSharedSecret(projectId, name, valueEnc);
    if (!retryUpdated) throw err;
  }
}

async function updateSharedSecret(
  projectId: string,
  name: string,
  valueEnc: string,
): Promise<boolean> {
  const rows = await db
    .update(projectSecrets)
    .set({
      valueEnc,
      scope: 'connector',
      strategy: 'broker',
      consumer: 'connector',
      egressPolicy: null,
      handlePrefix: null,
      active: true,
      rotatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(projectSecrets.projectId, projectId),
        eq(projectSecrets.name, name),
        isNull(projectSecrets.ownerUserId),
      ),
    )
    .returning({ secretId: projectSecrets.secretId });
  return rows.length > 0;
}

function isUniqueConflict(err: unknown): boolean {
  const error = err as {
    code?: unknown;
    cause?: { code?: unknown; cause?: { code?: unknown } };
  };
  return (
    error?.code === '23505' ||
    error?.cause?.code === '23505' ||
    error?.cause?.cause?.code === '23505'
  );
}

export async function readSecret(projectId: string, name: string): Promise<string | null> {
  return getProjectSecretValueForConsumer({
    projectId,
    name,
    consumer: 'connector',
    probe: true, // install lookups are system probes, not access by an agent or person
  });
}
