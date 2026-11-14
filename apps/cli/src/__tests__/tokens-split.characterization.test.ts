import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSecrets } from '../commands/secrets.ts';
import {
  type FakeApi,
  runCommand,
  startFakeApi,
  writeConfig,
  writeRunner,
} from './support/account-cli-harness.ts';

// Characterization tests for KRTX-4807, written BEFORE the restructure: they
// pin the behavior the split moves and the helpers it dedupes. They test the
// public command surface only (runTokens / runKeys / runSecrets), so they
// compile and pass identically before and after:
//   - the SCOPE cell of a key row (custom, full, and the missing-scope
//     fallback) as `tokens ls` and `keys ls` render it;
//   - the exact egress_policy bodies `secrets delivery` builds for the broker
//     and enforced exposures;
//   - the table output of `tokens service-accounts ls` and `tokens apps ls`.
// Every expectation below was captured against the pre-split code.

const ACCOUNT = 'account_1';
const SA = '55555555-5555-4555-8555-555555555555';
const IAM = `/v1/workspaces/${ACCOUNT}/iam`;

// ── tokens ls / keys ls / service-accounts / apps through the real process ──

let tmp: string;
let runner: string;
let api: FakeApi | null = null;

const tokensRows = [
  {
    token_id: 'tok_custom',
    name: 'runner',
    project_id: 'p1',
    public_key: 'kx_pub_r',
    status: 'active',
    expires_at: null,
    last_used_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    revoked_at: null,
    scope: 'custom',
    workspace_permissions: ['workspace.session.read', 'workspace.session.start'],
  },
  {
    token_id: 'tok_full',
    name: 'laptop',
    project_id: null,
    public_key: 'kx_pub_l',
    status: 'active',
    expires_at: null,
    last_used_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    revoked_at: null,
    scope: 'full',
    workspace_permissions: null,
  },
  {
    // An older API omits scope: the cell must fall back to `full`.
    token_id: 'tok_legacy',
    name: 'legacy',
    project_id: null,
    public_key: 'kx_pub_o',
    status: 'active',
    expires_at: null,
    last_used_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    revoked_at: null,
  },
];

const keysRows = [
  {
    key_id: 'key_custom',
    name: 'runner',
    acts_as: { type: 'me', name: null, service_account_id: null },
    credential: 'token',
    public_key: 'kx_pub_r',
    status: 'active',
    expires_at: null,
    last_used_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    revoked_at: null,
    created_by_email: 'user@example.test',
    scope: 'custom',
    workspace_permissions: ['workspace.session.read', 'workspace.session.start'],
  },
  {
    key_id: 'key_full',
    name: 'laptop',
    acts_as: { type: 'me', name: null, service_account_id: null },
    credential: 'token',
    public_key: 'kx_pub_l',
    status: 'active',
    expires_at: null,
    last_used_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    revoked_at: null,
    created_by_email: 'user@example.test',
    scope: 'full',
    workspace_permissions: null,
  },
];

function boot(fakeRoutes: Parameters<typeof startFakeApi>[0]): string {
  api = startFakeApi(fakeRoutes);
  return writeConfig(tmp, api.url, ACCOUNT);
}

afterEach(() => {
  api?.stop();
  api = null;
  rmSync(tmp, { recursive: true, force: true });
});

