/**
 * Real-Postgres contract for the originating-channel allowance
 * (`sessionChannelConnectorSlugs`, `principalMayUseConnector`).
 *
 * A session a channel created reaches that channel's connector under any
 * grant. A child that runs as its parent's own agent (an inline colleague, a
 * built-in, a fork) has its parent's access, so it reaches the same channel:
 * a Slack-started My Kortix session's colleague can read the thread and post
 * the result there. A child of another agent ends the line, and so does any
 * descendant below it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, connectors, projectSessions, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { sessionChannelConnectorSlugs } from './db-deps-principal';
import { db } from '../shared/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const USER = crypto.randomUUID();
const ROOT = crypto.randomUUID();
const COLLEAGUE = crypto.randomUUID();
const GRANDCHILD = crypto.randomUUID();
const NAMED = crypto.randomUUID();
const BELOW_NAMED = crypto.randomUUID();
const UNLINKED = crypto.randomUUID();

const session = (sessionId: string, agentName: string, parentSessionId: string | null, source: string) => ({
  sessionId,
  accountId: ACCOUNT,
  projectId: PROJECT,
  branchName: sessionId,
  createdBy: USER,
  visibility: 'project' as const,
  agentName,
  parentSessionId,
  metadata: { source },
});

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'channel-inherit-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'channel-inherit-test',
    repoUrl: 'https://example.test/channel-inherit.git',
  });
  await db.insert(connectors).values({
    connectorId: crypto.randomUUID(),
    accountId: ACCOUNT,
    projectId: PROJECT,
    slug: 'kortix_slack',
    name: 'Slack',
    providerType: 'channel',
    config: { platform: 'slack' },
  });
  await db.insert(projectSessions).values([
    session(ROOT, 'mykortix', null, 'slack'),
    session(COLLEAGUE, 'mykortix', ROOT, 'agent'),
    session(GRANDCHILD, 'mykortix', COLLEAGUE, 'agent'),
    session(NAMED, 'compliance-officer', ROOT, 'agent'),
    session(BELOW_NAMED, 'compliance-officer', NAMED, 'agent'),
    session(UNLINKED, 'mykortix', null, 'agent'),
  ]);
});

afterAll(async () => {
  await db.delete(projectSessions).where(eq(projectSessions.projectId, PROJECT));
  await db.delete(connectors).where(eq(connectors.projectId, PROJECT));
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('originating channel of a session and its same-agent children', () => {
  test('the session Slack created reaches the Slack channel connector', async () => {
    expect(await sessionChannelConnectorSlugs(PROJECT, ROOT)).toEqual(['kortix_slack']);
  });

  test('a child that runs as its parent\'s agent reaches it, and so does its own same-agent child', async () => {
    expect(await sessionChannelConnectorSlugs(PROJECT, COLLEAGUE)).toEqual(['kortix_slack']);
    expect(await sessionChannelConnectorSlugs(PROJECT, GRANDCHILD)).toEqual(['kortix_slack']);
  });

  test('a child of another agent does not, and neither does anything below it', async () => {
    expect(await sessionChannelConnectorSlugs(PROJECT, NAMED)).toEqual([]);
    expect(await sessionChannelConnectorSlugs(PROJECT, BELOW_NAMED)).toEqual([]);
  });

  test('a session no channel created, and an unknown session, reach none', async () => {
    expect(await sessionChannelConnectorSlugs(PROJECT, UNLINKED)).toEqual([]);
    expect(await sessionChannelConnectorSlugs(PROJECT, crypto.randomUUID())).toEqual([]);
    // The session belongs to this project only.
    expect(await sessionChannelConnectorSlugs(crypto.randomUUID(), ROOT)).toEqual([]);
  });
});
