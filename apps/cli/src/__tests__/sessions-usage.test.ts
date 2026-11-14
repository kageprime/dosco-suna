/**
 * Real CLI process runs for `kortix sessions usage <id>`: the actual
 * `index.ts` binary against a fake API. Proves the command reads the session
 * usage tree route, passes it through verbatim with `--json`, prints paid
 * wallet / BYOK provider / total as three separate labelled numbers per session
 * and in total, reports hidden and truncated subtrees, and fails cleanly.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ENTRY = join(resolve(import.meta.dir, '..', '..'), 'src', 'index.ts');
const PROJECT = '00000000-0000-4000-a000-000000000301';
const ACCOUNT = '00000000-0000-4000-a000-000000000101';
const ROOT = '00000000-0000-4000-a000-000000000601';
const CHILD = '00000000-0000-4000-a000-000000000602';

const totals = (o: Partial<Record<string, number>> = {}) => ({
  cost: 0,
  kortix_cost: 0,
  provider_cost: 0,
  request_count: 0,
  error_count: 0,
  input_tokens: 0,
  output_tokens: 0,
  cached_tokens: 0,
  cache_write_tokens: 0,
  ...o,
});

let tree: Record<string, unknown>;
let usageStatus = 200;
let seen: string[] = [];
let tmp = '';
let server: ReturnType<typeof Bun.serve> | null = null;

function sessionRow() {
  return {
    session_id: ROOT,
    account_id: ACCOUNT,
    project_id: PROJECT,
    branch_name: ROOT,
    base_ref: 'main',
    sandbox_provider: 'daytona',
    name: 'root',
    agent_name: 'engineering',
    status: 'stopped',
    error: null,
    metadata: {},
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function startServer(): string {
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      seen.push(`${req.method} ${path}`);
      const base = `/v1/workspaces/${PROJECT}/sessions/${ROOT}`;
      if (req.method === 'GET' && path === base) return Response.json(sessionRow());
      if (req.method === 'GET' && path === `${base}/usage`) {
        return usageStatus === 200
          ? Response.json(tree)
          : Response.json({ error: 'Forbidden' }, { status: usageStatus });
      }
      return Response.json({ error: `not found ${req.method} ${path}` }, { status: 404 });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

function writeConfig(apiBase: string): string {
  const path = join(tmp, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: apiBase,
          token: 'kortix_pat_usage',
          user_id: 'user-1',
          user_email: 'user@example.test',
          account_id: ACCOUNT,
          logged_in_at: '2026-01-01T00:00:00.000Z',
        },
      },
    }),
    'utf8',
  );
  return path;
}

async function runCli(args: string[], configFile: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    KORTIX_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    KORTIX_CONFIG_FILE: configFile,
  };
  for (const key of [
    'KORTIX_API_URL',
    'KORTIX_CLI_TOKEN',
    'KORTIX_FRONTEND_URL',
    'KORTIX_PROJECT_ID',
    'KORTIX_TOKEN',
    'KORTIX_SESSION_ID',
  ]) {
    delete env[key];
  }
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: tmp,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, out: stdout + stderr };
}

const P = ['--project', PROJECT];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kortix-sessions-usage-'));
  seen = [];
  usageStatus = 200;
  tree = {
    session_id: ROOT,
    currency: 'USD',
    total: totals({
      cost: 3.25,
      kortix_cost: 3,
      provider_cost: 0.25,
      request_count: 5,
      input_tokens: 9000,
      output_tokens: 900,
      cached_tokens: 4000,
      cache_write_tokens: 100,
    }),
    sessions: [
      {
        ...totals({
          cost: 2,
          kortix_cost: 2,
          request_count: 3,
          input_tokens: 6000,
          output_tokens: 600,
          cached_tokens: 3000,
        }),
        session_id: ROOT,
        parent_session_id: null,
        depth: 0,
        title: 'root',
        agent_name: 'engineering',
        status: 'stopped',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        ...totals({
          cost: 1.25,
          kortix_cost: 1,
          provider_cost: 0.25,
          request_count: 2,
          error_count: 7,
          input_tokens: 3000,
          output_tokens: 300,
          cached_tokens: 1000,
          cache_write_tokens: 100,
        }),
        session_id: CHILD,
        parent_session_id: ROOT,
        depth: 1,
        title: 'child',
        agent_name: 'reviewer',
        status: 'completed',
        created_at: '2026-01-01T00:01:00.000Z',
      },
    ],
    hidden_sessions: 0,
    truncated: false,
  };
});

afterEach(() => {
  server?.stop(true);
  server = null;
  rmSync(tmp, { recursive: true, force: true });
});

describe('kortix sessions usage (real process)', () => {
  test('--json reads the usage tree route and passes it through verbatim', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['sessions', 'usage', ROOT, '--json', ...P], config);
    expect(r.code).toBe(0);
    expect(seen).toContain(`GET /v1/workspaces/${PROJECT}/sessions/${ROOT}/usage`);
    expect(JSON.parse(r.stdout)).toEqual(tree);
  });

  test('the table keeps paid wallet, BYOK provider and total separate, root and children', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['sessions', 'usage', ROOT, ...P], config);
    expect(r.code).toBe(0);
    expect(r.out).toContain('2 sessions');
    expect(r.out).toContain('PAID WALLET $3.00');
    expect(r.out).toContain('BYOK PROVIDER $0.25');
    expect(r.out).toContain('TOTAL $3.25');
    expect(r.out).toContain('tokens in/out/cached/write: 9,000/900/4,000/100');
    expect(r.out).toContain('never as paid spend');
    // Each session prints its own split, the child indented under the root.
    expect(r.out).toMatch(/root\s+\$2\.00\s+paid \$2\.00 · byok \$0\.00/);
    expect(r.out).toMatch(/ {2}child\s+\$1\.25\s+paid \$1\.00 · byok \$0\.25/);
    // Per-session errors and cache-write tokens are printed, not only the totals.
    expect(r.out).toMatch(/child.*2 req · 7 err · .*cached 1,000 · cache-write 100 /);
  });

  test('hidden and truncated subtrees are reported, never silently dropped', async () => {
    tree = { ...tree, hidden_sessions: 3, truncated: true };
    const config = writeConfig(startServer());
    const r = await runCli(['sessions', 'usage', ROOT, ...P], config);
    expect(r.code).toBe(0);
    expect(r.out).toContain('3 descendant session(s) you may not open are not counted');
    expect(r.out).toContain('totals are partial');
  });

  test('a member-set title or agent name cannot inject terminal escapes into the table', async () => {
    const sessions = tree.sessions as Array<Record<string, unknown>>;
    sessions[1] = {
      ...sessions[1],
      title: 'evil\x1b[2J\x1b[1;1Hforged\u202e',
      agent_name: 'bad\x07agent',
    };
    const config = writeConfig(startServer());
    const r = await runCli(['sessions', 'usage', ROOT, ...P], config);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('\x1b[2J');
    expect(r.stdout).not.toContain('\x1b[1;1H');
    expect(r.stdout).not.toContain('\u202e');
    expect(r.stdout).not.toContain('\x07');
    expect(r.stdout).toContain('evilforged?');
    expect(r.stdout).toContain('bad?agent');
  });

  test('a refused read exits non-zero with the API error', async () => {
    usageStatus = 403;
    const config = writeConfig(startServer());
    const r = await runCli(['sessions', 'usage', ROOT, ...P], config);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('Forbidden');
  });

  test('no session id exits 2 with the usage', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['sessions', 'usage', ...P], config);
    expect(r.code).toBe(2);
    expect(r.out).toContain('Usage: kortix sessions usage');
  });
});