describe('characterization: the SCOPE cell of a key row (KRTX-4807)', () => {
  test('tokens ls renders custom (n), full, and the missing-scope fallback full', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-char-tokens-'));
    runner = writeRunner(tmp, 'tokens.ts', 'runTokens');
    const config = boot((req, url) => {
      if (url.pathname === '/v1/me' && req.method === 'GET') {
        return Response.json({
          user_id: 'user_1',
          email: 'user@example.test',
          token_context: { auth_type: 'pat', token_id: 'tok_self' },
        });
      }
      if (url.pathname === '/v1/accounts/tokens' && req.method === 'GET') {
        return Response.json(tokensRows);
      }
      return undefined;
    });
    const table = await runCommand(runner, ['ls'], { cwd: tmp, configFile: config });
    expect(table.code).toBe(0);
    // Column order: NAME, PUBLIC KEY, STATUS, SCOPE, EXPIRES, TOKEN ID. The
    // scope cell shows the permission count for custom and `full` otherwise —
    // including the row whose API response omitted scope entirely.
    expect(table.stdout).toMatch(/runner\s+kx_pub_r\s+active\s+custom \(2\)\s+never\s+tok_custom/);
    expect(table.stdout).toMatch(/laptop\s+kx_pub_l\s+active\s+full\s+never\s+tok_full/);
    expect(table.stdout).toMatch(/legacy\s+kx_pub_o\s+active\s+full\s+never\s+tok_legacy/);
    expect(table.stdout).toContain('SCOPE');
  });

  test('keys ls renders the same cell for custom and full scopes', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-char-keys-'));
    runner = writeRunner(tmp, 'keys.ts', 'runKeys');
    const config = boot((req, url) => {
      if (url.pathname === '/v1/me' && req.method === 'GET') {
        return Response.json({
          user_id: 'user_1',
          email: 'user@example.test',
          token_context: { auth_type: 'pat', token_id: 'tok_self' },
        });
      }
      if (url.pathname === `/v1/workspaces/${ACCOUNT}/keys` && req.method === 'GET') {
        return Response.json({
          keys: keysRows,
          can_manage_principals: false,
          agents: [],
          bots: [],
        });
      }
      return undefined;
    });
    const table = await runCommand(runner, ['ls'], { cwd: tmp, configFile: config });
    expect(table.code).toBe(0);
    // Column order: NAME, ACTS AS, SCOPE, EXPIRES, LAST USED, KEY ID.
    expect(table.stdout).toMatch(/runner\s+you\s+custom \(2\)\s+never\s+never\s+key_custom/);
    expect(table.stdout).toMatch(/laptop\s+you\s+full\s+never\s+never\s+key_full/);
  });
});

describe('characterization: tokens service-accounts / apps tables (KRTX-4807)', () => {
  test('service-accounts ls renders the NAME/PREFIX/STATUS/EXPIRES/ID table', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-char-sa-'));
    runner = writeRunner(tmp, 'tokens.ts', 'runTokens');
    const config = boot((req, url) => {
      if (url.pathname === '/v1/me' && req.method === 'GET') {
        return Response.json({
          user_id: 'user_1',
          email: 'user@example.test',
          token_context: { auth_type: 'pat', token_id: 'tok_self' },
        });
      }
      if (url.pathname === `${IAM}/service-accounts` && req.method === 'GET') {
        return Response.json({
          service_accounts: [
            {
              service_account_id: SA,
              name: 'nightly',
              description: 'Cron',
              public_prefix: 'sa_abc',
              status: 'active',
              last_used_at: null,
              expires_at: null,
              created_at: '2026-01-01T00:00:00.000Z',
              disabled_at: null,
            },
            {
              service_account_id: '66666666-6666-4666-8666-666666666666',
              name: 'retired',
              description: null,
              public_prefix: 'sa_def',
              status: 'disabled',
              last_used_at: null,
              expires_at: '2027-01-01T00:00:00.000Z',
              created_at: '2026-01-01T00:00:00.000Z',
              disabled_at: '2026-02-01T00:00:00.000Z',
            },
          ],
        });
      }
      return undefined;
    });
    const table = await runCommand(runner, ['service-accounts', 'ls'], {
      cwd: tmp,
      configFile: config,
    });
    expect(table.code).toBe(0);
    expect(table.stdout).toContain('SERVICE ACCOUNT ID');
    expect(table.stdout).toMatch(
      /nightly\s+sa_abc\s+active\s+never\s+55555555-5555-4555-8555-555555555555/,
    );
    // A disabled row is not restyled away: the status prints yellow (stripped
    // under NO_COLOR) in its own column.
    expect(table.stdout).toMatch(
      /retired\s+sa_def\s+disabled\s+2027-01-01\s+66666666-6666-4666-8666-666666666666/,
    );
    expect(table.stdout).toContain('2 service accounts');
  });

  test('apps ls renders the NAME/SIGNS IN AT/LAST ACTIVE/CLIENT ID table', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-char-apps-'));
    runner = writeRunner(tmp, 'tokens.ts', 'runTokens');
    const config = boot((req, url) => {
      if (url.pathname === '/v1/me' && req.method === 'GET') {
        return Response.json({
          user_id: 'user_1',
          email: 'user@example.test',
          token_context: { auth_type: 'pat', token_id: 'tok_self' },
        });
      }
      if (url.pathname === '/v1/oauth/grants' && req.method === 'GET') {
        return Response.json({
          grants: [
            {
              client_id: 'app_verified',
              name: 'Editor',
              self_registered: false,
              redirect_hosts: ['editor.example.test'],
              granted_at: '2026-07-01T00:00:00.000Z',
              last_active_at: '2026-08-01T00:00:00.000Z',
            },
            {
              client_id: 'app_self',
              name: 'Hand-rolled',
              self_registered: true,
              redirect_hosts: [],
              granted_at: '2026-07-15T00:00:00.000Z',
              last_active_at: null,
            },
          ],
        });
      }
      return undefined;
    });
    const table = await runCommand(runner, ['apps', 'ls'], { cwd: tmp, configFile: config });
    expect(table.code).toBe(0);
    expect(table.stdout).toContain('SIGNS IN AT');
    expect(table.stdout).toMatch(/Editor\s+editor\.example\.test\s+2026-08-01\s+app_verified/);
    // A self-registered app carries the (unverified) flag in the name cell,
    // and a never-active one falls back to granted_at.
    expect(table.stdout).toMatch(/Hand-rolled \(unverified\)\s+-\s+2026-07-15\s+app_self/);
    expect(table.stdout).toContain('2 apps');
  });
});

