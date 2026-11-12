import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// `kortix tools ls` in a session sandbox with no checkout: no ./kortix.yaml,
// so it reads kortix.yaml and its imports from the workspace repository
// through `GET /workspaces/:id/files/content`, the route `kortix files cat`
// uses. A checkout still wins; --workspace / --ref name the repository copy.

const CLI_ENTRY = join(resolve(import.meta.dir, '..', '..'), 'src', 'index.ts');
const PROJECT = 'proj_session';
const HEAD = 'default_agent: kortix\nagents:\n  kortix:\n    mode: primary\n    tools: all\n';

let tmp: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let requests: string[] = [];
/** Repository path → content, as the workspace repo holds it. */
let repo: Record<string, string> = {};

function startServer(): string {
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      requests.push(url.pathname.replace(/^\/v1/, '') + url.search);
      const base = `/workspaces/${PROJECT}`;
      const pathname = url.pathname.replace(/^\/v1/, '');
      const path = url.searchParams.get('path') ?? '';
      if (pathname === `${base}/files/content`) {
        if (!(path in repo)) return Response.json({ error: 'File not found' }, { status: 404 });
        return Response.json({ path, ref: url.searchParams.get('ref') ?? 'main', content: repo[path] });
      }
      if (pathname === `${base}/files`) {
        const prefix = path.replace(/\/$/, '');
        return Response.json(
          Object.keys(repo)
            .filter((file) => file.startsWith(`${prefix}/`))
            .map((file) => ({ path: file, type: 'file', size: repo[file]!.length })),
        );
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

async function runCli(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: tmp,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: tmp,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      KORTIX_NO_UPDATE_CHECK: '1',
      KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
      KORTIX_CONFIG_FILE: join(tmp, 'config.json'),
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => proc.kill(), 30_000);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timeout));
  return { code, stdout, stderr };
}

/** The environment a session sandbox injects. */
const session = () => ({ KORTIX_API_URL: startServer(), KORTIX_TOKEN: 'tok_session', KORTIX_PROJECT_ID: PROJECT });

type Listed = {
  manifest: string;
  source: string;
  workspace_id?: string;
  ref?: string | null;
  tools: Array<{ name: string; kind: string; source: string }>;
};

describe('kortix tools ls — no local checkout', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-tools-remote-'));
    requests = [];
    repo = {
      'kortix.yaml': `${HEAD}imports: [team/kortix.yaml]\ntools:\n  show: tools/show.ts\n`,
      'team/kortix.yaml': 'tools:\n  lookup_order: team/tools/lookup_order.ts\n',
    };
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('reads kortix.yaml and its imports from the workspace repository', async () => {
    const r = await runCli(['tools', 'ls', '--json'], session());
    expect(r.code).toBe(0);
    const listed = JSON.parse(r.stdout) as Listed;
    expect(listed).toMatchObject({ manifest: 'kortix.yaml', source: 'workspace', workspace_id: PROJECT, ref: null });
    expect(listed.tools.find((tool) => tool.name === 'show')).toEqual({ name: 'show', kind: 'kortix (overridden)', source: 'tools/show.ts' });
    expect(listed.tools.at(-1)).toEqual({ name: 'lookup_order', kind: 'project', source: 'team/tools/lookup_order.ts' });
    expect(requests).toContain(`/workspaces/${PROJECT}/files/content?path=kortix.yaml`);
  });

  test('the table names where it read the manifest from', async () => {
    const r = await runCli(['tools', 'ls'], session());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`From kortix.yaml in workspace ${PROJECT}: no local kortix.yaml.`);
    expect(r.stdout).toContain('lookup_order');
  });

  test('--ref reads that version', async () => {
    const r = await runCli(['tools', 'ls', '--json', '--ref', 'feature-x'], session());
    expect(r.code).toBe(0);
    expect((JSON.parse(r.stdout) as Listed).ref).toBe('feature-x');
    expect(requests).toContain(`/workspaces/${PROJECT}/files/content?path=kortix.yaml&ref=feature-x`);
  });

  test('a local kortix.yaml wins and the API is not called', async () => {
    writeFileSync(join(tmp, 'kortix.yaml'), `${HEAD}tools:\n  local_only: tools/local_only.ts\n`);
    const r = await runCli(['tools', 'ls', '--json'], session());
    expect(r.code).toBe(0);
    const listed = JSON.parse(r.stdout) as Listed;
    expect(listed).toMatchObject({ manifest: join(realpathSync(tmp), 'kortix.yaml'), source: 'local' });
    expect(listed.tools.at(-1)?.name).toBe('local_only');
    expect(requests).toEqual([]);
  });

  test('a workspace with no kortix.yaml is exit 2 and says so', async () => {
    repo = {};
    const r = await runCli(['tools', 'ls'], session());
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(`workspace ${PROJECT} has no kortix.yaml`);
  });

  test('no checkout and no workspace is exit 2 and names both ways out', async () => {
    const r = await runCli(['tools', 'ls'], {});
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Run from your workspace root');
    expect(r.stderr).toContain('--workspace <id>');
  });

  test('eject without a checkout refuses: it writes files', async () => {
    const r = await runCli(['tools', 'eject', 'web_search'], session());
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('eject writes tools/web_search.ts into a checkout');
    expect(requests).toEqual([]);
  });
});
