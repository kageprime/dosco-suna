/**
 * KRTX-4640: the global connector-connect path mints a hosted connect link for
 * a custom MCP server even when no managed provider (Composio, Pipedream) is
 * configured — the self-host shape of the bug report. Before, the gate refused
 * every connector without Composio/Pipedream keys, so an `mcp` connector's only
 * working install was the Composio catalogue card.
 *
 * `scripts/test.env` carries fake PIPEDREAM_* values, so this suite clears the
 * managed-provider vars around its assertions and restores them after: the
 * deployment shape under test is "no managed provider anywhere".
 *
 * Real-Postgres contract: runs in the db-suites lane.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, connectors, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';

import { config } from '../config';
import { dbConnectorRouterDeps } from '../connectors/db-deps';
import { db } from '../shared/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const MCP = crypto.randomUUID();
const MANAGED = crypto.randomUUID();

// A catalogue app whose sign-in is Kortix's own OAuth client: discovery reads
// the catalogue instead of probing the server, so the suite stays offline.
const MCP_URL = 'https://mcp.slack.com/mcp';

let previous: { pipedream: [string, string | undefined][]; oauthClients: string | undefined };

beforeAll(async () => {
  previous = {
    pipedream: ['PIPEDREAM_CLIENT_ID', 'PIPEDREAM_CLIENT_SECRET', 'PIPEDREAM_PROJECT_ID'].map(
      (name) => [name, config[name as 'PIPEDREAM_CLIENT_ID']],
    ),
    oauthClients: config.KORTIX_OAUTH_CLIENTS,
  };
  // The deployment shape under test: no managed provider configured anywhere.
  for (const [name] of previous.pipedream) (config as Record<string, unknown>)[name] = '';
  (config as { KORTIX_OAUTH_CLIENTS?: string }).KORTIX_OAUTH_CLIENTS = JSON.stringify({
    slack: { client_id: 'kortix-test-client', client_secret: 'synthetic-secret' },
  });

  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'connect-link-mcp' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'connect-link-mcp',
    repoUrl: 'https://example.test/connect-link-mcp.git',
  });
  await db.insert(connectors).values([
    {
      connectorId: MCP,
      accountId: ACCOUNT,
      projectId: PROJECT,
      slug: 'custom-mcp',
      name: 'Custom MCP',
      providerType: 'mcp',
      config: { url: MCP_URL },
    },
    {
      connectorId: MANAGED,
      accountId: ACCOUNT,
      projectId: PROJECT,
      slug: 'managed-tool',
      name: 'Managed tool',
      providerType: 'composio',
      config: { app: 'synthetic_toolkit' },
    },
  ]);
});

afterAll(async () => {
  await db.delete(connectors).where(eq(connectors.projectId, PROJECT));
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  for (const [name, value] of previous.pipedream) {
    (config as Record<string, unknown>)[name] = value;
  }
  (config as { KORTIX_OAUTH_CLIENTS?: string }).KORTIX_OAUTH_CLIENTS = previous.oauthClients;
});

describe('mintConnectorConnectLink (KRTX-4640)', () => {
  test('a custom MCP server mints its link with no managed provider configured', async () => {
    const url = await dbConnectorRouterDeps.mintConnectorConnectLink?.({
      projectId: PROJECT,
      slug: 'custom-mcp',
      userId: OWNER,
      sessionId: null,
    });
    expect(url?.startsWith('http')).toBe(true);
    expect(url).toContain('/connect/ksl_');
  });

  test('a managed-provider connector stays gated on its provider', async () => {
    const url = await dbConnectorRouterDeps.mintConnectorConnectLink?.({
      projectId: PROJECT,
      slug: 'managed-tool',
      userId: OWNER,
      sessionId: null,
    });
    expect(url).toBeNull();
  });

  test('a custom MCP server whose sign-in is not one click still answers no link', async () => {
    await db
      .update(connectors)
      .set({ config: { url: 'https://dcr.example.test/mcp' } })
      .where(eq(connectors.connectorId, MCP));
    try {
      const url = await dbConnectorRouterDeps.mintConnectorConnectLink?.({
        projectId: PROJECT,
        slug: 'custom-mcp',
        userId: OWNER,
        sessionId: null,
      });
      // The server is not a catalogue app and answers nothing: discovery finds
      // no one-click sign-in, so eligibility refuses (`unsupported_provider`).
      expect(url).toBeNull();
    } finally {
      await db.update(connectors).set({ config: { url: MCP_URL } }).where(eq(connectors.connectorId, MCP));
    }
  });
});