// ── secrets delivery policy bodies, in-process with a mocked fetch ──────────

const ORIGINAL_FETCH = globalThis.fetch;

const ENV_KEYS = [
  'KORTIX_TOKEN',
  'KORTIX_API_URL',
  'KORTIX_PROJECT_ID',
  'KORTIX_DISABLE_SANDBOX_ENV_FILE',
  'KORTIX_CONFIG_FILE',
  'KORTIX_AUTH_FILE',
] as const;

let saved: Record<string, string | undefined>;
let originalCwd: string;
let stdoutSpy: ReturnType<typeof spyOn> | null = null;
let stderrSpy: ReturnType<typeof spyOn> | null = null;
let stdout = '';
let stderr = '';
let requests: Array<{ url: string; method: string; body: unknown }> = [];

function captureOutput() {
  stdout = '';
  stderr = '';
  stdoutSpy?.mockRestore();
  stderrSpy?.mockRestore();
  stdoutSpy = spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  stderrSpy = spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('characterization: the egress_policy bodies `secrets delivery` builds (KRTX-4807)', () => {
  beforeEach(() => {
    saved = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';
    process.env.KORTIX_PROJECT_ID = 'proj_1';
    originalCwd = process.cwd();
    tmp = mkdtempSync(join(tmpdir(), 'kortix-char-delivery-'));
    process.chdir(tmp);
    const file = join(tmp, 'config.json');
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    writeFileSync(
      file,
      JSON.stringify({
        active: 'test',
        hosts: {
          test: {
            url: 'https://api.test',
            token: 'tok_test',
            user_id: 'user_1',
            user_email: 'user@example.test',
            account_id: 'account_1',
            logged_in_at: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
      'utf8',
    );
    process.env.KORTIX_CONFIG_FILE = file;
    captureOutput();
    requests = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      let body: unknown = undefined;
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      requests.push({ url, method, body });
      if (url.endsWith('/me') && method === 'GET') {
        return json({ user_id: 'user_1', email: 'user@example.test' });
      }
      if (url.endsWith('/workspaces/proj_1') && method === 'GET') {
        return json({ project_id: 'proj_1', account_id: 'account_1' });
      }
      if (
        url.includes('/workspaces/proj_1/secrets/') &&
        url.endsWith('/strategy') &&
        method === 'PUT'
      ) {
        return json({
          identifier: 'ANTHROPIC_API_KEY',
          strategy: (body as { strategy: string }).strategy,
        });
      }
      return new Response(JSON.stringify({ error: `unexpected ${method} ${url}` }), {
        status: 500,
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    stdoutSpy?.mockRestore();
    stdoutSpy = null;
    stderrSpy?.mockRestore();
    stderrSpy = null;
    process.chdir(originalCwd);
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  test('broker: host rules with methods+path, the header slot, deny + terminate', async () => {
    const code = await runSecrets([
      'delivery',
      'ANTHROPIC_API_KEY',
      'broker',
      '--allow-host',
      'api.anthropic.com',
      '--allow-host',
      '*.anthropic.com',
      '--allow-method',
      'POST',
      '--allow-path',
      '/v1/*',
      '--inject-header',
      'x-api-key',
      '--template',
      '{{secret}}',
      '--handle-prefix',
      'sk-ant-api03-',
    ]);
    expect(code).toBe(0);
    const put = requests.find((r) => r.method === 'PUT');
    expect((put?.body as { egress_policy: unknown }).egress_policy).toEqual({
      backend: 'kortix_fetch',
      rules: [
        { host: 'api.anthropic.com', methods: ['POST'], path: '/v1/*' },
        { host: '*.anthropic.com', methods: ['POST'], path: '/v1/*' },
      ],
      inject: { kind: 'header', name: 'x-api-key', template: '{{secret}}' },
      on_no_match: 'deny',
      tls: 'terminate',
    });
  });

  test('enforced: hosts-only rules; --inject-header adds exactly the legacy slot', async () => {
    const hostsOnly = await runSecrets([
      'delivery',
      'ANTHROPIC_API_KEY',
      'enforced',
      '--allow-host',
      'api.anthropic.com',
    ]);
    expect(hostsOnly).toBe(0);
    const put = requests.find((r) => r.method === 'PUT');
    expect((put?.body as { egress_policy: unknown }).egress_policy).toEqual({
      rules: [{ host: 'api.anthropic.com' }],
      on_no_match: 'deny',
      tls: 'terminate',
    });

    requests = [];
    captureOutput();
    const withHeader = await runSecrets([
      'delivery',
      'ANTHROPIC_API_KEY',
      'enforced',
      '--allow-host',
      'api.anthropic.com',
      '--inject-header',
      'x-api-key',
      '--template',
      '{{secret}}',
    ]);
    expect(withHeader).toBe(0);
    const put2 = requests.find((r) => r.method === 'PUT');
    expect((put2?.body as { egress_policy: unknown }).egress_policy).toEqual({
      rules: [{ host: 'api.anthropic.com' }],
      inject: { kind: 'header', name: 'x-api-key', template: '{{secret}}' },
      on_no_match: 'deny',
      tls: 'terminate',
    });
  });

  test('an empty --inject-header value is no header slot, exactly as the base built it', async () => {
    // G9 item on the first head: the builders test TRUTHINESS of
    // --inject-header. The `--inject-header=` (equals) form is the one input
    // that reaches them with an empty value — takeFlagValue refuses an empty
    // value only in the separate-token form — so an undefined check instead
    // of a truthiness check sent an empty-name header slot. With only an
    // empty --inject-header the broker row still takes the legacy
    // json_body_field slot (the base's own fall-through), and an enforced
    // policy carries no inject at all.
    const broker = await runSecrets([
      'delivery',
      'ANTHROPIC_API_KEY',
      'broker',
      '--allow-host',
      'api.anthropic.com',
      '--inject-header=',
    ]);
    expect(broker).toBe(0);
    const put = requests.find((r) => r.method === 'PUT');
    expect((put?.body as { egress_policy: { inject?: unknown } }).egress_policy.inject).toEqual({
      kind: 'json_body_field',
    });

    requests = [];
    captureOutput();
    const enforced = await runSecrets([
      'delivery',
      'ANTHROPIC_API_KEY',
      'enforced',
      '--allow-host',
      'api.anthropic.com',
      '--inject-header=',
    ]);
    expect(enforced).toBe(0);
    const put2 = requests.find((r) => r.method === 'PUT');
    expect((put2?.body as { egress_policy: Record<string, unknown> }).egress_policy).toEqual({
      rules: [{ host: 'api.anthropic.com' }],
      on_no_match: 'deny',
      tls: 'terminate',
    });
  });

  test('the duplicated usage guards still fire exactly as before', async () => {
    // --template without --inject-header (broker path)
    const brokerGuard = await runSecrets([
      'delivery',
      'ANTHROPIC_API_KEY',
      'broker',
      '--allow-host',
      'api.anthropic.com',
      '--inject-query',
      'q',
      '--template',
      '{{secret}}',
    ]);
    expect(brokerGuard).toBe(2);
    expect(stderr).toContain('--template requires --inject-header.');

    // --template without --inject-header (enforced path)
    requests = [];
    captureOutput();
    const egressGuard = await runSecrets([
      'delivery',
      'ANTHROPIC_API_KEY',
      'enforced',
      '--allow-host',
      'api.anthropic.com',
      '--template',
      '{{secret}}',
    ]);
    expect(egressGuard).toBe(2);
    expect(stderr).toContain('--template requires --inject-header.');
  });
});
