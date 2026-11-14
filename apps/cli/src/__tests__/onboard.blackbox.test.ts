/**
 * `kortix onboard --yes --json` and `kortix doctor --loops --fix` as real CLI
 * processes against a fake API on a real port and a fake `gh` on PATH.
 * 2026-11-10: onboarding was 13 hand-run steps; one run of these commands now
 * makes kortix.yaml real and says exactly what a person still has to do.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ENTRY = join(resolve(import.meta.dir, '..', '..'), 'src', 'index.ts');
const PROJECT_ID = '00000000-0000-4000-a000-000000000901';
const ACCOUNT_ID = '00000000-0000-4000-a000-000000000902';
const BASE = `/v1/workspaces/${PROJECT_ID}`;
const EX = `/v1/connectors/workspaces/${PROJECT_ID}`;
const LOCAL_VALUE = 'synthetic-local-token-4f1c';
const REPO = 'synthetic-owner/synthetic-repo';

const MANIFEST = `default_agent: dev
env:
  required: [LOCAL_TOKEN, PERSON_KEY]
agents:
  dev:
    description: "Synthetic agent"
    mode: primary
    prompt: "You work on the synthetic repo."
    connectors: [kortix_slack, tickets]
sandbox:
  default: dev
  templates:
    - slug: dev
      dockerfile: .kortix/sandbox/Dockerfile
connectors:
  - slug: tickets
    provider: mcp
    url: https://mcp.example.test/sse
triggers:
  - slug: issues-labeled
    on:
      webhook: { secret: GH_HOOK_SECRET }
    filter:
      headers.github_event: { in: [issues, issue_comment] }
      body.label.name: kortix
    run:
      agent: dev
      prompt: "Issue {{ body.issue.number }}"
  - slug: nightly
    on:
      cron: "0 0 3 * * *"
    run:
      agent: dev
      prompt: "Nightly"
`;

// A fake `gh`: hooks and labels live in one JSON file; every call is logged with its stdin.
const FAKE_GH = `
const fs = require('node:fs');
const dir = process.env.FAKE_GH_DIR;
const statePath = dir + '/gh-state.json';
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { hooks: [], labels: [] };
const args = process.argv.slice(2);
const input = args.includes('--input') ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(dir + '/gh-calls.log', JSON.stringify({ args, input }) + '\\n');
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
if (args[0] === 'auth') process.exit(0);
const path = args.find((a) => a.startsWith('repos/'));
const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET';
const hookId = path && path.match(/hooks\\/(\\d+)$/);
if (path && path.endsWith('/hooks') && method === 'GET') { process.stdout.write(JSON.stringify(state.hooks.map((h) => ({ id: h.id, config: { url: h.url }, events: h.events, active: true, last_response: { code: null } })))); process.exit(0); }
if (path && path.endsWith('/hooks') && method === 'POST') { const b = JSON.parse(input); state.hooks.push({ id: state.hooks.length + 1, url: b.config.url, events: b.events, secret: b.config.secret }); save(); process.stdout.write('{}'); process.exit(0); }
if (hookId && method === 'PATCH') { const b = JSON.parse(input); const h = state.hooks.find((x) => x.id === Number(hookId[1])); Object.assign(h, { url: b.config.url, events: b.events, secret: b.config.secret }); save(); process.stdout.write('{}'); process.exit(0); }
const label = path && path.match(/labels\\/(.+)$/);
if (label) process.exit(state.labels.includes(decodeURIComponent(label[1])) ? 0 : 1);
if (path && path.endsWith('/labels') && method === 'POST') { state.labels.push(args.find((a) => a.startsWith('name=')).slice(5)); save(); process.exit(0); }
process.stderr.write('fake gh: unhandled ' + args.join(' ')); process.exit(2);
`;

let root = '';
let repoDir = '';
let server: ReturnType<typeof Bun.serve> | null = null;
let hits: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
/** Server-side state the fake API serves. */
let api: {
  secrets: Map<string, string>;
  triggers: string[];
  slackInstalled: boolean;
  connectorState: string;
  ready: boolean;
  buildStarted: boolean;
};

