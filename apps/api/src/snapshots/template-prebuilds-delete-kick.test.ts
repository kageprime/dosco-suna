/**
 * Characterization (KRTX-4928): `deleteSandboxImage`'s two branches (exact
 * snapshot identity vs template) and the two fire-and-forget kicks. Passes
 * before and after the shared delete tail and `fireAndForget` helper.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ResolvedTemplate } from './templates';

let state: 'active' | 'building' | 'missing' = 'active';
const calls: string[] = [];
let refreshError: Error | null = null;

mock.module('./providers', () => ({
  getSandboxProvider: (id?: string) => {
    calls.push(`provider:${id}`);
    return {
      getSnapshotState: async (name: string) => {
        calls.push(`state:${name}`);
        return state;
      },
      deleteSnapshot: async (name: string) => {
        calls.push(`delete:${name}`);
      },
    };
  },
}));

let ensureError: Error | null = null;
mock.module('./builder', () => ({
  ensureSandboxImage: async () => {
    if (ensureError) throw ensureError;
  },
}));

const actualTemplates = await import('./templates');
mock.module('./templates', () => ({
  ...actualTemplates,
  computeTemplateIdentity: async () => ({ snapshotName: 'snap-from-template' }),
  refreshTemplateState: async (id: string) => {
    calls.push(`refresh:${id}`);
    if (refreshError) throw refreshError;
  },
}));

const { deleteSandboxImage, kickPreBuild } = await import('./template-prebuilds');

const project = { projectId: 'proj_1', repoUrl: '', defaultBranch: 'main', manifestPath: 'kortix.yaml' };
const template = (templateId: string | null): ResolvedTemplate => ({
  templateId,
  projectId: 'proj_1',
  slug: 'web',
  name: 'web',
  isShared: false,
  source: 'toml',
  provider: 'platinum',
  image: null,
  dockerfilePath: null,
  entrypoint: null,
  cpu: 1,
  memoryGb: 1,
  diskGb: 1,
  containerRuntime: false,
  residentialProxy: null,
  providerState: 'active',
  providerSnapshotName: null,
  contentHash: null,
  builtFromCommit: null,
  swapKey: null,
  lastReady: {},
});

beforeEach(() => {
  state = 'active';
  calls.length = 0;
  refreshError = null;
  ensureError = null;
});

describe('deleteSandboxImage', () => {
  test('an exact identity is deleted on its own provider and never refreshes a template row', async () => {
    const out = await deleteSandboxImage(project, { snapshotName: 'snap-x', provider: 'daytona', slug: 'web' });
    expect(out).toEqual({ deleted: true, snapshotName: 'snap-x', slug: 'web' });
    expect(calls).toEqual(['provider:daytona', 'state:snap-x', 'delete:snap-x']);
  });

  test('an exact identity without a slug reports an empty slug', async () => {
    const out = await deleteSandboxImage(project, { snapshotName: 'snap-x', provider: 'daytona' });
    expect(out.slug).toBe('');
  });

  test('a resolved template is deleted by its computed identity, then its row is refreshed', async () => {
    const out = await deleteSandboxImage(project, { template: template('tpl-1') });
    expect(out).toEqual({ deleted: true, snapshotName: 'snap-from-template', slug: 'web' });
    expect(calls).toEqual(['provider:platinum', 'state:snap-from-template', 'delete:snap-from-template', 'refresh:tpl-1']);
  });

  test('an explicit provider wins over the template provider', async () => {
    await deleteSandboxImage(project, { template: template('tpl-1'), provider: 'daytona' });
    expect(calls[0]).toBe('provider:daytona');
  });

  test('a template without a row id skips the refresh', async () => {
    await deleteSandboxImage(project, { template: template(null) });
    expect(calls.some((c) => c.startsWith('refresh:'))).toBe(false);
  });

  test('a failing refresh is swallowed', async () => {
    refreshError = new Error('db down');
    const out = await deleteSandboxImage(project, { template: template('tpl-1') });
    expect(out.deleted).toBe(true);
  });

  test('building counts as deleted, anything else does not', async () => {
    state = 'building';
    expect((await deleteSandboxImage(project, { snapshotName: 'a', provider: 'p' })).deleted).toBe(true);
    state = 'missing';
    expect((await deleteSandboxImage(project, { snapshotName: 'a', provider: 'p' })).deleted).toBe(false);
    expect((await deleteSandboxImage(project, { template: template('t') })).deleted).toBe(false);
  });
});

describe('kickPreBuild', () => {
  test('a failed build warns with the message and does not reject', async () => {
    ensureError = new Error('build exploded');
    const warns: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warns.push(args);
    try {
      kickPreBuild(project, { slug: 'web', accountId: 'a', source: 'project-create' });
      await new Promise((resolve) => setTimeout(resolve, 5));
    } finally {
      console.warn = original;
    }
    expect(warns).toEqual([['[snapshots] pre-build failed for proj_1 (slug=web, project-create):', 'build exploded']]);
  });
});
