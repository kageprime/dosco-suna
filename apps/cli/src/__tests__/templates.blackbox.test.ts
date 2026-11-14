import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// `kortix templates add <id>` adds a template to an existing repository: its
// .kortix/<id>/ folder plus one line under imports: in kortix.yaml. The
// one-prompt setup guide runs it with --json and acts on `next`.

const CLI_ENTRY = join(resolve(import.meta.dir, '..', '..'), 'src', 'index.ts');
let repo: string;

function kortix(args: string[]) {
  const home = join(repo, '.home');
  const r = spawnSync('bun', [CLI_ENTRY, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home, KORTIX_NO_UPDATE_CHECK: '1', NO_COLOR: '1' },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function git(args: string[]) {
  spawnSync('git', args, { cwd: repo });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'kortix-templates-'));
  git(['init', '-q', '-b', 'main']);
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

test('ls --json lists the five hand-approved templates', () => {
  const r = kortix(['templates', 'ls', '--json']);
  expect(r.code).toBe(0);
  const ids = (JSON.parse(r.stdout) as { templates: Array<{ id: string }> }).templates.map((t) => t.id);
  expect(ids).toEqual(['software-factory', 'marketing', 'sales', 'recruiting', 'support']);
});

test('add into a repository with kortix.yaml: files written, import appended, comments kept, placeholders resolved', () => {
  git(['remote', 'add', 'origin', 'https://github.com/acme/shop.git']);
  writeFileSync(join(repo, 'kortix.yaml'), '# mine\nproject:\n  name: shop # keep\n');
  const r = kortix(['templates', 'add', 'software-factory', '--json']);
  expect(r.code).toBe(0);
  const out = JSON.parse(r.stdout);
  expect(out).toMatchObject({ template: 'software-factory', repository: 'acme/shop', default_branch: 'main', manifest_created: false, import: 'added' });
  expect(out.next.github_webhooks.map((h: { trigger: string }) => h.trigger)).toEqual(['source-github-issues', 'factory-feedback-github']);
  const manifest = readFileSync(join(repo, 'kortix.yaml'), 'utf8');
  expect(manifest).toContain('# mine');
  expect(manifest).toContain('# keep');
  expect(manifest).toMatch(/imports:\n\s+- \.kortix\/software-factory\//);
  const prompt = readFileSync(join(repo, '.kortix/software-factory/agents/factory.md'), 'utf8');
  expect(prompt).toContain('acme/shop');
  expect(prompt).not.toContain('{{');

  const again = kortix(['templates', 'add', 'software-factory', '--json']);
  expect(again.code).toBe(0);
  expect(JSON.parse(again.stdout)).toMatchObject({ import: 'present', written: [] });
});

test('a changed template file is refused without --force and replaced with it', () => {
  expect(kortix(['templates', 'add', 'marketing', '--repo', 'acme/shop']).code).toBe(0);
  const file = join(repo, '.kortix/marketing/marketing.yaml');
  writeFileSync(file, `${readFileSync(file, 'utf8')}# local edit\n`);
  const refused = kortix(['templates', 'add', 'marketing', '--repo', 'acme/shop']);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain('.kortix/marketing/marketing.yaml');
  expect(kortix(['templates', 'add', 'marketing', '--repo', 'acme/shop', '--force']).code).toBe(0);
  expect(readFileSync(file, 'utf8')).not.toContain('# local edit');
});

test('no kortix.yaml: one is created with My Kortix and the import; no GitHub remote and no --repo is refused', () => {
  const refused = kortix(['templates', 'add', 'marketing']);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain('--repo <owner/repo>');
  expect(existsSync(join(repo, 'kortix.yaml'))).toBe(false);

  const r = kortix(['templates', 'add', 'marketing', '--repo', 'acme/site', '--branch', 'trunk', '--json']);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toMatchObject({ manifest_created: true, default_branch: 'trunk' });
  const manifest = readFileSync(join(repo, 'kortix.yaml'), 'utf8');
  expect(manifest).toContain('my_kortix: true');
  expect(manifest).toContain('- .kortix/marketing/');
});

test('a business loop adds without a dev sandbox or GitHub webhooks, and names its generated webhook secret', () => {
  for (const id of ['sales', 'recruiting', 'support']) {
    const r = kortix(['templates', 'add', id, '--repo', 'acme/shop', '--branch', 'main', '--json']);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.next).toMatchObject({ github_webhooks: [], needs_dev_sandbox: false });
    const webhook = out.next.secrets.find((s: { name: string }) => s.name === `${id.toUpperCase()}_WEBHOOK_SECRET`);
    expect(webhook).toMatchObject({ required: true, delivery: 'connector', generate: true });
    expect(readFileSync(join(repo, `.kortix/${id}/agents/${id}.md`), 'utf8')).toContain('acme/shop');
    expect(existsSync(join(repo, `.kortix/${id}/${id}.json`))).toBe(true);
  }
  const manifest = readFileSync(join(repo, 'kortix.yaml'), 'utf8');
  for (const id of ['sales', 'recruiting', 'support']) expect(manifest).toContain(`- .kortix/${id}/`);
});

test('an unknown template is refused with the list', () => {
  const r = kortix(['templates', 'add', 'nope']);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain('software-factory, marketing, sales, recruiting, support');
});

test('sameGitHubRepository: https, ssh and scp forms of one repository match; another repository or a proxy URL does not', async () => {
  const { sameGitHubRepository } = await import('../git-ops.ts');
  expect(sameGitHubRepository('git@github.com:Acme/Shop.git', 'https://github.com/acme/shop.git')).toBe(true);
  expect(sameGitHubRepository('ssh://git@github.com/acme/shop', 'https://github.com/acme/shop')).toBe(true);
  expect(sameGitHubRepository('https://github.com/acme/other.git', 'https://github.com/acme/shop.git')).toBe(false);
  expect(sameGitHubRepository('https://api.kortix.com/v1/git/123', 'https://github.com/acme/shop.git')).toBe(false);
});

test('onboard prints the chosen template, then the setup guide; an unknown template is refused', () => {
  const r = kortix(['templates', 'onboard', 'software-factory']);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain('# Set up the Kortix Software Factory');
  expect(r.stdout).toContain('kortix templates add software-factory --json');
  expect(r.stdout).toContain('# Set up Kortix on this repository');
  expect(kortix(['templates', 'onboard', 'nope']).code).toBe(1);
});