function git(args: string[], cwd: string) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

async function runCli(args: string[]) {
  const binDir = join(root, 'bin');
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    FAKE_GH_DIR: root,
    KORTIX_CONFIG_FILE: join(root, 'config.json'),
    KORTIX_NO_UPDATE_CHECK: '1',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };
  for (const key of ['KORTIX_API_URL', 'KORTIX_TOKEN', 'KORTIX_CLI_TOKEN', 'KORTIX_PROJECT_ID', 'GH_TOKEN', 'GITHUB_TOKEN']) delete env[key];
  const child = Bun.spawn({ cmd: [process.execPath, CLI_ENTRY, ...args], cwd: repoDir, env, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

function ghState(): { hooks: Array<{ id: number; url: string; events: string[]; secret: string }>; labels: string[] } {
  const path = join(root, 'gh-state.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { hooks: [], labels: [] };
}

const posts = (path: string) => hits.filter((h) => h.method === 'POST' && h.path === path);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kortix-onboard-'));
  repoDir = join(root, 'repo');
  hits = [];
  api = { secrets: new Map(), triggers: ['issues-labeled', 'nightly'], slackInstalled: false, connectorState: 'needs_account', ready: true, buildStarted: false };

  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin', 'gh'), `#!${process.execPath}\n${FAKE_GH}`);
  chmodSync(join(root, 'bin', 'gh'), 0o755);

  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      const body = request.method === 'POST' ? ((await request.json().catch(() => null)) as Record<string, unknown> | null) : null;
      hits.push({ method: request.method, path, body });
      const origin = `http://127.0.0.1:${server!.port}`;
      if (path === `${BASE}/secrets` && request.method === 'GET') {
        return Response.json({ items: [...api.secrets.keys()].map((name) => ({ name, configured: true })), required: [], optional: [] });
      }
      if (path === `${BASE}/secrets` && request.method === 'POST') {
        api.secrets.set(String(body?.name), String(body?.value));
        return Response.json({ name: body?.name, configured: true });
      }
      if (path === `${BASE}/secret-requests`) return Response.json({ url: `${origin}/intake/req-1`, names: body?.names, scope: body?.scope, expires_at: '2026-11-17T00:00:00.000Z' });
      if (path === `${BASE}/triggers`) {
        return Response.json({ triggers: api.triggers.map((slug) => ({ slug, enabled: true, type: slug === 'nightly' ? 'cron' : 'webhook', webhook_url: slug === 'nightly' ? null : `${origin}/v1/hooks/${PROJECT_ID}/${slug}` })) });
      }
      if (path === `${BASE}/snapshots`) {
        return Response.json({ templates: [{ slug: 'dev', ready: api.ready }], builds: api.buildStarted ? [{ build_id: 'b-new', slug: 'dev', template_slug: 'dev', status: api.ready ? 'ready' : 'building', error: null }] : [] });
      }
      if (path === `${BASE}/sandbox-templates/reconcile`) return Response.json({ templates: [] });
      if (path === `${BASE}/sandbox-templates`) return Response.json({ items: [{ slug: 'dev', template_id: 'tpl-dev' }], default_slug: 'dev' });
      if (path === `${BASE}/sandbox-templates/tpl-dev/build`) {
        api.buildStarted = true;
        api.ready = true;
        return Response.json({ status: 'started' }, { status: 202 });
      }
      if (path === `${BASE}/channels/slack/installation`) return Response.json(api.slackInstalled ? { workspaceId: 'T0SYN', workspaceName: 'Synthetic Slack', botUserId: 'U0BOT', installedAt: '2026-11-10T00:00:00.000Z' } : null);
      if (path === `${BASE}/channels/slack/mode`) return Response.json({ oauth_available: true, install_url: `${origin}/slack/install?state=synthetic` });
      if (path === `${BASE}/channels/slack/join`) {
        const channels = (body?.channels as string[]) ?? [];
        return Response.json({ connected: true, team: 'Synthetic Slack', bot_user_id: 'U0BOT', results: channels.map((channel) => ({ channel, id: `C0${channel.toUpperCase()}`, status: channel === 'secret-room' ? 'needs_invite' : 'joined' })) });
      }
      if (path === `${EX}/connectors`) return Response.json({ connectors: [{ slug: 'tickets', provider: 'mcp', state: api.connectorState, authSecret: null, secretSet: false }] });
      if (path === `${EX}/connectors/tickets/connect`) return Response.json({ provider: 'mcp', connectUrl: `${origin}/connect/tickets`, connected: false });
      if (path === `${BASE}/model-picker`) return Response.json({ defaultModel: 'synthetic/model', models: { 'synthetic/model': { available: true } } });
      return Response.json({ error: `fake api: no route ${request.method} ${path}` }, { status: 404 });
    },
  });
  const apiBase = `http://127.0.0.1:${server.port}`;
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    active: 'test',
    hosts: { test: { url: apiBase, token: 'token-onboard-test', user_id: 'user-onboard', user_email: 'onboard@example.test', account_id: ACCOUNT_ID, logged_in_at: '2026-11-10T00:00:00.000Z' } },
  }));

  // A repository whose main branch is pushed to a (bare, local) origin and linked to the workspace.
  mkdirSync(join(repoDir, '.kortix', 'sandbox'), { recursive: true });
  writeFileSync(join(repoDir, 'kortix.yaml'), MANIFEST);
  writeFileSync(join(repoDir, '.kortix', 'sandbox', 'Dockerfile'), 'FROM debian:bookworm-slim\nRUN apt-get update && apt-get install -y curl\n');
  writeFileSync(join(repoDir, '.kortix', 'link.json'), JSON.stringify({ project_id: PROJECT_ID, account_id: ACCOUNT_ID, host: 'test', host_url: apiBase, linked_at: '2026-11-10T00:00:00.000Z' }));
  writeFileSync(join(repoDir, '.gitignore'), '.env.local\n');
  writeFileSync(join(repoDir, '.env.local'), `LOCAL_TOKEN=${LOCAL_VALUE}\nPROD_ONLY=sk_live_synthetic_value_1234\n`);
  git(['init', '-q', '-b', 'main'], repoDir);
  git(['add', '-A'], repoDir);
  git(['commit', '-q', '-m', 'init'], repoDir);
  git(['init', '-q', '--bare', join(root, 'origin.git')], root);
  git(['remote', 'add', 'origin', join(root, 'origin.git')], repoDir);
  git(['push', '-q', '-u', 'origin', 'main'], repoDir);
});

