import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runWithContext } from '../lib/request-context';
import { allowStaleMirrorReads, invalidateProjectMirror, refreshMirror } from '../projects/git/mirror';
import type { GitBackedProject } from '../projects/git/types';
import { resolveUserDockerfile, type ResolvedTemplate } from './templates';

const realTemplates = await import('./templates');
mock.module('./templates', () => ({
  ...realTemplates,
  listTemplatesForProject: async () => [template],
}));
// Only the database listing/placement and provider response are fixtures.
// Identity, Dockerfile reads, request scope, and Git mirror remain real.
const realDb = await import('../shared/db');
mock.module('../shared/db', () => ({
  ...realDb,
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ metadata: {} }] }) }) }) },
}));
const realProviders = await import('./providers');
mock.module('./providers', () => ({
  ...realProviders,
  getSandboxProvider: () => ({ isConfigured: () => true, getSnapshotState: async () => 'active' }),
}));
const { listSandboxTemplates } = await import('./template-prebuilds');

const exec = promisify(execFile);
let root = '';
let project: GitBackedProject;
const savedInterval = process.env.KORTIX_GIT_REFRESH_INTERVAL_MS;
const savedCache = process.env.KORTIX_GIT_CACHE_DIR;
const template: ResolvedTemplate = {
  templateId: 'template-test', projectId: 'project-test', slug: 'app', name: 'app',
  isShared: false, source: 'toml', provider: 'platinum', image: null,
  dockerfilePath: 'Dockerfile', entrypoint: null, cpu: 2, memoryGb: 4, diskGb: 20,
  containerRuntime: false, residentialProxy: null, providerState: 'active',
  providerSnapshotName: null, contentHash: null, builtFromCommit: null,
  swapKey: null, lastReady: {},
};
async function git(args: string[], cwd?: string) {
  return (await exec('git', args, { cwd })).stdout.trim();
}
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'template-view-'));
  const seed = join(root, 'seed');
  const remote = join(root, 'remote.git');
  await mkdir(seed);
  await git(['init', '--bare', '--initial-branch=main', remote]);
  await git(['init', '--initial-branch=main', seed]);
  await git(['config', 'user.name', 'Fixture'], seed);
  await git(['config', 'user.email', 'fixture@kortix.invalid'], seed);
  await writeFile(join(seed, 'Dockerfile'), 'FROM alpine:3.20\n');
  await git(['add', 'Dockerfile'], seed);
  await git(['commit', '-m', 'seed'], seed);
  await git(['remote', 'add', 'origin', remote], seed);
  await git(['push', 'origin', 'main'], seed);
  process.env.KORTIX_GIT_CACHE_DIR = join(root, 'cache');
  process.env.KORTIX_GIT_REFRESH_INTERVAL_MS = '0';
  project = { projectId: 'project-test', repoUrl: remote, defaultBranch: 'main', manifestPath: 'kortix.yaml', gitAuthToken: 'fixture' };
  await runWithContext('GET', '/warm', () => refreshMirror(project));
  // An unavailable upstream makes a foreground fetch observable without sleeps.
  await rename(remote, join(root, 'unavailable.git'));
});
afterAll(async () => {
  if (savedInterval === undefined) delete process.env.KORTIX_GIT_REFRESH_INTERVAL_MS;
  else process.env.KORTIX_GIT_REFRESH_INTERVAL_MS = savedInterval;
  if (savedCache === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
  else process.env.KORTIX_GIT_CACHE_DIR = savedCache;
  await rm(root, { recursive: true, force: true });
});
test('a view reads its Dockerfile from a warm mirror even when the upstream is unavailable', async () => {
  const result = await runWithContext('GET', '/sandbox-health', () => {
    allowStaleMirrorReads();
    return listSandboxTemplates(project);
  });
  expect(result).toHaveLength(1);
  expect(result[0]?.ready).toBe(true);
  expect(result[0]?.snapshotName).toStartWith('kortix-tpl-');
  const source = await runWithContext('GET', '/sandbox-health', () => {
    allowStaleMirrorReads();
    return resolveUserDockerfile(project, template, false);
  });
  expect(source.dockerfile).toBe('FROM alpine:3.20\n');
  expect(source.commit).toMatch(/^[a-f0-9]{40}$/);
});
test('a build still requires a current tip instead of trusting the view mirror', async () => {
  await expect(runWithContext('POST', '/snapshots/rebuild', () => resolveUserDockerfile(project, template))).rejects.toThrow();
});
test('an invalidated view cannot use the old Dockerfile', async () => {
  invalidateProjectMirror(project.projectId);
  await expect(runWithContext('GET', '/sandbox-health', () => {
    allowStaleMirrorReads();
    return resolveUserDockerfile(project, template, false);
  })).rejects.toThrow();
});
