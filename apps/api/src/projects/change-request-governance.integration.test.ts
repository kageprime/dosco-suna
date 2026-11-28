import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { classifyMerge, setSecretScanBudgetMsForTests } from './change-request-governance';
import { refreshMirror } from './git/mirror';
import type { GitBackedProject } from './git/types';

const manifestChangeRequiredActions = async (
  project: GitBackedProject,
  cr: { baseRef: string; headRef: string },
) => (await classifyMerge(project, cr)).required;

// Synthetic, assembled at runtime: no literal a secret scanner flags.
const FAKE_GITHUB_TOKEN = ['ghp', Array.from({ length: 36 }, (_, i) => 'aB3dE5gH7jK9mN2pQ4sT6vW8yZ'[(i * 7) % 26]).join('')].join('_');

// Release gate GH-17 / AGP-10 (v0.13.31): an agent session pushed its branch,
// opened a change request, and merged it seconds later. The merge landed on an
// API replica whose mirror had refreshed less than the refresh interval ago,
// so the just-pushed head branch did not resolve, and a README-only change was
// refused. This suite reproduces that replica: a warm mirror with a long
// refresh interval.

const exec = promisify(execFile);

let testRoot = '';
let remotePath = '';
let workPath = '';
let project: GitBackedProject;
let previousCacheDir: string | undefined;
let previousRefreshInterval: string | undefined;

async function git(args: string[], cwd?: string): Promise<void> {
  await exec('git', args, { cwd });
}

const MANIFEST = [
  'default_agent: builder',
  'agents:',
  '  builder:',
  '    kortix_permissions: [project.gitops.push, project.gitops.merge]',
  '',
].join('\n');

async function pushBranch(branch: string, files: Record<string, string>): Promise<void> {
  await git(['checkout', '-q', '-B', branch, 'main'], workPath);
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(workPath, path), content);
  }
  await git(['add', '-A'], workPath);
  await git(['commit', '-q', '-m', `change on ${branch}`], workPath);
  await git(['push', '-q', 'origin', `${branch}:refs/heads/${branch}`], workPath);
  await git(['checkout', '-q', 'main'], workPath);
}

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), 'kortix-cr-governance-'));
  remotePath = join(testRoot, 'remote.git');
  workPath = join(testRoot, 'work');
  previousCacheDir = process.env.KORTIX_GIT_CACHE_DIR;
  previousRefreshInterval = process.env.KORTIX_GIT_REFRESH_INTERVAL_MS;
  process.env.KORTIX_GIT_CACHE_DIR = join(testRoot, 'git-cache');
  // One hour: every unforced read inside the test serves the warm mirror.
  process.env.KORTIX_GIT_REFRESH_INTERVAL_MS = '3600000';

  await mkdir(workPath);
  await git(['init', '-q', '--bare', remotePath]);
  await git(['init', '-q', '--initial-branch=main', workPath]);
  await git(['config', 'user.name', 'Dosco Test'], workPath);
  await git(['config', 'user.email', 'test@kortix.invalid'], workPath);
  await writeFile(join(workPath, 'kortix.yaml'), MANIFEST);
  await writeFile(join(workPath, 'README.md'), '# seed\n');
  await git(['add', '-A'], workPath);
  await git(['commit', '-q', '-m', 'seed'], workPath);
  await git(['remote', 'add', 'origin', remotePath], workPath);
  await git(['push', '-q', 'origin', 'main'], workPath);
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remotePath);

  project = {
    projectId: `cr-governance-${crypto.randomUUID()}`,
    repoUrl: remotePath,
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    gitAuthToken: 'local-test',
  };
  // Warm the mirror BEFORE the session branch exists, as the replica that
  // served an earlier request of the same flow had.
  await refreshMirror(project);
});

