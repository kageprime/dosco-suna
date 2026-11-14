/**
 * `kortix sandboxes build <slug> [--wait]` as a real CLI process against a
 * fake API on a real port. 2026-11-10: the onboarding run had no way to wait
 * for a template image; sessions booted the platform default meanwhile.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ENTRY = join(resolve(import.meta.dir, '..', '..'), 'src', 'index.ts');
const PROJECT_ID = '00000000-0000-4000-a000-000000000777';
const ACCOUNT_ID = '00000000-0000-4000-a000-000000000888';
const BASE = `/v1/workspaces/${PROJECT_ID}`;

type Build = { build_id: string; slug: string; template_slug: string; status: string; error: string | null; provider: string; started_at: string };

let root = '';
let server: ReturnType<typeof Bun.serve> | null = null;
let hits: string[] = [];
/** The template list before and after a reconcile. */
let listed: string[] = [];
let reconcileAdds: string[] = [];
/** `GET /snapshots` bodies in order; the last repeats. The first answers the pre-trigger read. */
let snapshots: Array<{ templates: Array<{ slug: string; ready: boolean }>; builds: Build[] }> = [];

const OLD_FAILURE: Build = {
  build_id: 'build-old', slug: 'dev', template_slug: 'dev', status: 'failed',
  error: 'an older Dockerfile failed', provider: 'platinum', started_at: '2026-11-01T00:00:00.000Z',
};
const build = (status: string, error: string | null = null): Build => ({
  build_id: 'build-new', slug: 'dev', template_slug: 'dev', status, error, provider: 'platinum', started_at: '2026-11-10T00:00:00.000Z',
});
const notReady = (builds: Build[]) => ({ templates: [{ slug: 'dev', ready: false }], builds });

async function runCli(args: string[]) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    KORTIX_CONFIG_FILE: join(root, 'config.json'),
    KORTIX_NO_UPDATE_CHECK: '1',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };
  for (const key of ['KORTIX_API_URL', 'KORTIX_TOKEN', 'KORTIX_CLI_TOKEN', 'KORTIX_PROJECT_ID']) delete env[key];
  const child = Bun.spawn({ cmd: [process.execPath, CLI_ENTRY, ...args], cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kortix-sandbox-build-wait-'));
  mkdirSync(join(root, '.kortix'), { recursive: true });
  hits = [];
  listed = ['default', 'dev'];
  reconcileAdds = [];
  snapshots = [];
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      hits.push(`${request.method} ${path}`);
      if (request.method === 'GET' && path === `${BASE}/sandbox-templates`) {
        return Response.json({
          items: listed.map((slug) => ({ slug, template_id: slug === 'default' ? null : `tpl-${slug}` })),
          default_slug: 'default',
        });
      }
      if (request.method === 'POST' && path === `${BASE}/sandbox-templates/reconcile`) {
        listed = [...listed, ...reconcileAdds];
        return Response.json({ templates: [], started: 0 });
      }
      if (request.method === 'POST' && path === `${BASE}/sandbox-templates/tpl-dev/build`) {
        return Response.json({ status: 'started', slug: 'dev' }, { status: 202 });
      }
      if (request.method === 'GET' && path === `${BASE}/snapshots`) {
        const body = snapshots.length > 1 ? snapshots.shift()! : snapshots[0]!;
        return Response.json(body);
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
  const apiBase = `http://127.0.0.1:${server.port}`;
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: apiBase, token: 'token-build-test', user_id: 'user-build-test', user_email: 'build@example.test',
          account_id: ACCOUNT_ID, logged_in_at: '2026-11-10T00:00:00.000Z',
        },
      },
    }),
  );
  writeFileSync(
    join(root, '.kortix', 'link.json'),
    JSON.stringify({ project_id: PROJECT_ID, account_id: ACCOUNT_ID, host: 'test', host_url: apiBase, linked_at: '2026-11-10T00:00:00.000Z' }),
  );
});

afterEach(() => {
  server?.stop(true);
  server = null;
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('kortix sandboxes build black box', () => {
  test('--wait follows the build until the template is ready and exits 0; an older failure is not this build', async () => {
    snapshots = [
      notReady([OLD_FAILURE]),
      notReady([build('building'), OLD_FAILURE]),
      { templates: [{ slug: 'dev', ready: true }], builds: [build('ready'), OLD_FAILURE] },
    ];
    const result = await runCli(['sandboxes', 'build', 'dev', '--wait', '--timeout', '30']);
    expect(result.stderr).not.toContain('failed');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Build started for dev; waiting up to 30s');
    expect(result.stdout).toContain('dev: building');
    expect(result.stdout).toContain('Sandbox template dev is ready');
    expect(hits.filter((hit) => hit === `POST ${BASE}/sandbox-templates/tpl-dev/build`)).toHaveLength(1);
  });

  test('--wait exits 1 with the build error and the repair command when this build fails', async () => {
    snapshots = [notReady([OLD_FAILURE]), notReady([build('failed', 'RUN npm ci\nexit code 1'), OLD_FAILURE])];
    const result = await runCli(['sandboxes', 'build', 'dev', '--wait']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Build of dev failed on platinum');
    expect(result.stderr).toContain('RUN npm ci');
    expect(result.stderr).not.toContain('an older Dockerfile failed');
    expect(result.stderr).toContain('kortix sandboxes fix');
  });

  test('--wait --json prints one result object', async () => {
    snapshots = [notReady([]), { templates: [{ slug: 'dev', ready: true }], builds: [build('ready')] }];
    const result = await runCli(['sandboxes', 'build', 'dev', '--wait', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ slug: 'dev', state: 'ready' });
  });

  test('--wait exits 1 when the timeout passes before the template is ready', async () => {
    snapshots = [notReady([]), notReady([build('building')])];
    const result = await runCli(['sandboxes', 'build', 'dev', '--wait', '--timeout', '0']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Sandbox template dev is not ready after 0s; the build continues on the server');
  });

  test('without --wait the build starts and the command returns without reading the build log', async () => {
    const result = await runCli(['sandboxes', 'build', 'dev']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Build started for dev');
    expect(hits.some((hit) => hit.endsWith('/snapshots'))).toBe(false);
  });

  test('a template just pushed and not listed yet is registered by a reconcile, then built', async () => {
    listed = ['default'];
    reconcileAdds = ['dev'];
    const result = await runCli(['sandboxes', 'build', 'dev']);
    expect(result.code).toBe(0);
    expect(hits).toEqual([
      `GET ${BASE}/sandbox-templates`,
      `POST ${BASE}/sandbox-templates/reconcile`,
      `GET ${BASE}/sandbox-templates`,
      `POST ${BASE}/sandbox-templates/tpl-dev/build`,
    ]);
  });

  test('--wait on another subcommand is refused', async () => {
    const result = await runCli(['sandboxes', 'ls', '--wait']);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('--wait only applies to `sandboxes build`');
  });
});
