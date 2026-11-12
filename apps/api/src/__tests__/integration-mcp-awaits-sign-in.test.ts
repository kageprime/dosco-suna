/**
 * An MCP server added but never signed in lists as needing sign-in, not as an
 * error (connectors/sync.ts `mcpCatalogAwaitsSignIn`).
 *
 * Prod audit, 2026-11-11: 28 accounts added an MCP server and never finished
 * the sign-in. The sync called `tools/list` with no credential, got 401, and
 * stored the connector as `status: 'error'`, so the CLI, agents and the
 * catalog showed a broken connector instead of the Sign in action.
 *
 * Real-Postgres contract, through the real sync (a kortix.yaml in a bare git
 * repository on disk) and the real listing. Only the upstream MCP server is a
 * stub: it answers 401, as a server that wants OAuth does before a sign-in.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { accounts, connectorConnections, connectors, projects } from '@kortix/db';
import { and, eq } from 'drizzle-orm';

// The upstream MCP server: status per URL path.
let upstreamStatus = 401;
const realEgress = await import('../connectors/egress');
mock.module('../connectors/egress', () => ({
  ...realEgress,
  connectorEgressFetch: async () => ({
    status: upstreamStatus,
    ok: upstreamStatus < 400,
    headers: new Headers({ 'www-authenticate': 'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource"' }),
    text: async () => '',
  }),
}));

const { dbConnectorRouterDeps } = await import('../connectors/db-deps');
const { syncProjectConnectors } = await import('../connectors/sync');
const { db } = await import('../shared/db');

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const USER = crypto.randomUUID();

function pushManifest(): string {
  const root = mkdtempSync(join(tmpdir(), 'kortix-mcp-sign-in-'));
  const remote = join(root, 'remote.git');
  const work = join(root, 'work');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  git(root, 'clone', '-q', remote, work);
  writeFileSync(
    join(work, 'kortix.yaml'),
    [
      'kortix_version: 2',
      'connectors:',
      // Signs in: auth declared, as the add flow writes it from the 401 challenge.
      '  - slug: signs-in',
      '    provider: mcp',
      '    url: https://mcp.example.test/mcp',
      '    auth:',
      '      type: bearer',
      // Declares no auth: a 401 there is a setup error, not a pending sign-in.
      '  - slug: no-auth',
      '    provider: mcp',
      '    url: https://mcp.example.test/open',
      '',
    ].join('\n'),
  );
  git(work, 'add', '-A');
  git(work, '-c', 'user.name=Kortix Test', '-c', 'user.email=test@kortix.test', 'commit', '-q', '-m', 'add MCP servers');
  git(work, 'push', '-q', 'origin', 'main');
  return remote;
}

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'mcp-awaits-sign-in' });
  await db.insert(projects).values({ projectId: PROJECT, accountId: ACCOUNT, name: 'mcp-awaits-sign-in', repoUrl: pushManifest() });
});

afterAll(async () => {
  await db.delete(connectorConnections).where(eq(connectorConnections.projectId, PROJECT));
  await db.delete(connectors).where(eq(connectors.projectId, PROJECT));
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

async function stored(slug: string) {
  const [row] = await db
    .select({ status: connectors.status, lastError: connectors.lastError })
    .from(connectors)
    .where(and(eq(connectors.projectId, PROJECT), eq(connectors.slug, slug)));
  return row;
}

async function listed(slug: string) {
  const view = (await dbConnectorRouterDeps.listConnectors(PROJECT, USER)).find((v) => v.slug === slug);
  return view && { status: view.status, state: view.state, auth_needed: view.auth_needed, lastError: view.lastError };
}

describe('an MCP server that answers 401 before anyone signed in', () => {
  test('is stored active with no error, and lists as needs_auth / needs_account: the Sign in state', async () => {
    upstreamStatus = 401;
    await syncProjectConnectors(PROJECT, ACCOUNT, { force: true });
    expect(await stored('signs-in')).toEqual({ status: 'active', lastError: null });
    expect(await listed('signs-in')).toEqual({ status: 'needs_auth', state: 'needs_account', auth_needed: true, lastError: null });
  });

  test('a 403 is the same', async () => {
    upstreamStatus = 403;
    await syncProjectConnectors(PROJECT, ACCOUNT, { force: true });
    expect(await stored('signs-in')).toEqual({ status: 'active', lastError: null });
  });

  test('a row an older sync stored as error heals on the next sync', async () => {
    await db
      .update(connectors)
      .set({ status: 'error', lastError: 'MCP tools/list failed: HTTP 401' })
      .where(and(eq(connectors.projectId, PROJECT), eq(connectors.slug, 'signs-in')));
    upstreamStatus = 401;
    // No force: an error row is never reused, so the sweep's own sync re-fetches it.
    await syncProjectConnectors(PROJECT, ACCOUNT);
    expect(await stored('signs-in')).toEqual({ status: 'active', lastError: null });
  });
});

describe('what stays an error', () => {
  test('a 401 from a server that declares no auth', async () => {
    upstreamStatus = 401;
    await syncProjectConnectors(PROJECT, ACCOUNT, { force: true });
    expect(await stored('no-auth')).toEqual({ status: 'error', lastError: 'MCP tools/list failed: HTTP 401' });
  });

  test('a server fault', async () => {
    upstreamStatus = 500;
    await syncProjectConnectors(PROJECT, ACCOUNT, { force: true });
    expect(await stored('signs-in')).toEqual({ status: 'error', lastError: 'MCP tools/list failed: HTTP 500' });
  });
});
