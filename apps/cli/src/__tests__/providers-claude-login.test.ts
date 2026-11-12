import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { join, resolve } from 'node:path';

/**
 * `kortix providers login claude` and who can use the new Claude account: the
 * whole workspace when the caller holds `project.secret.write` (the web's
 * default), only the caller otherwise or with `--private`. Driven black-box
 * through the real CLI process against a stub API.
 */

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const PROJECT_ID = '00000000-0000-4000-8000-00000000a001';
const ME = '00000000-0000-4000-8000-00000000b001';
const BASE = `/v1/workspaces/${PROJECT_ID}`;
const TOKEN = 'sk-ant-oat01-synthetic';

interface Call { method: string; path: string; body: Record<string, unknown> }

let server: ReturnType<typeof Bun.serve>;
let calls: Call[] = [];
/** The caller's own `project.secret.write` verdict; 'error' answers the probe with a 500. */
let mayShare: boolean | 'error' = true;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      calls.push({ method: req.method, path: url.pathname, body });
      const { pathname: path } = url;
      if (path === '/v1/me') return json({ user_id: ME, email: 'me@example.test', accounts: [] });
      // The SDK probe: `/accounts/:id/iam/…`, sent on its canonical `/workspaces/:id/iam/…` name.
      if (/^\/v1\/(?:workspaces|accounts)\/[^/]+\/iam\/members\/[^/]+\/effective:batch$/.test(path)) {
        if (mayShare === 'error') return json({ error: 'synthetic failure' }, 500);
        const probes = (body.probes as Array<Record<string, unknown>>) ?? [];
        return json({
          results: probes.map((p) => ({ action: p.action, resource_type: p.resourceType, resource_id: p.resourceId, allowed: mayShare, reason: null })),
        });
      }
      if (path === `${BASE}/claude-subscription/token` && req.method === 'PUT') return json({ connected: true, secret_id: 'claude-1' });
      if (path === `${BASE}/claude-subscription/login/start` && req.method === 'POST') {
        return json({ flow_id: 'flow-1', authorize_url: 'https://claude.example.test/authorize', expires_at: '2999-01-01T00:00:00.000Z' });
      }
      if (path === `${BASE}/claude-subscription/login/complete` && req.method === 'POST') return json({ connected: true, secret_id: 'claude-2' });
      if (path === BASE) return json({ project_id: PROJECT_ID, account_id: 'acc-1' });
      return json({ error: `unexpected ${req.method} ${path}` }, 500);
    },
  });
});

afterAll(() => server.stop(true));

beforeEach(() => {
  mayShare = true;
});

async function runCli(args: string[], stdin?: string) {
  calls = [];
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, 'providers', ...args, '--project', PROJECT_ID],
    cwd: CLI_ROOT,
    env: {
      ...(process.env as Record<string, string>),
      KORTIX_TOKEN: 'kortix_pat_test',
      KORTIX_API_URL: `http://127.0.0.1:${server.port}/v1`,
      KORTIX_PROJECT_ID: PROJECT_ID,
      KORTIX_NO_UPDATE_CHECK: '1',
      KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      // openInBrowser is a no-op under CI: the browser sign-in never opens the host's browser.
      CI: '1',
    },
    stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const probes = calls.filter((c) => c.path.endsWith('/effective:batch'));
  // Writes only: GET reads, the client's HEAD reachability probe and the IAM probe (a POST read) are not changes.
  const writes = calls
    .filter((c) => c.method !== 'GET' && c.method !== 'HEAD' && !probes.includes(c))
    .map((c) => [c.method, c.path, c.body] as const);
  return { code, stdout, stderr, writes, probes };
}

describe('providers login claude — who can use the new Claude account', () => {
  test('shared with everyone in the workspace when the caller has project.secret.write', async () => {
    const r = await runCli(['login', 'claude', '--token-stdin'], TOKEN);
    expect(r.code).toBe(0);
    expect(r.probes.map((c) => c.body)).toEqual([
      { probes: [{ action: 'project.secret.write', resourceType: 'project', resourceId: PROJECT_ID }] },
    ]);
    expect(r.probes[0]!.path).toContain(`/iam/members/${ME}/effective:batch`);
    expect(r.writes).toEqual([['PUT', `${BASE}/claude-subscription/token`, { token: TOKEN, sharing: { mode: 'project' } }]]);
    expect(r.stdout).toContain('Added a Claude account: shared with everyone in this workspace.');
  });

  test('only the caller without project.secret.write', async () => {
    mayShare = false;
    const r = await runCli(['login', 'claude', '--token-stdin'], TOKEN);
    expect(r.code).toBe(0);
    expect(r.writes).toEqual([['PUT', `${BASE}/claude-subscription/token`, { token: TOKEN, sharing: { mode: 'private' } }]]);
    expect(r.stdout).toContain('Added a Claude account: only you can use it.');
  });

  test('a failed probe counts as not allowed: only the caller', async () => {
    mayShare = 'error';
    const r = await runCli(['login', 'claude', '--token-stdin'], TOKEN);
    expect(r.code).toBe(0);
    expect(r.writes).toEqual([['PUT', `${BASE}/claude-subscription/token`, { token: TOKEN, sharing: { mode: 'private' } }]]);
  });

  test('--private forces only-me and asks no permission', async () => {
    const r = await runCli(['login', 'claude', '--token-stdin', '--private'], TOKEN);
    expect(r.code).toBe(0);
    expect(r.probes).toEqual([]);
    expect(r.writes).toEqual([['PUT', `${BASE}/claude-subscription/token`, { token: TOKEN, sharing: { mode: 'private' } }]]);
    expect(r.stdout).toContain('only you can use it');
  });

  test('the browser sign-in sends the same sharing and says so before the approval', async () => {
    // An empty line for the code, so nothing reaches login/complete.
    const r = await runCli(['login', 'claude'], '\n');
    expect(r.code).toBe(2);
    expect(r.writes).toEqual([['POST', `${BASE}/claude-subscription/login/start`, { sharing: { mode: 'project' } }]]);
    expect(r.stdout).toContain('The new Claude account: shared with everyone in this workspace (pass --private to keep it to you).');
    expect(r.stderr).toContain('No code entered');
  });

  test('stdin that closes at the code prompt exits 1 and says how to finish, storing nothing', async () => {
    for (const stdin of ['', undefined]) {
      const r = await runCli(['login', 'claude'], stdin);
      expect(r.code).toBe(1);
      expect(r.writes).toEqual([['POST', `${BASE}/claude-subscription/login/start`, { sharing: { mode: 'project' } }]]);
      expect(r.stderr).toContain('stdin closed before a code arrived');
      expect(r.stderr).toContain('--token-stdin');
      expect(r.stdout).not.toContain('Connected your Claude subscription');
    }
  });

  test('a piped code with no newline still completes the sign-in', async () => {
    const r = await runCli(['login', 'claude'], 'code-from-claude');
    expect(r.writes).toEqual([
      ['POST', `${BASE}/claude-subscription/login/start`, { sharing: { mode: 'project' } }],
      ['POST', `${BASE}/claude-subscription/login/complete`, { flow_id: 'flow-1', code: 'code-from-claude' }],
    ]);
    expect(r.code).toBe(0);
  });

  test('--private on another login provider is a usage error', async () => {
    const r = await runCli(['login', 'openai', '--private']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--private works with `kortix providers login claude` only');
    expect(r.writes).toEqual([]);
  });
});