afterEach(async () => {
  if (previousCacheDir === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
  else process.env.KORTIX_GIT_CACHE_DIR = previousCacheDir;
  if (previousRefreshInterval === undefined) delete process.env.KORTIX_GIT_REFRESH_INTERVAL_MS;
  else process.env.KORTIX_GIT_REFRESH_INTERVAL_MS = previousRefreshInterval;
  await rm(testRoot, { recursive: true, force: true });
});

describe('classifyMerge(...).required on a warm mirror', () => {
  test('a branch pushed after the mirror warmed, changing only README, needs nothing extra', async () => {
    await pushBranch('session-readme', { 'README.md': '# seed\n\nagent note\n' });
    expect(await manifestChangeRequiredActions(project, { baseRef: 'main', headRef: 'session-readme' })).toEqual([]);
  });

  test('a branch pushed after the mirror warmed, adding a trigger, needs project.trigger.create', async () => {
    await pushBranch('session-trigger', {
      'kortix.yaml': `${MANIFEST}triggers:\n  - slug: hourly\n    type: cron\n    cron: "0 0 * * * *"\n    prompt: run\n`,
    });
    expect(await manifestChangeRequiredActions(project, { baseRef: 'main', headRef: 'session-trigger' })).toEqual([
      'project.trigger.create',
    ]);
  });

  test('a branch widening its own agent needs project.agent.write', async () => {
    await pushBranch('session-widen', { 'kortix.yaml': MANIFEST.replace('[project.gitops.push, project.gitops.merge]', 'all') });
    expect(await manifestChangeRequiredActions(project, { baseRef: 'main', headRef: 'session-widen' })).toEqual([
      'project.agent.write',
    ]);
  });

  test('a head ref that does not exist on the remote throws (the route answers 503), never a guess', async () => {
    await expect(
      manifestChangeRequiredActions(project, { baseRef: 'main', headRef: 'session-never-pushed' }),
    ).rejects.toThrow();
  });
});

describe('classifyMerge — connectors and what the commits add', () => {
  const WITH_CONNECTOR = `${MANIFEST}connectors:\n  - slug: desk\n    provider: mcp\n    url: https://desk.example.test/mcp\n`;

  test('a branch deleting a connector needs project.connector.write', async () => {
    await pushBranch('session-seed-connector', { 'kortix.yaml': WITH_CONNECTOR });
    await git(['checkout', '-q', 'main'], workPath);
    await git(['merge', '-q', '--ff-only', 'session-seed-connector'], workPath);
    await git(['push', '-q', 'origin', 'main'], workPath);
    await pushBranch('session-drop-connector', { 'kortix.yaml': MANIFEST });
    expect(await manifestChangeRequiredActions(project, { baseRef: 'main', headRef: 'session-drop-connector' })).toEqual([
      'project.connector.write',
    ]);
  });

  test('a kortix.yaml added beside the base kortix.yml that drops a connector the base added since needs project.connector.write', async () => {
    // main moves to kortix.yml; the branch starts there.
    await git(['mv', 'kortix.yaml', 'kortix.yml'], workPath);
    await git(['commit', '-q', '-m', 'use kortix.yml'], workPath);
    await git(['push', '-q', 'origin', 'main'], workPath);
    // The branch adds kortix.yaml, a copy of the manifest at the branch point.
    await pushBranch('session-shadow', { 'kortix.yaml': MANIFEST });
    // main then adds a connector to kortix.yml.
    await writeFile(join(workPath, 'kortix.yml'), WITH_CONNECTOR);
    await git(['commit', '-q', '-am', 'connectors: add desk'], workPath);
    await git(['push', '-q', 'origin', 'main'], workPath);
    // The branch's own diff touches no section; what the merge lands drops desk.
    const change = await classifyMerge(project, { baseRef: 'main', headRef: 'session-shadow' });
    expect(change.required).toContain('project.connector.write');
    expect(change.manifestRef).not.toBe(change.headSha);
  });

  test('a token the branch adds is a finding with file, line, commit and rule, never the value', async () => {
    await pushBranch('session-token', { 'config.ts': `// config\nexport const TOKEN = '${FAKE_GITHUB_TOKEN}';\n` });
    const change = await classifyMerge(project, { baseRef: 'main', headRef: 'session-token' });
    const head = (await exec('git', ['rev-parse', 'session-token'], { cwd: workPath })).stdout.trim();
    expect(change.headSha).toBe(head);
    expect(change.secrets).toEqual({
      findings: [{ commit: head.slice(0, 12), file: 'config.ts', line: 2, rule: 'github_token', label: 'GitHub token' }],
      total: 1,
    });
    expect(JSON.stringify(change)).not.toContain(FAKE_GITHUB_TOKEN);
  });

  test('a token added in one commit and deleted in the next is still found: the merge carries both commits', async () => {
    await pushBranch('session-token-history', { 'config.ts': `export const TOKEN = '${FAKE_GITHUB_TOKEN}';\n` });
    await git(['checkout', '-q', 'session-token-history'], workPath);
    await writeFile(join(workPath, 'config.ts'), 'export const TOKEN = process.env.TOKEN;\n');
    await git(['commit', '-q', '-am', 'read the token from the environment'], workPath);
    await git(['push', '-q', 'origin', 'session-token-history:refs/heads/session-token-history'], workPath);
    await git(['checkout', '-q', 'main'], workPath);
    const change = await classifyMerge(project, { baseRef: 'main', headRef: 'session-token-history' });
    expect(change.secrets.findings.map((f) => `${f.file}:${f.line}:${f.rule}`)).toEqual(['config.ts:1:github_token']);
  });

  test('a token a merge commit adds in its resolution is found (remerge), not taken from either parent', async () => {
    await pushBranch('session-evil-merge', { 'notes.md': 'side\n' });
    await git(['checkout', '-q', 'main'], workPath);
    await writeFile(join(workPath, 'notes.md'), 'main\n');
    await git(['add', '-A'], workPath);
    await git(['commit', '-q', '-m', 'main notes'], workPath);
    await git(['push', '-q', 'origin', 'main'], workPath);
    await git(['checkout', '-q', 'session-evil-merge'], workPath);
    await exec('git', ['merge', '-q', 'main'], { cwd: workPath }).catch(() => undefined); // conflicts on notes.md
    await writeFile(join(workPath, 'notes.md'), `resolved\nTOKEN=${FAKE_GITHUB_TOKEN}\n`);
    await git(['add', 'notes.md'], workPath);
    await git(['commit', '-q', '--no-edit'], workPath);
    const mergeCommit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: workPath })).stdout.trim();
    await writeFile(join(workPath, 'notes.md'), 'resolved\n');
    await git(['commit', '-q', '-am', 'drop the token'], workPath);
    await git(['push', '-q', 'origin', 'session-evil-merge:refs/heads/session-evil-merge'], workPath);
    await git(['checkout', '-q', 'main'], workPath);
    const change = await classifyMerge(project, { baseRef: 'main', headRef: 'session-evil-merge' });
    expect(change.secrets.findings.map((f) => `${f.commit}:${f.file}:${f.line}:${f.rule}`)).toEqual([
      `${mergeCommit.slice(0, 12)}:notes.md:2:github_token`,
    ]);
  });

  test('a token in a file the branch marks binary (-diff) is read as text and found', async () => {
    await pushBranch('session-binary', {
      '.gitattributes': 'blob.dat -diff\n',
      'blob.dat': `\u0000bin\u0000${FAKE_GITHUB_TOKEN}\n`,
    });
    const change = await classifyMerge(project, { baseRef: 'main', headRef: 'session-binary' });
    expect(change.secrets.findings.map((f) => `${f.file}:${f.rule}`)).toEqual(['blob.dat:github_token']);
  });

  test('a change the scan cannot read in full (an octopus merge) is unscanned, never clean', async () => {
    await pushBranch('session-oct-a', { 'a.txt': 'a\n' });
    await pushBranch('session-oct-b', { 'b.txt': 'b\n' });
    await git(['checkout', '-q', '-B', 'session-octopus', 'main'], workPath);
    await git(['merge', '-q', '--no-ff', '--no-edit', 'session-oct-a', 'session-oct-b'], workPath);
    await git(['push', '-q', 'origin', 'session-octopus:refs/heads/session-octopus'], workPath);
    await git(['checkout', '-q', 'main'], workPath);
    const change = await classifyMerge(project, { baseRef: 'main', headRef: 'session-octopus' });
    expect(change.secrets).toEqual({ findings: [], total: 0, unscanned: 'an octopus merge' });
  });

  test('a key the base deleted, kept by a conflict resolution on the branch, is found: the merge would put it back', async () => {
    // main holds the key; the branch starts there and edits the same file.
    await pushBranch('session-seed-key', { 'legacy.ts': `export const OLD = '${FAKE_GITHUB_TOKEN}';\n` });
    await git(['checkout', '-q', 'main'], workPath);
    await git(['merge', '-q', '--ff-only', 'session-seed-key'], workPath);
    await git(['push', '-q', 'origin', 'main'], workPath);
    await pushBranch('session-keeps-key', { 'legacy.ts': `export const OLD = '${FAKE_GITHUB_TOKEN}';\nexport const MORE = 1;\n` });
    // main deletes the key.
    await writeFile(join(workPath, 'legacy.ts'), 'export const OLD = process.env.OLD;\n');
    await git(['commit', '-q', '-am', 'drop the key'], workPath);
    await git(['push', '-q', 'origin', 'main'], workPath);
    // The branch merges main and resolves by keeping its own file.
    await git(['checkout', '-q', 'session-keeps-key'], workPath);
    await exec('git', ['merge', '-q', 'main'], { cwd: workPath }).catch(() => undefined);
    await exec('git', ['checkout', '--ours', 'legacy.ts'], { cwd: workPath });
    await git(['add', 'legacy.ts'], workPath);
    await git(['commit', '-q', '--no-edit'], workPath);
    await git(['push', '-q', 'origin', 'session-keeps-key:refs/heads/session-keeps-key'], workPath);
    await git(['checkout', '-q', 'main'], workPath);
    const change = await classifyMerge(project, { baseRef: 'main', headRef: 'session-keeps-key' });
    expect(change.secrets.findings.map((f) => `${f.file}:${f.rule}`)).toContain('legacy.ts:github_token');
  });

  test('a scan that runs past its wall-time budget is unscanned, never a timeout', async () => {
    await pushBranch('session-slow', { 'config.ts': 'export const x = 1;\n' });
    const restore = setSecretScanBudgetMsForTests(1);
    try {
      const change = await classifyMerge(project, { baseRef: 'main', headRef: 'session-slow' });
      expect(change.secrets.total).toBe(0);
      expect(change.secrets.unscanned).toMatch(/took longer than/);
    } finally {
      restore();
    }
  });

  test('a token already on the base branch is not the change request\'s finding', async () => {
    await pushBranch('session-base-token', { 'legacy.ts': `export const OLD = '${FAKE_GITHUB_TOKEN}';\n` });
    await git(['checkout', '-q', 'main'], workPath);
    await git(['merge', '-q', '--ff-only', 'session-base-token'], workPath);
    await git(['push', '-q', 'origin', 'main'], workPath);
    await pushBranch('session-after-token', { 'README.md': '# seed\n\nanother note\n' });
    const change = await classifyMerge(project, { baseRef: 'main', headRef: 'session-after-token' });
    expect(change.secrets).toEqual({ findings: [], total: 0 });
  });
});
