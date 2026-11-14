/**
 * `kortix plan --json` as a real CLI process on a synthetic monorepo: the
 * deterministic baseline an onboarding agent reads first. Env files are
 * classified key by key and no value, from any file, reaches the output.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const CLI_ENTRY = join(resolve(import.meta.dir, '..', '..'), 'src', 'index.ts');
const VALUES = [
  'postgres://localhost:5432/synthetic_db_value',
  'https://synthetic-remote.example.com/api',
  // Assembled at runtime: a live-mode-shaped literal trips the secret scanner.
  ['sk', 'live', 'synthetic', '0123456789'].join('_'),
  'synthetic-session-secret-77',
  'https://synthetic-prod.example.com',
  'encrypted:BAsyntheticcipher',
];
let root = '';

function write(path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function plan() {
  const r = spawnSync(process.execPath, [CLI_ENTRY, 'plan', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, KORTIX_CONFIG_FILE: join(root, '.no-config.json'), KORTIX_NO_UPDATE_CHECK: '1', KORTIX_DISABLE_SANDBOX_ENV_FILE: '1', NO_COLOR: '1', KORTIX_TOKEN: '', KORTIX_API_URL: '' },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kortix-plan-'));
  write('package.json', JSON.stringify({
    name: 'synthetic-mono',
    private: true,
    workspaces: ['apps/*', 'packages/*'],
    engines: { node: '>=22' },
    scripts: { dev: 'turbo dev', test: 'turbo test', e2e: 'playwright test', lint: 'eslint .', typecheck: 'tsc -b', 'secret:echo': 'echo hi' },
    devDependencies: { '@playwright/test': '1.50.0', turbo: '2.0.0' },
  }));
  write('yarn.lock', '# synthetic\n');
  write('.nvmrc', '22.11.0\n');
  write('turbo.json', '{}\n');
  write('apps/web/package.json', JSON.stringify({ name: 'web', dependencies: { '@sentry/nextjs': '8', 'posthog-js': '1', stripe: '17' }, scripts: { dev: 'next dev', build: 'next build' } }));
  write('packages/ui/package.json', JSON.stringify({ name: 'ui', dependencies: { '@supabase/supabase-js': '2' } }));
  write('docker-compose.yml', 'services:\n  db:\n    image: postgres:16\n  cache:\n    image: redis:7\n');
  write('.github/workflows/ci.yml', `on: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: yarn install --frozen-lockfile\n      - run: echo "${VALUES[1]}"\n        env:\n          DEPLOY: \${{ secrets.ZETA_DEPLOY_TOKEN }}\n`);
  // A service the code calls with fetch: no dependency, no env line. The name it reads is the evidence.
  write('src/mail.ts', 'export const key = process.env.RESEND_API_KEY;\n');
  write('README.md', 'Tickets live in https://linear.app/synthetic/team/ENG\n');
  write('playwright.config.ts', 'export default {};\n');
  write('.env', `DATABASE_URL=${VALUES[0]}\nAPI_URL="${VALUES[1]}"\nSTRIPE_SECRET_KEY=${VALUES[2]}\nexport SESSION_SECRET=${VALUES[3]}\nEMPTY=\nSEALED=${VALUES[5]}\nSLACK_WEBHOOK_URL=\n`);
  write('apps/web/.env.production', `NEXT_PUBLIC_SITE=${VALUES[4]}\n`);
  write('apps/web/.env.local', `NEXT_PUBLIC_SITE=http://localhost:3000\n`);
  write('.env.example', 'DATABASE_URL=\nNEW_ONLY=\nACME_API_KEY=\nACME_WEBHOOK_SECRET=\n');
  write('.mcp.json', JSON.stringify({ mcpServers: { tracker: { url: `https://mcp.example.com/${VALUES[2]}` } } }));
  write('Gemfile', "gem 'sentry-ruby'\ngem 'hubspot-api-client'\n");
  write('node_modules/ignored/.env', `IGNORED=${VALUES[3]}\n`);
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:synthetic-owner/synthetic-mono.git'], { cwd: root });
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

test('no env value, from any file, appears in the output', () => {
  const r = plan();
  expect(r.code).toBe(0);
  for (const value of VALUES) {
    expect(r.stdout).not.toContain(value);
    expect(r.stderr).not.toContain(value);
  }
  // A CI step that repeats a value is scrubbed, not dropped.
  const out = JSON.parse(r.stdout);
  expect(out.stack.ci[0].runs).toContain('echo "<env value>"');
});

test('env keys are classified local, remote or prod; example-only names are listed', () => {
  const out = JSON.parse(plan().stdout);
  const file = (name: string) => out.env.files.find((f: { file: string }) => f.file === name);
  const classes = Object.fromEntries(file('.env').keys.map((k: { name: string; class: string }) => [k.name, k.class]));
  expect(classes).toEqual({ DATABASE_URL: 'local', API_URL: 'remote', STRIPE_SECRET_KEY: 'prod', SESSION_SECRET: 'local', EMPTY: 'local', SEALED: 'local', SLACK_WEBHOOK_URL: 'local' });
  expect(file('.env').keys.find((k: { name: string }) => k.name === 'SEALED')).toMatchObject({ encrypted: true, empty: false });
  expect(file('.env').keys.find((k: { name: string }) => k.name === 'EMPTY')).toMatchObject({ empty: true });
  expect(file('apps/web/.env.production').keys[0]).toMatchObject({ name: 'NEXT_PUBLIC_SITE', class: 'prod' });
  expect(file('apps/web/.env.local').keys[0]).toMatchObject({ class: 'local' });
  expect(file('.env.example').example).toBe(true);
  expect(out.env.example_only.map((e: { name: string }) => e.name)).toEqual(['NEW_ONLY', 'ACME_API_KEY', 'ACME_WEBHOOK_SECRET']);
  expect(out.env.files.map((f: { file: string }) => f.file)).not.toContain('node_modules/ignored/.env');
  expect(out.env.schemes).toEqual(['postgres']);
  // Only local, non-empty, unencrypted names are proposed for upload.
  expect(out.recommendation.env_to_push.map((e: { name: string }) => e.name).sort()).toEqual(['DATABASE_URL', 'NEXT_PUBLIC_SITE', 'SESSION_SECRET']);
});

test('repository, monorepo layout, stack and integrations', () => {
  const out = JSON.parse(plan().stdout);
  expect(out.repository).toMatchObject({ git: true, github: { owner: 'synthetic-owner', repo: 'synthetic-mono' }, origin: 'github', clean: false });
  expect(out.repository.layout).toEqual({ workspaces: ['yarn', 'turbo'], apps: ['apps/web'], packages: ['packages/ui'] });
  expect(out.stack.languages[0]).toEqual({ name: 'node', version: '22.11.0', evidence: '.nvmrc' });
  expect(out.stack.package_managers.map((m: { name: string }) => m.name)).toEqual(['yarn']);
  expect(out.stack.services.map((s: { name: string }) => s.name)).toEqual(['db', 'cache']);
  expect(out.stack.browser_tests).toEqual([{ tool: 'playwright', evidence: 'playwright.config.ts' }]);
  expect(out.stack.commands).toContainEqual({ name: 'e2e', command: 'playwright test', package: '.' });
  expect(out.stack.commands).toContainEqual({ name: 'build', command: 'next build', package: 'apps/web' });
  expect(out.integrations.map((i: { name: string }) => i.name)).toEqual(['GitHub', 'Sentry', 'PostHog', 'Linear', 'Slack', 'Resend', 'HubSpot', 'Stripe', 'Supabase']);
  expect(out.integrations.find((i: { name: string }) => i.name === 'Resend').evidence).toEqual(['src/mail.ts: RESEND_API_KEY']);
  expect(out.stack.ci[0].secrets).toEqual(['ZETA_DEPLOY_TOKEN']);
  expect(out.integrations.find((i: { name: string }) => i.name === 'HubSpot')).toEqual({ name: 'HubSpot', category: 'crm', evidence: ['Gemfile: hubspot-api-client'] });
  // A credential no rule names is reported by prefix, so the person is asked what it is.
  expect(out.unrecognized_services).toEqual([
    { prefix: 'ACME', evidence: ['.env.example: ACME_API_KEY', '.env.example: ACME_WEBHOOK_SECRET'] },
    { prefix: 'ZETA_DEPLOY', evidence: ['.github/workflows/ci.yml: ZETA_DEPLOY_TOKEN'] },
  ]);
  // MCP servers by name only: the URL holds a token.
  expect(out.mcp_servers).toEqual([{ name: 'tracker', file: '.mcp.json' }]);
  expect(out.integrations.find((i: { name: string }) => i.name === 'Linear').evidence).toEqual(['README.md']);
  expect(out.recommendation.dev_environment).toMatchObject({ container_runtime: true, commands: { install: 'yarn install --frozen-lockfile', e2e: 'yarn e2e' } });
  expect(out.recommendation.references.map((r: { name: string }) => r.name)).toEqual(['software-factory', 'marketing-factory']);
});

test('signed out: the Kortix state says so and plan still exits 0', () => {
  const r = plan();
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout).kortix).toMatchObject({ signed_in: false, workspace: null, manifest: null });
});
