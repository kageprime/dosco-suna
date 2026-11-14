/**
 * KRTX-4867: `GET /sandbox-health` is a page-view poll like `/snapshots` and
 * `/sandboxes/templates`, but it never opted into stale mirror reads. Its
 * template listing then synced the manifest through a blocking `git fetch`
 * on every cold memo (prod p95 5.6 s against a 22 ms median).
 *
 * Driven through the real handler, request context and git mirror: the
 * mirror is warm and the remote has moved, so a request that opted in is
 * answered from the mirror as it was, while one that did not fetches first.
 */
import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runWithContext } from '../../lib/request-context';
import { refreshMirror } from '../git/mirror';
import type { GitBackedProject } from '../git/types';

const exec = promisify(execFile);
const PROJECT_ID = '44444444-4444-4444-8444-444444444444';

let testRoot = '';
let repositoryPath = '';
let project: GitBackedProject;
let mirrorPath = '';
/** The mirror tip as the handler's git read saw it. */
let tipSeenByRead = '';
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['KORTIX_GIT_CACHE_DIR', 'KORTIX_GIT_REFRESH_INTERVAL_MS', 'KORTIX_GIT_VIEW_MAX_STALE_MS'];

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout.trim();
}

async function pushCommit(content: string): Promise<string> {
  await writeFile(join(repositoryPath, 'kortix.yaml'), content);
  await git(['add', 'kortix.yaml'], repositoryPath);
  await git(['commit', '-m', content], repositoryPath);
  await git(['push', 'origin', 'main'], repositoryPath);
  return git(['rev-parse', 'HEAD'], repositoryPath);
}

const realAccess = await import('../lib/access');
mock.module('../lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async () => ({ userId: 'u1', row: { accountId: 'a1', metadata: {} } }),
}));
const realGit = await import('../lib/git');
mock.module('../lib/git', () => ({
  ...realGit,
  // The template listing's first step: read the mirror, then stop here.
  loadGitProject: async () => {
    await refreshMirror(project);
    tipSeenByRead = await git(['rev-parse', 'refs/heads/main'], mirrorPath);
    throw new Error('stop: no templates needed');
  },
}));
const realBuilder = await import('../../snapshots/builder');
mock.module('../../snapshots/builder', () => ({
  ...realBuilder,
  listSnapshotBuilds: async () => [],
}));
const { projectsApp } = await import('../lib/app');
(await import('./sandboxes')).registerSandboxesRoutes();

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  testRoot = await mkdtemp(join(tmpdir(), 'kortix-sandbox-health-stale-'));
  const remotePath = join(testRoot, 'remote.git');
  repositoryPath = join(testRoot, 'repository');
  process.env.KORTIX_GIT_CACHE_DIR = join(testRoot, 'git-cache');
  // Every read is past the refresh interval, so only the opt-in can skip a fetch.
  process.env.KORTIX_GIT_REFRESH_INTERVAL_MS = '0';
  delete process.env.KORTIX_GIT_VIEW_MAX_STALE_MS;
  await mkdir(repositoryPath);
  await git(['init', '--bare', remotePath]);
  await git(['init', '--initial-branch=main', repositoryPath]);
  await git(['config', 'user.name', 'Kortix Test'], repositoryPath);
  await git(['config', 'user.email', 'test@kortix.invalid'], repositoryPath);
  await git(['remote', 'add', 'origin', remotePath], repositoryPath);
  await pushCommit('seed');
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remotePath);
  project = {
    projectId: `sandbox-health-stale-${crypto.randomUUID()}`,
    repoUrl: remotePath,
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    gitAuthToken: 'local-test',
  };
});

afterAll(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await rm(testRoot, { recursive: true, force: true });
});

test('sandbox-health answers from the warm mirror instead of blocking on a git fetch', async () => {
  mirrorPath = await runWithContext('GET', '/warm', () => refreshMirror(project)); // cold clone
  const seeded = await git(['rev-parse', 'refs/heads/main'], mirrorPath);
  const pushed = await pushCommit('pushed outside Kortix');
  expect(pushed).not.toBe(seeded);

  const response = await runWithContext('GET', `/v1/workspaces/${PROJECT_ID}/sandbox-health`, () =>
    projectsApp.request(`/${PROJECT_ID}/sandbox-health`),
  );

  expect(response.status).toBe(200);
  // The handler's git read got the mirror as it was: no fetch blocked it.
  expect(tipSeenByRead).toBe(seeded);
});
