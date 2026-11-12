import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { join, resolve } from 'node:path';

/**
 * `kortix providers set | rm | ls` and provider keys (named accounts). With the
 * workspace flag `pooled_provider_secrets` on, a key lands where the web Models
 * panel lists it (`/secret-resources`); with it off, in the legacy workspace
 * secrets. Driven black-box through the real CLI process against a stub API:
 * what is pinned is the request that leaves the CLI and what it prints.
 */

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const PROJECT_ID = '00000000-0000-4000-8000-00000000a001';
const ME = '00000000-0000-4000-8000-00000000b001';
const TEAMMATE = '00000000-0000-4000-8000-00000000b002';
const BASE = `/v1/workspaces/${PROJECT_ID}`;
const KEYS = `${BASE}/secret-resources`;

interface Row {
  secret_id: string;
  label: string;
  provider_id: string;
  name: string;
  access_mode: 'project' | 'members';
  created_by: string;
  granted_user_ids: string[];
  verification?: { status: 'verified' | 'invalid' | 'unknown'; message: string; checked_at: string } | null;
}

interface Call { method: string; path: string; search: string; body: Record<string, unknown> }

let server: ReturnType<typeof Bun.serve>;
let calls: Call[] = [];
// Per-test stub state, reset in beforeEach.
let flagOn = true;
let rows: Row[] = [];
let legacy: string[] = [];
let createStatus = 201;
/** The check the API answers on create, as `secret-resources.ts` runs it. */
let createVerification: Row['verification'] = null;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function row(partial: Partial<Row> & Pick<Row, 'secret_id' | 'label'>): Row {
  return {
    provider_id: 'anthropic',
    name: 'ANTHROPIC_API_KEY',
    access_mode: 'project',
    created_by: ME,
    granted_user_ids: [ME],
    ...partial,
  };
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      calls.push({ method: req.method, path: url.pathname, search: url.search, body });
      const { pathname: path } = url;
      if (path === BASE && req.method === 'GET') {
        return json({ project_id: PROJECT_ID, account_id: 'acc-1', experimental: { pooled_provider_secrets: flagOn } });
      }
      if (path === '/v1/me') return json({ user_id: ME, email: 'me@example.test', accounts: [] });
      if (path === KEYS && req.method === 'GET') return json({ secrets: rows });
      if (path === KEYS && req.method === 'POST') {
        // Like the API: a key for anyone but the caller needs project.secret.write.
        if (createStatus === 403 && body.access_mode !== 'members') {
          return json({ error: 'Workspace secret write access required' }, 403);
        }
        const created = row({
          secret_id: `key-${rows.length + 1}`,
          label: String(body.label),
          provider_id: String(body.provider_id),
          name: String(body.name),
          access_mode: body.access_mode as Row['access_mode'],
          granted_user_ids: [ME, ...((body.user_ids as string[]) ?? [])],
          verification: createVerification,
        });
        rows.push(created);
        return json(created, 201);
      }
      const one = /^\/v1\/workspaces\/[^/]+\/secret-resources\/([^/]+)(\/value|\/access)?$/.exec(path);
      if (one) {
        const found = rows.find((r) => r.secret_id === one[1]);
        if (!found) return json({ error: 'Not found' }, 404);
        if (req.method === 'DELETE') return json({ ok: true });
        if (one[2] === '/value') return json(found);
        if (one[2] === '/access') {
          const ids = [...new Set([...((body.user_ids as string[]) ?? []), found.created_by])];
          return json({ ...found, access_mode: body.mode, granted_user_ids: ids });
        }
      }
      if (path === `${BASE}/secrets` && req.method === 'GET') return json({ items: legacy.map((name) => ({ name })) });
      if (path === `${BASE}/secrets` && req.method === 'POST') return json({ identifier: body.name, name: body.name });
      // The secrets route answers 200 whether or not the secret existed.
      if (path.startsWith(`${BASE}/secrets/`) && req.method === 'DELETE') return json({ ok: true });
      if (path === `${BASE}/oauth` && req.method === 'GET') return json({ items: [] });
      if (path.startsWith(`${BASE}/oauth/`) && req.method === 'DELETE') return json({ error: 'Not found' }, 404);
      return json({ error: `unexpected ${req.method} ${path}` }, 500);
    },
  });
});

