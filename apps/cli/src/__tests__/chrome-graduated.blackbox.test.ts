import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// `kortix chrome` outside a session box, black-box: a real CLI process against a
// stub API. `chrome` graduated on 2026-11-24: no project turns it off, so the
// catalog (`experimental_features`) no longer lists it. The project row's
// `experimental.chrome` says whether this server offers Kortix in Chrome
// (KORTIX_CHROME_ENABLED; off on a self-hosted server).

const PROJECT = 'aaaaaaaa-1111-4111-8111-111111111111';

let served = true;
let server: ReturnType<typeof Bun.serve>;
let dir = '';
const paths: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname.replace(/^\/v1/, '');
      paths.push(`${req.method} ${p}`);
      if (p === `/workspaces/${PROJECT}`) {
        return Response.json({ project_id: PROJECT, experimental: { chrome: served }, experimental_features: [{ key: 'calendar', enabled: false }] });
      }
      if (p === '/chrome/connections' && served) {
        return Response.json([{ id: 'c1', name: 'Work', brand: 'Chrome', os: 'macOS', online: true, accessMode: 'always', tabScope: 'own' }]);
      }
      return Response.json({ error: 'Not found' }, { status: 404 });
    },
  });
  dir = mkdtempSync(join(tmpdir(), 'kortix-chrome-'));
});

afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

async function kortix(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ active: 'test', hosts: { test: { url: `http://127.0.0.1:${server.port}`, token: 'synthetic', account_id: 'account-test' } } }));
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: dir,
    KORTIX_CONFIG_FILE: config,
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    KORTIX_NO_UPDATE_CHECK: '1',
  };
  for (const key of ['KORTIX_API_URL', 'KORTIX_TOKEN', 'KORTIX_PROJECT_ID', 'KORTIX_SESSION_ID', 'KORTIX_FEATURE_FLAGS', 'BASH_ENV']) delete env[key];
  const proc = Bun.spawn([process.execPath, resolve(import.meta.dir, '../index.ts'), 'chrome', ...args, '--workspace', PROJECT], { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, stdout, stderr };
}

test('a server that offers Kortix in Chrome: `kortix chrome ls` runs with no catalog row', async () => {
  served = true;
  paths.length = 0;
  const r = await kortix('ls');
  expect(r.stderr).not.toContain('kortix: ');
  expect(r.code).toBe(0);
  expect(r.stdout).toContain('Work (macOS)');
  expect(paths).toContain('GET /chrome/connections');
});

test('a server that does not offer it: hidden, and the line names the server, not a workspace toggle', async () => {
  served = false;
  paths.length = 0;
  const r = await kortix('ls');
  expect(r.code).not.toBe(0);
  expect(r.stderr).toContain('this Kortix server does not offer Kortix in Chrome');
  expect(r.stderr).not.toContain('features enable');
  expect(paths).not.toContain('GET /chrome/connections');
});
