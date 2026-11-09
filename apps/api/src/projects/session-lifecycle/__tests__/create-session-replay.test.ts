// Characterization tests for `createSession`'s idempotent replay arm
// (`claimed.existing`): the cross-tenant guard, the six payload conflict codes
// and the deleted-session tombstone. They pin the behavior the replay arm
// carries when it moves into `resolveExistingCreateCommand` (KRTX-4471) —
// these must pass, unchanged, before and after the move.
//
// Same mocking caveat as the sibling session-lifecycle test files:
// `mock.module` is process-global in bun:test, so this file runs on its own
// under `--isolate`.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectSessions } from '@kortix/db';
import type { CreateSessionCommand } from '../types';
import type { ProjectRow } from '../../lib/serializers';
import type { SessionLifecycleCommandRow } from '../store';

const ACCOUNT_ID = 'acct-1';
const PROJECT_ID = 'proj-1';
const KEY = 'key-1';
const COMMAND_ID = 'cmd-existing-1';
const SESSION_ID = 'sess-1';
const OTHER_ACCOUNT_ID = 'acct-other';

let projectSession: { sessionId: string; metadata: unknown } | null = null;

const cfg: { KORTIX_URL: string; KORTIX_INSTANCE_ID?: string } = { KORTIX_URL: 'https://api.test' };

const realConfig = await import('../../../config');
mock.module('../../../config', () => ({
  ...realConfig,
  config: cfg,
}));

mock.module('../../../shared/db', () => ({
  hasDatabase: () => true,
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => (table === projectSessions && projectSession ? [projectSession] : []),
        }),
      }),
    }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
    insert: () => ({ values: () => ({ returning: async () => [] }) }),
  },
  withDbTransaction: <T,>(action: () => Promise<T>): Promise<T> => action(),
}));

// Every replay runs through one `claimCreateSessionCommand` call: it hands
// back the row the key already owns. The other `mark*` writers must never run
// from these cases — the arm only reads the existing row and the session.
const realStore = await import('../store');
let claimedRow: SessionLifecycleCommandRow;
mock.module('../store', () => ({
  ...realStore,
  claimCreateSessionCommand: async () => ({ row: claimedRow, existing: true }),
}));

const { createSession } = await import('../create-session');