afterAll(() => server.stop(true));

beforeEach(() => {
  flagOn = true;
  rows = [];
  legacy = [];
  createStatus = 201;
  createVerification = null;
});

async function runCli(args: string[]) {
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
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  // Writes only: GET reads and the client's HEAD reachability probe are not changes.
  const writes = calls.filter((c) => c.method !== 'GET' && c.method !== 'HEAD').map((c) => [c.method, c.path, c.body] as const);
  return { code, stdout, stderr, writes };
}

describe('providers set — flag on: a provider key under Models → Providers', () => {
  test('a new key is shared with everyone in the workspace by default', async () => {
    const r = await runCli(['set', 'anthropic', 'sk-ant-synthetic']);
    expect(r.code).toBe(0);
    expect(r.writes).toEqual([
      ['POST', KEYS, {
        project_id: PROJECT_ID,
        access_mode: 'project',
        user_ids: [],
        provider_id: 'anthropic',
        name: 'ANTHROPIC_API_KEY',
        label: 'Anthropic key',
        value: 'sk-ant-synthetic',
        consumer: 'llm_gateway',
        strategy: 'broker',
      }],
    ]);
    expect(r.stdout).toContain('Saved "Anthropic key" (ANTHROPIC_API_KEY) for anthropic');
    expect(r.stdout).toContain('Shared with everyone in this workspace.');
    expect(r.stdout).toContain('Models → Providers');
  });

  test('a key the provider refused stays saved, and the output says what the provider said', async () => {
    createVerification = { status: 'invalid', message: 'invalid x-api-key', checked_at: '2026-11-11T12:00:00.000Z' };
    const r = await runCli(['set', 'anthropic', 'sk-ant-synthetic']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Saved "Anthropic key"');
    expect(r.stdout).toContain('anthropic refused the key: invalid x-api-key');
    expect(r.stdout).toContain('kortix providers set anthropic');
  });

  test('a key the provider accepted says so; an unanswered check says it is not verified', async () => {
    createVerification = { status: 'verified', message: 'The provider accepted the key.', checked_at: '2026-11-11T12:00:00.000Z' };
    expect((await runCli(['set', 'anthropic', 'sk-ant-synthetic'])).stdout).toContain('anthropic accepted the key.');
    rows = [];
    createVerification = { status: 'unknown', message: 'Verification timed out', checked_at: '2026-11-11T12:00:00.000Z' };
    expect((await runCli(['set', 'anthropic', 'sk-ant-synthetic', '--label', 'Other'])).stdout).toContain('Not verified: Verification timed out');
  });

  test('--private sends only-me access (members, no other user) and --label names it', async () => {
    const r = await runCli(['set', 'openrouter', 'sk-or-synthetic', '--private', '--label', 'My OpenRouter key']);
    expect(r.code).toBe(0);
    expect(r.writes).toHaveLength(1);
    const [method, path, body] = r.writes[0]!;
    expect([method, path]).toEqual(['POST', KEYS]);
    expect(body).toMatchObject({
      access_mode: 'members',
      user_ids: [],
      provider_id: 'openrouter',
      name: 'OPENROUTER_API_KEY',
      label: 'My OpenRouter key',
    });
    expect(r.stdout).toContain('Saved "My OpenRouter key"');
    expect(r.stdout).toContain('Only you can use it.');
  });

  test('403 for a workspace-wide key names --private and saves nothing else', async () => {
    createStatus = 403;
    const r = await runCli(['set', 'anthropic', 'sk-ant-synthetic']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Workspace secret write access required');
    expect(r.stderr).toContain('project.secret.write');
    expect(r.stderr).toContain('--private');
    // One refused POST; no private retry and no legacy secret behind the caller's back.
    expect(r.writes.map(([m, p]) => [m, p])).toEqual([['POST', KEYS]]);
  });

  test('your key with the same label gets the new value instead of a second key', async () => {
    rows = [row({ secret_id: 'key-mine', label: 'Anthropic key' })];
    const r = await runCli(['set', 'anthropic', 'sk-ant-rotated']);
    expect(r.code).toBe(0);
    expect(r.writes).toEqual([['PUT', `${KEYS}/key-mine/value`, { value: 'sk-ant-rotated' }]]);
    expect(r.stdout).toContain('Replaced the value of "Anthropic key"');
  });

  test('--private on your shared key with the same label narrows it to you', async () => {
    rows = [row({ secret_id: 'key-mine', label: 'Anthropic key' })];
    const r = await runCli(['set', 'anthropic', 'sk-ant-rotated', '--private']);
    expect(r.code).toBe(0);
    expect(r.writes).toEqual([
      ['PUT', `${KEYS}/key-mine/value`, { value: 'sk-ant-rotated' }],
      ['PUT', `${KEYS}/key-mine/access`, { mode: 'members', user_ids: [] }],
    ]);
    expect(r.stdout).toContain('Only you can use it.');
  });

  test("a teammate's key with the same label is never rotated: a new key of yours instead", async () => {
    rows = [row({ secret_id: 'key-team', label: 'Anthropic key', created_by: TEAMMATE, granted_user_ids: [TEAMMATE] })];
    const r = await runCli(['set', 'anthropic', 'sk-ant-synthetic']);
    expect(r.code).toBe(0);
    expect(r.writes.map(([m, p]) => [m, p])).toEqual([['POST', KEYS]]);
  });

  test('bedrock stays two workspace secrets, and rejects --private', async () => {
    const r = await runCli(['set', 'bedrock', 'bedrock-token-synthetic', '--region', 'us-east-1']);
    expect(r.code).toBe(0);
    expect(r.writes.map(([m, p, b]) => [m, p, b.name])).toEqual([
      ['POST', `${BASE}/secrets`, 'AWS_BEARER_TOKEN_BEDROCK'],
      ['POST', `${BASE}/secrets`, 'AWS_REGION'],
    ]);
    const priv = await runCli(['set', 'bedrock', 'bedrock-token-synthetic', '--region', 'us-east-1', '--private']);
    expect(priv.code).toBe(2);
    expect(priv.stderr).toContain('--private and --label do not apply');
    expect(priv.writes).toEqual([]);
  });
});

describe('providers set — flag off: the legacy workspace secret, unchanged', () => {
  test('POST /secrets with the same body as before', async () => {
    flagOn = false;
    const r = await runCli(['set', 'anthropic', 'sk-ant-synthetic']);
    expect(r.code).toBe(0);
    expect(r.writes).toEqual([
      ['POST', `${BASE}/secrets`, { name: 'ANTHROPIC_API_KEY', value: 'sk-ant-synthetic', strategy: 'broker', consumer: 'llm_gateway' }],
    ]);
    expect(r.stdout).toContain('Saved ANTHROPIC_API_KEY for anthropic');
    expect(r.stdout).toContain('shared with everyone in this workspace');
  });

  test('--private is refused: a workspace secret would widen it to everyone', async () => {
    flagOn = false;
    const r = await runCli(['set', 'anthropic', 'sk-ant-synthetic', '--private']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--private and --label do not apply');
    expect(r.writes).toEqual([]);
  });
});

describe('providers rm and ls — provider keys', () => {
  const mine = row({ secret_id: 'key-mine', label: 'Anthropic key' });
  const team = row({ secret_id: 'key-team', label: 'Team key', created_by: TEAMMATE, granted_user_ids: [TEAMMATE, ME], access_mode: 'members' });
  const privateOne = row({ secret_id: 'key-priv', provider_id: 'groq', name: 'GROQ_API_KEY', label: 'My Groq key', access_mode: 'members' });

  test('rm deletes your own keys and only the legacy secrets that exist; others stay', async () => {
    rows = [mine, team];
    legacy = ['ANTHROPIC_API_KEY'];
    const r = await runCli(['rm', 'anthropic']);
    expect(r.code).toBe(0);
    expect(r.writes.map(([m, p]) => [m, p])).toEqual([
      ['DELETE', `${BASE}/secrets/ANTHROPIC_API_KEY`],
      ['DELETE', `${KEYS}/key-mine`],
    ]);
    expect(r.stdout).toContain('Removed secret ANTHROPIC_API_KEY + key "Anthropic key" for anthropic');
    expect(r.stdout).toContain('Keys others added stay: "Team key"');
  });

  test('rm skips a legacy secret that does not exist (its DELETE needs secret write access)', async () => {
    rows = [mine];
    const r = await runCli(['rm', 'anthropic']);
    expect(r.code).toBe(0);
    expect(r.writes.map(([m, p]) => [m, p])).toEqual([['DELETE', `${KEYS}/key-mine`]]);
  });

  test('rm --label removes only that key, whoever added it', async () => {
    rows = [mine, team];
    legacy = ['ANTHROPIC_API_KEY'];
    const r = await runCli(['rm', 'anthropic', '--label', 'Team key']);
    expect(r.code).toBe(0);
    expect(r.writes.map(([m, p]) => [m, p])).toEqual([['DELETE', `${KEYS}/key-team`]]);
    expect(r.stdout).toContain('Removed key "Team key" for anthropic');
  });

  test('rm --label with no such key exits 1 and lists the labels', async () => {
    rows = [mine];
    const r = await runCli(['rm', 'anthropic', '--label', 'Nope']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('No anthropic key is labeled "Nope"');
    expect(r.stderr).toContain('"Anthropic key"');
    expect(r.writes).toEqual([]);
  });

  test('rm with the flag off keeps the legacy removal unchanged', async () => {
    flagOn = false;
    const r = await runCli(['rm', 'anthropic']);
    expect(r.code).toBe(0);
    expect(r.writes.map(([m, p]) => [m, p])).toEqual([['DELETE', `${BASE}/secrets/ANTHROPIC_API_KEY`]]);
  });

  test('ls lists each provider key with who can use it; --json carries them as accounts', async () => {
    rows = [mine, team, privateOne];
    const r = await runCli(['ls']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Provider keys and accounts');
    expect(r.stdout).toMatch(/anthropic\s+Anthropic key\s+everyone in this workspace/);
    expect(r.stdout).toMatch(/anthropic\s+Team key\s+2 members/);
    expect(r.stdout).toMatch(/groq\s+My Groq key\s+only you/);
    const j = await runCli(['ls', '--json']);
    expect(j.code).toBe(0);
    expect((JSON.parse(j.stdout) as { accounts: Row[] }).accounts.map((a) => a.secret_id)).toEqual(['key-mine', 'key-team', 'key-priv']);
  });

  // A key added in the web dialog is a named account whatever the flag says:
  // the web lists it, so `ls` lists it too (an e2e run on dev missed one).
  test('ls lists provider keys with the flag off too, and reads no flag', async () => {
    flagOn = false;
    rows = [mine];
    const r = await runCli(['ls']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/anthropic\s+Anthropic key\s+everyone in this workspace/);
    expect(calls.some((c) => c.path === BASE && c.method === 'GET')).toBe(false);
    const j = await runCli(['ls', '--json']);
    expect((JSON.parse(j.stdout) as { accounts: Row[] }).accounts.map((a) => a.secret_id)).toEqual(['key-mine']);
  });
});

