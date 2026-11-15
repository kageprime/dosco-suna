import { describe, expect, test } from 'bun:test';
import type { ProjectManifestHealth } from '@kortix/sdk';

import { manifestIssuesForFile, manifestLspDiagnostics } from './manifest-health';

/** Synthetic: one warning on line 96 of the root manifest, the shape the audit saw. */
const HEALTH: ProjectManifestHealth = {
  path: 'kortix.yaml',
  state: 'issues',
  errors: 0,
  warnings: 1,
  issues: [
    {
      path: 'apps.sample.monthly_budget_usd',
      message: 'is retired and ignored: Apps have no budget. Remove it.',
      severity: 'warning',
      line: 96,
      column: 5,
    },
  ],
};

describe('manifestLspDiagnostics', () => {
  test('the manifest gets one diagnostic at line 96 (0-indexed 95), as a warning with the key', () => {
    const [diagnostic, ...rest] = manifestLspDiagnostics(HEALTH, 'kortix.yaml');
    expect(rest).toEqual([]);
    expect(diagnostic).toMatchObject({ line: 95, column: 4, severity: 2, source: 'kortix' });
    expect(diagnostic!.message).toBe('apps.sample.monthly_budget_usd is retired and ignored: Apps have no budget. Remove it.');
  });

  test('a leading slash or ./ on the open path still matches the manifest', () => {
    expect(manifestLspDiagnostics(HEALTH, '/kortix.yaml')).toHaveLength(1);
    expect(manifestLspDiagnostics(HEALTH, './kortix.yaml')).toHaveLength(1);
  });

  test('any other file gets none', () => {
    expect(manifestLspDiagnostics(HEALTH, 'README.md')).toEqual([]);
    expect(manifestLspDiagnostics(HEALTH, 'apps/kortix.yaml')).toEqual([]);
  });

  test('a healthy, missing or unread manifest gets none', () => {
    expect(manifestLspDiagnostics({ ...HEALTH, state: 'ok', warnings: 0, issues: [] }, 'kortix.yaml')).toEqual([]);
    expect(manifestLspDiagnostics(undefined, 'kortix.yaml')).toEqual([]);
  });

  test('a warning with a fix is hidden here exactly as the sidebar hides it (attentionHealth)', () => {
    const fixable: ProjectManifestHealth = {
      ...HEALTH,
      issues: [{ ...HEALTH.issues[0]!, fix: 'drop-app-budget' }],
    };
    expect(manifestLspDiagnostics(fixable, 'kortix.yaml')).toEqual([]);
  });

  test('an issue in an imports: file lands on that file, not the root manifest', () => {
    const imported: ProjectManifestHealth = {
      ...HEALTH,
      errors: 1,
      issues: [
        ...HEALTH.issues,
        { path: 'agents.helper.modle', message: 'Unknown key.', severity: 'error', line: 4, column: 3, file: 'agents/helper.yaml' },
      ],
    };
    expect(manifestIssuesForFile(imported, 'kortix.yaml')).toHaveLength(1);
    expect(manifestLspDiagnostics(imported, 'agents/helper.yaml')).toEqual([
      expect.objectContaining({ line: 3, column: 2, severity: 1 }),
    ]);
  });
  test('a Repository view path under /workspace matches the root manifest', () => {
    expect(manifestIssuesForFile(HEALTH, '/workspace/kortix.yaml')).toHaveLength(1);
    expect(manifestIssuesForFile(HEALTH, '/workspace/docs/kortix.yaml')).toHaveLength(0);
    expect(manifestIssuesForFile(HEALTH, '/workspaces/kortix.yaml')).toHaveLength(0);
  });
});