afterEach(() => {
  server?.stop(true);
  server = null;
  if (root) rmSync(root, { recursive: true, force: true });
});

const ONBOARD = ['onboard', '--yes', '--json', '--repo', REPO, '--env-file', '.env.local', '--only', 'LOCAL_TOKEN', '--channels', 'eng,#secret-room', '--build-timeout', '5'];

test('first run: does the mechanics, hands the person what is theirs, exits 4; a second run skips what is done', async () => {
  const first = await runCli(ONBOARD);
  expect(first.code).toBe(4);
  const out = JSON.parse(first.stdout) as {
    phases: Array<{ name: string; status: string; duration_ms: number }>;
    user_actions: Array<{ kind: string; url?: string; what: string }>;
    doctor: { ready: boolean; checks: Array<{ name: string; state: string }> };
    next: string;
  };
  const status = Object.fromEntries(out.phases.map((p) => [p.name, p.status]));
  expect(status).toEqual({
    validate: 'done',
    ship: 'skipped', // linked, clean, pushed, every trigger live
    secrets: 'waiting_on_person', // PERSON_KEY needs a person
    webhooks: 'done',
    slack: 'waiting_on_person', // not connected yet
    connectors: 'waiting_on_person',
    sandbox: 'skipped', // already built
    doctor: 'waiting_on_person',
  });
  for (const phase of out.phases) expect(typeof phase.duration_ms).toBe('number');
  expect(out.user_actions.map((a) => a.kind).sort()).toEqual(['connector_sign_in', 'secret_request', 'slack_install']);

  // The approved local value went up as-is; the webhook secret was generated and signs the hook.
  expect(api.secrets.get('LOCAL_TOKEN')).toBe(LOCAL_VALUE);
  expect(api.secrets.has('PROD_ONLY')).toBe(false);
  const hookSecret = api.secrets.get('GH_HOOK_SECRET')!;
  expect(hookSecret).toMatch(/^[0-9a-f]{64}$/);
  expect(posts(`${BASE}/secrets`).find((h) => h.body?.name === 'GH_HOOK_SECRET')?.body).toMatchObject({ strategy: 'broker', consumer: 'connector' });
  expect(posts(`${BASE}/secret-requests`)[0]?.body).toEqual({ names: ['PERSON_KEY'], scope: 'runtime' });
  const gh = ghState();
  expect(gh.hooks).toHaveLength(1);
  expect(gh.hooks[0]).toMatchObject({ url: expect.stringContaining('/issues-labeled'), events: ['issues', 'issue_comment'], secret: hookSecret });
  expect(gh.labels).toEqual(['kortix']);
  // No value on a command line, in stdout or in stderr.
  const calls = readFileSync(join(root, 'gh-calls.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { args: string[] });
  expect(calls.some((c) => c.args.join(' ').includes(hookSecret))).toBe(false);
  for (const text of [first.stdout, first.stderr]) {
    expect(text).not.toContain(LOCAL_VALUE);
    expect(text).not.toContain(hookSecret);
    expect(text).not.toContain('sk_live_synthetic');
  }

  // The person connects Slack and the connector, and pastes PERSON_KEY.
  api.slackInstalled = true;
  api.connectorState = 'connected';
  api.secrets.set('PERSON_KEY', 'pasted-by-a-person');
  hits = [];
  const second = await runCli(ONBOARD);
  const again = JSON.parse(second.stdout) as typeof out;
  expect(Object.fromEntries(again.phases.map((p) => [p.name, p.status]))).toMatchObject({
    ship: 'skipped', secrets: 'skipped', webhooks: 'skipped', connectors: 'skipped', sandbox: 'skipped', doctor: 'done',
  });
  // #secret-room is private: the one thing left is the /invite.
  expect(again.phases.find((p) => p.name === 'slack')?.status).toBe('waiting_on_person');
  expect(again.user_actions).toEqual([{ kind: 'slack_invite', what: expect.stringContaining('/invite @Kortix') }]);
  expect(second.code).toBe(4);
  expect(posts(`${BASE}/secrets`)).toHaveLength(0);
  expect(ghState().hooks).toHaveLength(1);
  expect(api.secrets.get('GH_HOOK_SECRET')).toBe(hookSecret);

  const third = await runCli(ONBOARD.map((arg) => (arg === 'eng,#secret-room' ? 'eng' : arg)));
  expect(third.code).toBe(0);
  expect(JSON.parse(third.stdout).doctor.ready).toBe(true);
}, 60_000);

test('a changed file outside kortix.yaml and .kortix/ fails ship and exits 1; nothing else runs', async () => {
  writeFileSync(join(repoDir, 'app.js'), 'console.log(1)\n');
  const r = await runCli(ONBOARD);
  expect(r.code).toBe(1);
  const out = JSON.parse(r.stdout) as { phases: Array<{ name: string; status: string; detail: string }>; next: string };
  expect(out.phases.find((p) => p.name === 'ship')).toMatchObject({ status: 'failed', detail: expect.stringContaining('app.js') });
  expect(posts(`${BASE}/secrets`)).toHaveLength(0);
  expect(out.next).toContain('ship');
}, 30_000);

test('a commit not yet pushed runs kortix ship as a child process; its failure is the phase failure', async () => {
  writeFileSync(join(repoDir, 'kortix.yaml'), `${MANIFEST}# edited\n`);
  git(['commit', '-q', '-am', 'edit'], repoDir);
  const r = await runCli(ONBOARD);
  expect(r.code).toBe(1);
  const ship = (JSON.parse(r.stdout) as { phases: Array<{ name: string; status: string; detail: string }> }).phases.find((p) => p.name === 'ship')!;
  expect(ship.status).toBe('failed');
  expect(ship.detail).toMatch(/^kortix ship exited [1-9]/);
  // The child really ran: it asked the fake API for the workspace.
  expect(hits.some((h) => h.path === BASE && h.method === 'GET')).toBe(true);
}, 30_000);

test('a prod-looking name is refused even when approved; the phase fails and the exit is 1', async () => {
  const r = await runCli(['onboard', '--yes', '--json', '--repo', REPO, '--env-file', '.env.local', '--only', 'PROD_ONLY']);
  expect(r.code).toBe(1);
  const secrets = (JSON.parse(r.stdout) as { phases: Array<{ name: string; status: string; detail: string }> }).phases.find((p) => p.name === 'secrets')!;
  expect(secrets.status).toBe('failed');
  expect(secrets.detail).toContain('PROD_ONLY');
  expect(api.secrets.has('PROD_ONLY')).toBe(false);
  expect(r.stdout + r.stderr).not.toContain('sk_live_synthetic');
}, 30_000);

test('without --yes it changes nothing and prints what it would do', async () => {
  const r = await runCli(['onboard', '--json', '--repo', REPO]);
  expect(r.code).toBe(0);
  const out = JSON.parse(r.stdout) as { dry_run: boolean; needs: { secrets: Array<{ name: string }>; github_webhooks: Array<{ slug: string; events: string[] }>; uses_slack: boolean } };
  expect(out.dry_run).toBe(true);
  expect(out.needs.secrets.map((s) => s.name)).toEqual(['GH_HOOK_SECRET', 'LOCAL_TOKEN', 'PERSON_KEY']);
  expect(out.needs.github_webhooks).toEqual([expect.objectContaining({ slug: 'issues-labeled', events: ['issues', 'issue_comment'], label: 'kortix' })]);
  expect(out.needs.uses_slack).toBe(true);
  expect(hits.filter((h) => h.method !== 'GET')).toHaveLength(0);
}, 30_000);

test('doctor --loops --fix: a missing webhook rotates its secret and creates the hook; an unbuilt image is built and waited for', async () => {
  api.secrets.set('GH_HOOK_SECRET', 'old-value-nobody-knows');
  api.secrets.set('LOCAL_TOKEN', 'x');
  api.secrets.set('PERSON_KEY', 'y');
  api.slackInstalled = true;
  api.connectorState = 'connected';
  api.ready = false;

  const before = await runCli(['doctor', '--loops', '--json', '--repo', REPO]);
  expect(before.code).toBe(1);
  const red = (JSON.parse(before.stdout) as { checks: Array<{ name: string; state: string }> }).checks.filter((c) => c.state === 'fail').map((c) => c.name);
  expect(red.sort()).toEqual(['label kortix', 'sandbox dev', 'webhook issues-labeled']);

  const fixed = await runCli(['doctor', '--loops', '--fix', '--json', '--repo', REPO, '--build-timeout', '5']);
  expect(fixed.code).toBe(0);
  const out = JSON.parse(fixed.stdout) as { ready: boolean; fixed: Array<{ name: string; status: string }> };
  expect(out.ready).toBe(true);
  expect(Object.fromEntries(out.fixed.map((f) => [f.name, f.status]))).toEqual({ secrets: 'skipped', webhooks: 'done', sandbox: 'done' });
  const rotated = api.secrets.get('GH_HOOK_SECRET')!;
  expect(rotated).not.toBe('old-value-nobody-knows');
  expect(ghState().hooks[0]?.secret).toBe(rotated);
  expect(posts(`${BASE}/sandbox-templates/tpl-dev/build`)).toHaveLength(1);
  expect(fixed.stdout + fixed.stderr).not.toContain(rotated);
}, 60_000);
