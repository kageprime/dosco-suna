import { describe, expect, test } from 'bun:test';
import type { GitBranchInfo } from '../git/types';
import { serializeSession, type ProjectSessionRow } from './serializers';
import { labelSessionBranches, sessionBranchTitle, type SessionBranchRow } from './session-branch-labels';

const SESSION_A = '3f6c2a1e-8b4d-4c7a-9e2f-1a2b3c4d5e6f';
const SESSION_B = '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';

function branch(name: string, isDefault = false): GitBranchInfo {
  return {
    name,
    is_default: isDefault,
    tip: 'a'.repeat(40),
    tip_short: 'aaaaaaa',
    subject: 'commit',
    committer_name: '',
    committer_email: '',
    committed_at: '2026-10-22T08:00:00.000Z',
    ahead: null,
    behind: null,
  };
}

function row(sessionId: string, patch: Partial<SessionBranchRow> = {}): SessionBranchRow {
  return {
    sessionId,
    agentName: 'store-builder',
    runtimeSessionId: null,
    customName: null,
    name: 'Draft cable tray product page',
    snapshot: null,
    deleted: false,
    ...patch,
  };
}

describe('the version title of a session branch', () => {
  test('a rename wins over the runtime title and the generated title', () => {
    const snapshot = [{ id: 'root', parent_id: null, title: 'Runtime title' }];
    expect(sessionBranchTitle(row(SESSION_A, { customName: 'Store page v2', snapshot, runtimeSessionId: 'root' }))).toBe(
      'Store page v2',
    );
  });

  test("the runtime's root title wins over the generated title", () => {
    const snapshot = [{ id: 'root', parent_id: null, title: 'Runtime title' }];
    expect(sessionBranchTitle(row(SESSION_A, { snapshot, runtimeSessionId: 'root' }))).toBe('Runtime title');
  });

  test('the generated title is the last choice, and a placeholder is no title', () => {
    expect(sessionBranchTitle(row(SESSION_A))).toBe('Draft cable tray product page');
    expect(sessionBranchTitle(row(SESSION_A, { name: 'New session - 2026-10-21T14:08:26.067Z' }))).toBeNull();
  });
});

describe('labelSessionBranches', () => {
  test("a session branch carries its session's title, agent, and the viewer's archive", () => {
    const [labelled] = labelSessionBranches([branch(SESSION_A)], [row(SESSION_A)], {
      openable: new Set([SESSION_A]),
      archived: new Set([SESSION_A]),
    });
    expect(labelled?.session).toEqual({
      title: 'Draft cable tray product page',
      agent_name: 'store-builder',
      archived: true,
      deleted: false,
    });
  });

  test('a session the caller may not open keeps its title hidden, as the session list hides it', () => {
    const [labelled] = labelSessionBranches([branch(SESSION_A)], [row(SESSION_A, { customName: 'Private plan' })], {
      openable: new Set(),
      archived: new Set(),
    });
    expect(labelled?.session?.title).toBeNull();
    expect(JSON.stringify(labelled)).not.toContain('Private plan');
  });

  test('a deleted session says so', () => {
    const [labelled] = labelSessionBranches([branch(SESSION_A)], [row(SESSION_A, { deleted: true })], {
      openable: new Set([SESSION_A]),
      archived: new Set(),
    });
    expect(labelled?.session?.deleted).toBe(true);
  });

  test('the default branch, a named branch, and a session branch with no row stay unlabelled', () => {
    const branches = [branch('main', true), branch('feature/pricing'), branch(SESSION_B)];
    const labelled = labelSessionBranches(branches, [row(SESSION_A)], {
      openable: new Set([SESSION_A, SESSION_B]),
      archived: new Set(),
    });
    expect(labelled).toEqual(branches);
    for (const b of labelled) expect('session' in b).toBe(false);
  });
});

describe('the branch label and the session read resolve the same name', () => {
  const sessionRow = (metadata: Record<string, unknown>, runtimeSessionId: string | null): ProjectSessionRow => ({
    sessionId: SESSION_A,
    accountId: '11111111-1111-4111-8111-111111111111',
    projectId: '22222222-2222-4222-8222-222222222222',
    branchName: `session/${SESSION_A}`,
    baseRef: 'main',
    sandboxProvider: 'platinum',
    sandboxId: null,
    sandboxUrl: null,
    runtimeSessionId,
    agentName: 'store-builder',
    status: 'stopped',
    error: null,
    labels: [],
    createdBy: null,
    visibility: 'private',
    origin: 'user',
    originRef: null,
    parentSessionId: null,
    initiatorType: null,
    initiatorId: null,
    spaceId: null,
    groupId: null,
    secretsAllowlist: null,
    requiredConnectors: null,
    connectorBindingsConfigured: false,
    connectorBindingsInheritUnbound: false,
    metadata,
    createdAt: new Date('2026-10-22T08:00:00.000Z'),
    updatedAt: new Date('2026-10-22T08:00:00.000Z'),
  });
  const both = (metadata: Record<string, unknown>, runtimeSessionId: string | null = null) => [
    serializeSession(sessionRow(metadata, runtimeSessionId)).name,
    sessionBranchTitle(row(SESSION_A, {
      runtimeSessionId,
      customName: metadata.custom_name,
      name: metadata.name,
      snapshot: metadata.runtime_sessions,
    })),
  ];
  const runtimeSessions = [{ id: 'root', parent_id: null, title: 'Runtime title' }];

  test('a renamed session', () => {
    expect(both({ custom_name: 'Store page v2', name: 'Generated title', runtime_sessions: runtimeSessions }, 'root'))
      .toEqual(['Store page v2', 'Store page v2']);
  });

  test('a runtime-titled session', () => {
    expect(both({ name: 'Generated title', runtime_sessions: runtimeSessions }, 'root'))
      .toEqual(['Runtime title', 'Runtime title']);
  });

  test('a placeholder-titled session has no name in either read', () => {
    expect(both({ name: 'New session - 2026-10-21T14:08:26.067Z' })).toEqual([null, null]);
  });
});
