import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// A guided setup (/setup.md) reports its milestones to POST /v1/cli/setup-events:
// `kortix plan` starts a run, `kortix templates add` reports inside it, and
// nothing is sent outside a run or with DO_NOT_TRACK=1. The real CLI runs
// against a fake API that records each request.

const CLI_ENTRY = join(resolve(import.meta.dir, '..', '..'), 'src', 'index.ts');
// Variables of the agent that runs this test suite: each case sets its own.
const AGENT_VARS = ['AI_AGENT', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_THREAD_ID', 'CODEX_MANAGED_BY_NPM', 'CURSOR_AGENT', 'CURSOR_TRACE_ID', 'GEMINI_CLI', 'OPENCODE', 'KORTIX_SUPERVISED', 'KORTIX_SESSION_ID', 'KORTIX_TOKEN', 'KORTIX_API_URL', 'KORTIX_PROJECT_ID', 'DO_NOT_TRACK', 'KORTIX_TELEMETRY'];

interface Sent { auth: string | null; client: string | null; body: Record<string, unknown> }
let server: ReturnType<typeof Bun.serve>;
let sent: Sent[] = [];
let repo: string;
let home: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === 'POST' && url.pathname === '/v1/cli/setup-events') {
        sent.push({ auth: req.headers.get('authorization'), client: req.headers.get('x-kortix-client-version'), body: (await req.json()) as Record<string, unknown> });
        return Response.json({ accepted: true }, { status: 202 });
      }
      return Response.json({ error: 'Not found' }, { status: 404 });
    },
  });
});
afterAll(() => server.stop(true));

beforeEach(() => {
  sent = [];
  repo = mkdtempSync(join(tmpdir(), 'kortix-setup-telemetry-'));
  home = join(repo, '.home');
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/shop.git'], { cwd: repo });
  spawnSync('mkdir', ['-p', home]);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ active: 'fake', hosts: { fake: { url: `http://127.0.0.1:${server.port}`, token: 'kortix_pat_test0000' } } }));
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

/** Async: the fake API runs in this process, so a blocking spawn would starve it. */
async function kortix(args: string[], extra: Record<string, string> = {}) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !AGENT_VARS.includes(key)) env[key] = value;
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: home, KORTIX_CONFIG_FILE: join(home, 'config.json'), KORTIX_NO_UPDATE_CHECK: '1', NO_COLOR: '1', KORTIX_NO_BROWSER: '1' }, extra);
  const proc = Bun.spawn(['bun', CLI_ENTRY, ...args], { cwd: repo, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

test('plan starts a run and templates add reports inside it, with the agent, the CLI version and the person token', async () => {
  const plan = await kortix(['plan', '--json'], { AI_AGENT: 'claude-code_2-1-0_agent' });
  expect(plan.code).toBe(0);
  expect(JSON.parse(plan.stdout)).toHaveProperty('kortix');
  expect(sent).toHaveLength(1);
  const started = sent[0]!;
  expect(started.auth).toBe('Bearer kortix_pat_test0000');
  expect(started.client).toMatch(/^cli\//);
  expect(started.body).toMatchObject({ event: 'setup_started', agent: 'claude_code', properties: { has_workspace: false, has_manifest: false } });
  expect(started.body.setup_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(existsSync(join(home, 'setup-run.json'))).toBe(true);

  const add = await kortix(['templates', 'add', 'software-factory', '--json'], { CLAUDECODE: '1' });
  expect(add.code).toBe(0);
  expect(JSON.parse(add.stdout)).toMatchObject({ template: 'software-factory' });
  expect(sent).toHaveLength(2);
  expect(sent[1]!.body).toMatchObject({ event: 'setup_template_added', setup_id: started.body.setup_id, agent: 'claude_code', properties: { template: 'software-factory' } });

  // The same setup a minute later: plan keeps the run.
  await kortix(['plan', '--json']);
  expect(sent[2]!.body).toMatchObject({ event: 'setup_started', setup_id: started.body.setup_id, agent: 'none' });
});

test('outside a run, and with DO_NOT_TRACK=1, nothing is sent', async () => {
  const add = await kortix(['templates', 'add', 'marketing', '--json']);
  expect(add.code).toBe(0);
  expect(sent).toHaveLength(0);

  const plan = await kortix(['plan', '--json'], { DO_NOT_TRACK: '1' });
  expect(plan.code).toBe(0);
  expect(sent).toHaveLength(0);
  expect(existsSync(join(home, 'setup-run.json'))).toBe(false);
});
