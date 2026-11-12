/**
 * Characterization: the project-load preamble both manifest commits share,
 * pinned before its dedupe (KRTX-4617). An unknown project answers 404
 * 'project not found'; a project whose kortix.yaml cannot be read answers 400
 * with the reason (or the fallback text when the error has no message). The
 * database and the git-auth helper are stubbed; the commit itself must not be
 * reached on either refusal.
 */
import { describe, expect, mock, test } from 'bun:test';

const rows: unknown[] = [];
// The real module's other exports flow through: only `db` is replaced.
const realDb = await import('../shared/db');
mock.module('../shared/db', () => ({
  ...realDb,
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }) },
}));
const git = { error: null as Error | null };
mock.module('../projects/surface', () => ({
  withProjectGitAuth: async () => {
    if (git.error) throw git.error;
    return { row: 'project' };
  },
  withoutAppTriggers: (manifest: unknown) => ({ manifest, removed: [] }),
}));
mock.module('../connectors/manifest-mutation', () => ({
  mutateManifestWithRetry: async () => {
    throw new Error('must not be reached: the preamble refused first');
  },
}));

const { commitAppFields, commitAppRemoval } = await import('./app-manifest');

const PROJECT_ID = '00000000-0000-4000-8000-000000000010';

describe('manifest commits: the project load they share', () => {
  test('an unknown project is 404 for both commits', async () => {
    rows.length = 0;
    expect(await commitAppFields(PROJECT_ID, 'web', { cpu: 2 }))
      .toEqual({ ok: false, error: 'project not found', status: 404 });
    expect(await commitAppRemoval(PROJECT_ID, 'web', { mayRemoveTriggers: true }))
      .toEqual({ ok: false, error: 'project not found', status: 404 });
  });

  test('an unreadable kortix.yaml is 400 with the git reason, for both commits', async () => {
    rows.push({ projectId: PROJECT_ID });
    git.error = new Error('git auth failed');
    expect(await commitAppFields(PROJECT_ID, 'web', { cpu: 2 }))
      .toEqual({ ok: false, error: 'git auth failed', status: 400 });
    expect(await commitAppRemoval(PROJECT_ID, 'web', { mayRemoveTriggers: true }))
      .toEqual({ ok: false, error: 'git auth failed', status: 400 });
    git.error = new Error('');
    expect(await commitAppFields(PROJECT_ID, 'web', { cpu: 2 }))
      .toEqual({ ok: false, error: 'failed to read kortix.yaml', status: 400 });
  });
});
