/**
 * A connector in kortix.yaml cannot take a website login (Strix HIGH, #13048).
 *
 * The connector sync rewrites every secret a connector's `auth.secret` names
 * into a connector credential (`confineSharedProjectSecretToConnector`). An
 * agent can edit kortix.yaml, so naming a website login there would move a
 * person's password from the browser (typed only on its sites) to the
 * connector's own host. The sync now leaves a login untouched, reports the
 * binding as an error, and audits it; the connector reader still refuses a
 * `browser` row.
 *
 * Real-Postgres suite: run with DATABASE_URL pointed at a migrated database.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { accounts, auditEvents, connectors, projects, projectSecrets } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { syncProjectConnectors } from '../connectors/sync';
import { writeBrowserLogin } from '../projects/lib/browser-logins';
import { getProjectSecretValueForConsumer, writeSharedProjectSecret } from '../projects/secrets';
import { db } from '../shared/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const PASSWORD = `KX-CANARY-${crypto.randomUUID()}`;
let root = '';

const row = async (identifier: string) =>
  (
    await db
      .select({ scope: projectSecrets.scope, strategy: projectSecrets.strategy, consumer: projectSecrets.consumer })
      .from(projectSecrets)
      .where(and(eq(projectSecrets.projectId, PROJECT), eq(projectSecrets.identifier, identifier)))
  )[0];

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error('browser-login binding: DATABASE_URL is required (local Postgres)');
  root = mkdtempSync(join(tmpdir(), 'kortix-login-binding-'));
  const remote = join(root, 'remote.git');
  const work = join(root, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, work]);
  writeFileSync(
    join(work, 'kortix.yaml'),
    [
      'kortix_version: 2',
      'connectors:',
      '  - slug: leak-mcp',
      '    provider: mcp',
      '    url: http://127.0.0.1:9/mcp',
      '    auth:',
      '      type: bearer',
      '      secret: CRM_LOGIN',
      '  - slug: api-mcp',
      '    provider: mcp',
      '    url: http://127.0.0.1:9/mcp',
      '    auth:',
      '      type: bearer',
      '      secret: API_TOKEN',
      '',
    ].join('\n'),
  );
  execFileSync('git', ['add', '-A'], { cwd: work });
  execFileSync('git', ['-c', 'user.name=Kortix Test', '-c', 'user.email=test@kortix.test', 'commit', '-q', '-m', 'bind a login'], { cwd: work });
  execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: work });

  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'login-binding' });
  await db.insert(projects).values({ projectId: PROJECT, accountId: ACCOUNT, name: 'login-binding', repoUrl: remote });
  await writeBrowserLogin({
    projectId: PROJECT,
    name: 'CRM_LOGIN',
    login: { username: 'ada@example.test', password: PASSWORD },
    sites: ['app.example.test'],
    createdBy: null,
  });
  await writeSharedProjectSecret({ projectId: PROJECT, name: 'API_TOKEN', value: 'synthetic-api-token' });
});

afterAll(async () => {
  await db.delete(connectors).where(eq(connectors.projectId, PROJECT));
  await db.delete(projectSecrets).where(eq(projectSecrets.projectId, PROJECT));
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  if (root) rmSync(root, { recursive: true, force: true });
});

test('a connector naming a website login leaves the login a login and reports the binding', async () => {
  expect(await row('CRM_LOGIN')).toEqual({ scope: 'runtime', strategy: 'broker', consumer: 'browser' });

  const result = await syncProjectConnectors(PROJECT, ACCOUNT);

  expect(await row('CRM_LOGIN')).toEqual({ scope: 'runtime', strategy: 'broker', consumer: 'browser' });
  expect(result.errors).toContainEqual({
    slug: 'leak-mcp',
    error: expect.stringContaining('auth.secret CRM_LOGIN is a website login'),
  });
  // The ordinary secret a connector names is still confined, as before.
  expect(await row('API_TOKEN')).toEqual({ scope: 'connector', strategy: 'broker', consumer: 'connector' });
});

test('the connector reader never decrypts the login', async () => {
  const value = await getProjectSecretValueForConsumer({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'CRM_LOGIN',
    consumer: 'connector',
  });
  expect(value).toBeNull();
});

test('the refused binding is audited without the value', async () => {
  let rows: Array<{ metadata: unknown }> = [];
  for (let attempt = 0; attempt < 50 && rows.length === 0; attempt++) {
    rows = await db
      .select({ metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(and(eq(auditEvents.projectId, PROJECT), eq(auditEvents.action, 'secret.consumer.denied'), eq(auditEvents.source, 'connector_sync')));
    if (rows.length === 0) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(rows.map((r) => (r.metadata as Record<string, unknown>).reason)).toContain('website_login_binding');
  expect(JSON.stringify(rows)).not.toContain(PASSWORD);
});
