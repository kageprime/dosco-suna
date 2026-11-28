import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The real CLI process against a fake API: the plugin protocol on stdio, the
// resolve request it sends, and the request flags for a login link.
const PASSWORD = 'synthetic-pw-7f3a9c"\\{}';
const requests: Array<{ method: string; path: string; auth: string | null; body: unknown }> = [];
let resolveAnswer: () => Response = () =>
  Response.json({ name: 'CRM_LOGIN', username: 'ada@example.test', password: PASSWORD, url: 'https://app.example.test/login' });

let dir: string;
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'secrets-browser-plugin-'));
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = req.method === 'GET' ? null : await req.json().catch(() => null);
      requests.push({ method: req.method, path: url.pathname, auth: req.headers.get('authorization'), body });
      if (url.pathname.endsWith('/browser-logins/resolve')) return resolveAnswer();
      if (url.pathname.endsWith('/browser-logins')) {
        return Response.json({ items: [{ name: 'CRM_LOGIN', sites: ['app.example.test'], available: true }] });
      }
      if (url.pathname.endsWith('/secret-requests')) {
        return Response.json({
          kind: 'secret',
          url: 'https://example.test/secret-intake/synthetic',
          names: ['CRM_LOGIN'],
          scope: 'browser',
          sites: ['app.example.test'],
          expires_at: '2099-01-01T00:00:00Z',
        });
      }
      return new Response('not found', { status: 404 });
    },
  });
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({
      active: 'test',
      hosts: {
        test: { url: `http://localhost:${server.port}`, token: 'synthetic-token', user_id: 'synthetic', account_id: 'synthetic' },
      },
    }),
  );
});

afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

async function cli(args: string[], stdin?: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    KORTIX_CONFIG_FILE: join(dir, 'config.json'),
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    KORTIX_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1',
  };
  for (const key of ['KORTIX_API_URL', 'KORTIX_CLI_TOKEN', 'KORTIX_PROJECT_ID', 'KORTIX_TOKEN']) delete env[key];
  const proc = Bun.spawn([process.execPath, resolve(import.meta.dir, '../index.ts'), ...args], {
    cwd: dir,
    env,
    stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: await proc.exited,
    out: await new Response(proc.stdout).text(),
    err: await new Response(proc.stderr).text(),
  };
}

const envelope = (type: string, request: Record<string, unknown> = {}) =>
  JSON.stringify({ protocol: 'agent-browser.plugin.v1', type, capability: 'credential.read', request });

test('the plugin answers the manifest with exactly one JSON object', async () => {
  const run = await cli(['secrets', 'browser-plugin', '--project', 'synthetic'], envelope('plugin.manifest'));
  expect(run.code).toBe(0);
  expect(JSON.parse(run.out)).toEqual({
    protocol: 'agent-browser.plugin.v1',
    success: true,
    manifest: {
      name: 'kortix',
      capabilities: ['credential.read'],
      description: 'Kortix website logins: types a saved login without showing it to the agent',
    },
  });
});

test('credential.resolve asks the API for one login for one URL and returns it only on stdout', async () => {
  requests.length = 0;
  const run = await cli(
    ['secrets', 'browser-plugin', '--project', 'synthetic'],
    envelope('credential.resolve', { profileName: 'crm', itemRef: 'CRM_LOGIN', url: 'https://app.example.test/login' }),
  );
  expect(run.code).toBe(0);
  expect(JSON.parse(run.out)).toEqual({
    protocol: 'agent-browser.plugin.v1',
    success: true,
    credential: { username: 'ada@example.test', password: PASSWORD, url: 'https://app.example.test/login' },
  });
  expect(run.err).not.toContain(PASSWORD);
  expect(requests).toEqual([
    {
      method: 'POST',
      path: '/v1/workspaces/synthetic/browser-logins/resolve',
      auth: 'Bearer synthetic-token',
      body: { name: 'CRM_LOGIN', url: 'https://app.example.test/login' },
    },
  ]);
});

test('a refusal is success:false, keeps the reason for `secrets logins`, and never the password', async () => {
  resolveAnswer = () =>
    Response.json(
      { error: 'CRM_LOGIN may be typed only on app.example.test, not on evil.test.', code: 'login_site_not_allowed' },
      { status: 403 },
    );
  const run = await cli(
    ['secrets', 'browser-plugin', '--project', 'synthetic'],
    envelope('credential.resolve', { profileName: 'crm', itemRef: 'CRM_LOGIN', url: 'https://evil.test/login' }),
  );
  expect(run.code).toBe(0);
  const answer = JSON.parse(run.out);
  expect(answer.success).toBe(false);
  expect(answer.credential).toBeUndefined();
  expect(run.err).toContain('not on evil.test');

  const lastError = JSON.parse(readFileSync(join(dir, 'browser-login-last-error.json'), 'utf8'));
  expect(lastError).toMatchObject({ name: 'CRM_LOGIN', url: 'https://evil.test/login', code: 'login_site_not_allowed' });

  const listed = await cli(['secrets', 'logins', '--project', 'synthetic', '--json']);
  expect(listed.code).toBe(0);
  const listing = JSON.parse(listed.out);
  expect(listing.items).toEqual([{ name: 'CRM_LOGIN', sites: ['app.example.test'], available: true }]);
  expect(listing.last_error.code).toBe('login_site_not_allowed');
});

test('a malformed or foreign envelope is refused without a request', async () => {
  requests.length = 0;
  for (const input of ['not json', JSON.stringify({ protocol: 'other.v1', type: 'credential.resolve' })]) {
    const run = await cli(['secrets', 'browser-plugin', '--project', 'synthetic'], input);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.out).success).toBe(false);
  }
  expect(requests).toEqual([]);
});

test('request --login sends the browser scope and its sites; a login with no site is refused', async () => {
  requests.length = 0;
  const run = await cli([
    'secrets', 'request', 'CRM_LOGIN', '--login', '--site', 'app.example.test', '--project', 'synthetic', '--json',
  ]);
  expect(run.code).toBe(0);
  expect(requests.map((r) => r.body)).toEqual([
    { names: ['CRM_LOGIN'], scope: 'browser', sites: ['app.example.test'] },
  ]);

  const noSite = await cli(['secrets', 'request', 'CRM_LOGIN', '--login', '--project', 'synthetic']);
  expect(noSite.code).toBe(2);
  expect(noSite.err).toContain('--site');
  const siteWithoutLogin = await cli(['secrets', 'request', 'API_KEY', '--site', 'a.example.test', '--project', 'synthetic']);
  expect(siteWithoutLogin.code).toBe(2);
});