function existingRowFor(overrides: Partial<SessionLifecycleCommandRow> = {}): SessionLifecycleCommandRow {
  const now = new Date();
  return {
    commandId: COMMAND_ID,
    commandType: 'create_session',
    source: 'ui',
    artifactId: null,
    status: 'succeeded',
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    sessionId: SESSION_ID,
    actorUserId: null,
    idempotencyKey: KEY,
    payload: { body: {} },
    result: {},
    attempts: 1,
    availableAt: now,
    lockedBy: null,
    lockedUntil: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function projectRowFor(overrides: Partial<ProjectRow> = {}): ProjectRow {
  const now = new Date();
  return {
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    name: 'Replay Project',
    repoUrl: 'https://github.com/kortix-managed/replay-project.git',
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    status: 'active',
    secretDefaultStrategy: 'runtime',
    metadata: {},
    idempotencyKey: null,
    sandboxProviderGeneration: 0,
    splitPending: false,
    lastOpenedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function commandFor(body: Record<string, unknown>): CreateSessionCommand {
  return {
    source: 'ui',
    project: projectRowFor(),
    userId: 'user-1',
    requestingPrincipalType: 'human',
    body,
    idempotencyKey: KEY,
  };
}

beforeEach(() => {
  delete cfg.KORTIX_INSTANCE_ID;
  projectSession = null;
});

describe('createSession — the idempotent replay arm (`claimed.existing`)', () => {
  test('a key claimed under a different account never answers with the foreign command', async () => {
    claimedRow = existingRowFor({ accountId: OTHER_ACCOUNT_ID });

    const result = await createSession(commandFor({}));

    expect(result.status).toBe('failed');
    expect(result.retryable).toBe(false);
    expect(result.error?.body).toEqual({
      error: 'Idempotency key is already in use',
      code: 'IDEMPOTENCY_KEY_CONFLICT',
    });
  });

  test('a different parent_session_id conflicts with IDEMPOTENCY_PARENT_CONFLICT', async () => {
    claimedRow = existingRowFor({ payload: { body: { parent_session_id: 'parent-a' } }, sessionId: null });

    const result = await createSession(commandFor({ parent_session_id: 'parent-b' }));

    expect(result.error?.body.code).toBe('IDEMPOTENCY_PARENT_CONFLICT');
    expect(result.error?.body.error).toBe('Idempotency key was already used with a different parent session');
  });

  test('a different fork_from_session_id conflicts with IDEMPOTENCY_FORK_CONFLICT', async () => {
    claimedRow = existingRowFor({ payload: { body: { fork_from_session_id: 'fork-a' } }, sessionId: null });

    const result = await createSession(commandFor({ fork_from_session_id: 'fork-b' }));

    expect(result.error?.body.code).toBe('IDEMPOTENCY_FORK_CONFLICT');
    expect(result.error?.body.error).toBe('Idempotency key was already used with a different fork source');
  });

  test('different connector_bindings conflict with IDEMPOTENCY_BINDING_CONFLICT', async () => {
    claimedRow = existingRowFor({
      payload: { body: { connector_bindings: { github: { connection_id: '11111111-1111-4111-8111-111111111111' } } } },
      sessionId: null,
    });

    const result = await createSession(
      commandFor({ connector_bindings: { github: { connection_id: '22222222-2222-4222-8222-222222222222' } } }),
    );

    expect(result.error?.body.code).toBe('IDEMPOTENCY_BINDING_CONFLICT');
    expect(result.error?.body.error).toBe('Idempotency key was already used with different connector bindings');
  });

  test('different provider_secret_pools conflict with IDEMPOTENCY_PROVIDER_POOL_CONFLICT', async () => {
    claimedRow = existingRowFor({
      payload: { body: { provider_secret_pools: { llm: 'pool-a' } } },
      sessionId: null,
    });

    const result = await createSession(commandFor({ provider_secret_pools: { llm: 'pool-b' } }));

    expect(result.error?.body.code).toBe('IDEMPOTENCY_PROVIDER_POOL_CONFLICT');
    expect(result.error?.body.error).toBe('Idempotency key was already used with different provider secret pools');
  });

  test('a different secrets allowlist conflicts with IDEMPOTENCY_SECRETS_CONFLICT', async () => {
    claimedRow = existingRowFor({ payload: { body: { secrets: ['s1'] } }, sessionId: null });

    const result = await createSession(commandFor({ secrets: ['s2'] }));

    expect(result.error?.body.code).toBe('IDEMPOTENCY_SECRETS_CONFLICT');
    expect(result.error?.body.error).toBe('Idempotency key was already used with a different secrets allowlist');
  });

  test('a different runtime_context conflicts with IDEMPOTENCY_CONTEXT_CONFLICT', async () => {
    claimedRow = existingRowFor({
      payload: { body: { runtime_context: { branch: 'main' } } },
      sessionId: null,
    });

    const result = await createSession(commandFor({ runtime_context: { branch: 'feature' } }));

    expect(result.error?.body.code).toBe('IDEMPOTENCY_CONTEXT_CONFLICT');
    expect(result.error?.body.error).toBe('Idempotency key was already used with a different runtime_context');
  });

  test('a replayed key mapping to a soft-deleted session is spent: IDEMPOTENCY_KEY_SESSION_DELETED', async () => {
    claimedRow = existingRowFor();
    projectSession = { sessionId: SESSION_ID, metadata: { deletedAt: '2026-11-07T00:00:00.000Z' } };

    const result = await createSession(commandFor({}));

    expect(result.status).toBe('failed');
    expect(result.retryable).toBe(false);
    expect(result.error).toEqual({
      status: 409,
      body: {
        error: 'Idempotency key maps to a deleted session — use a new key',
        code: 'IDEMPOTENCY_KEY_SESSION_DELETED',
      },
    });
  });

  test('a replayed key whose session still exists answers the deduped result with the live session row', async () => {
    claimedRow = existingRowFor();
    projectSession = { sessionId: SESSION_ID, metadata: {} };

    const result = await createSession(commandFor({}));

    expect(result.status).toBe('deduped');
    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.row?.sessionId).toBe(SESSION_ID);
  });
});
