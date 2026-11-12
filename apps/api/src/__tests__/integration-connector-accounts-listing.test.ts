/**
 * Real-Postgres contract: `kortix connectors accounts <slug>` (GET
 * .../connectors/:slug/accounts) lists the same accounts Settings → Connectors
 * shows, by the rule in `@kortix/sdk` (`listedConnectorAccounts`):
 *
 * - the server's empty shared slot (a placeholder row made with the connector,
 *   never signed in) is not an account and is not listed;
 * - the caller's own account whose sign-in did not finish IS listed, marked
 *   `sign_in_not_finished`, so the person can finish it instead of adding a
 *   second one;
 * - another member's private account is never listed.
 *
 * The call-denial account list keeps only accounts a call can run as.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, connectorConnections, connectors, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';

const { dbConnectorRouterDeps, makeDbGatewayDeps } = await import('../connectors/db-deps');
const { db } = await import('../shared/db');

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const GMAIL = crypto.randomUUID();
const NOTION = crypto.randomUUID();
const LINEAR = crypto.randomUUID();
const OTHERS_LINEAR = crypto.randomUUID();
const MEMBER = crypto.randomUUID();
const OTHER_MEMBER = crypto.randomUUID();
const SLOT = crypto.randomUUID();
const SIGNED_IN = crypto.randomUUID();
const PENDING_MINE = crypto.randomUUID();
const PENDING_OTHER = crypto.randomUUID();

function list(slug: string) {
  return dbConnectorRouterDeps.listConnectorAccounts!({
    projectId: PROJECT,
    slug,
    userId: MEMBER,
    sessionId: null,
    agentPrincipal: null,
  });
}

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'accounts-listing-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'accounts-listing-test',
    repoUrl: 'https://example.test/accounts-listing.git',
  });
  await db.insert(connectors).values([
    {
      connectorId: GMAIL,
      accountId: ACCOUNT,
      projectId: PROJECT,
      slug: 'gmail',
      name: 'Gmail',
      providerType: 'composio',
      config: { app: 'gmail' },
    },
    {
      connectorId: NOTION,
      accountId: ACCOUNT,
      projectId: PROJECT,
      slug: 'notion-mcp',
      name: 'Notion',
      providerType: 'mcp',
      config: { url: 'https://mcp.example.test/mcp', auth: { type: 'oauth2' } },
    },
    {
      connectorId: LINEAR,
      accountId: ACCOUNT,
      projectId: PROJECT,
      slug: 'linear',
      name: 'Linear',
      providerType: 'composio',
      config: { app: 'linear' },
    },
  ]);
  await db.insert(connectorConnections).values([
    // The workspace placeholder the server made with the connector.
    {
      connectionId: SLOT,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId: GMAIL,
      ownerType: 'project',
      ownerId: null,
      label: 'Gmail',
      isDefault: true,
      metadata: { default_slot: 'project' },
    },
    // The caller's own signed-in Gmail.
    {
      connectionId: SIGNED_IN,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId: GMAIL,
      ownerType: 'member',
      ownerId: MEMBER,
      label: 'Work',
      metadata: { connected_account_id: 'ca_test_work' },
    },
    // The caller's own MCP account: sign-in not finished.
    {
      connectionId: PENDING_MINE,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId: NOTION,
      ownerType: 'member',
      ownerId: MEMBER,
      label: 'Notion',
      metadata: {},
    },
    // Another member's pending account: theirs only.
    {
      connectionId: PENDING_OTHER,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId: NOTION,
      ownerType: 'member',
      ownerId: OTHER_MEMBER,
      label: 'Notion (theirs)',
      metadata: {},
    },
    // Another member's signed-in private Linear: the caller has none.
    {
      connectionId: OTHERS_LINEAR,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId: LINEAR,
      ownerType: 'member',
      ownerId: OTHER_MEMBER,
      label: 'Linear',
      metadata: { connected_account_id: 'ca_test_theirs' },
    },
  ]);
});

afterAll(async () => {
  await db.delete(connectorConnections).where(eq(connectorConnections.projectId, PROJECT));
  await db.delete(connectors).where(eq(connectors.projectId, PROJECT));
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('connector accounts listing = the Settings → Connectors rule', () => {
  test('the empty workspace slot is not listed; a signed-in account is, as connected', async () => {
    const rows = await list('gmail');
    expect(rows.map((row) => [row.connection_id, row.status])).toEqual([[SIGNED_IN, 'connected']]);
  });

  test("the caller's own unfinished sign-in is listed; another member's is not", async () => {
    const rows = await list('notion-mcp');
    expect(rows.map((row) => [row.connection_id, row.label, row.status])).toEqual([
      [PENDING_MINE, 'Notion', 'sign_in_not_finished'],
    ]);
  });
});

describe('why a call found no account', () => {
  const explain = (slug: string) =>
    makeDbGatewayDeps({
      userId: MEMBER,
      accountId: ACCOUNT,
      projectId: PROJECT,
      sessionId: null,
      subject: { userId: MEMBER, groupIds: [] },
      agentGrant: null,
    }).explainMissingConnector!(PROJECT, slug);

  test('a signed-in account the caller cannot reach is connector_not_shared, not a sign-in prompt', async () => {
    expect(await explain('linear')).toBe('connector_not_shared');
  });

  test('no signed-in account anywhere stays connector_not_connected', async () => {
    expect(await explain('notion-mcp')).toBe('connector_not_connected');
  });
});
