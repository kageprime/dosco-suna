// Characterization tests for the drain's `create_session` post-create
// finalization: a queued create whose post-create actions fail keeps the row
// queued with `result.post_create_error` set; one whose actions succeed
// closes it succeeded and clears its trigger alert. They pin the behavior
// before the three copies of the finalization dedupe into
// `finalizeCreatedSession` (KRTX-4471) — these must pass unchanged before and
// after.
//
// Same mocking caveat as the sibling session-lifecycle test files:
// `mock.module` is process-global in bun:test, so this file runs on its own
// under `--isolate`.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { projects, sessionSandboxes } from '@kortix/db';
import type { ProjectSessionRow } from '../../lib/serializers';
import type { SessionLifecycleCommandRow } from '../store';

const ACCOUNT_ID = 'acct-1';
const PROJECT_ID = 'proj-1';
const SESSION_ID = 'sess-9';
const TRIGGER_SLUG = 'nightly-refactor';

const cfg: { KORTIX_URL: string; KORTIX_INSTANCE_ID?: string } = { KORTIX_URL: 'https://api.test' };

let
  claimed: SessionLifecycleCommandRow[] = [];
let bindChatThreadCalls = 0;
let clearTriggerAlertCalls: Array<{ projectId: string; accountId: string; slug: string; source: 'fire' }> = [];
let failedCalls: Array<{
  commandId: string;
  message: string;
  retryable: boolean;
  result: Record<string, unknown> | undefined;
  outcome: 'queued' | 'dead_lettered';
}> = [];
let markCommandFailedOutcome: 'queued' | 'dead_lettered' = 'queued';
let succeededCalls: Array<{
  commandId: string;
  result: Record<string, unknown>;
  sessionId: string | null;
  applied: boolean;
}> = [];
// `false` plays the lost lease: markCommandSucceeded's lease-guarded update
// applied zero rows, so another owner reclaimed the row before the close.
let markCommandSucceededApplied = true;

const realConfig = await import('../../../config');
mock.module('../../../config', () => ({
  ...realConfig,
  config: cfg,
  SANDBOX_VERSION: 'test',
}));

mock.module('../../../shared/db', () => ({
  withDbTransaction: <T,>(action: () => Promise<T>): Promise<T> => action(),
  hasDatabase: () => true,
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === projects) return [{ projectId: PROJECT_ID, accountId: ACCOUNT_ID, status: 'active' }];
            if (table === sessionSandboxes) return [];
            return [];
          },
        }),
      }),
    }),
    update: () => ({
      set: () => ({ where: async () => {} }),
    }),
  },
}));

const realThreads = await import('../../../channels/core/threads');
mock.module('../../../channels/core/threads', () => ({
  ...realThreads,
  bindChatThread: async () => {
    bindChatThreadCalls += 1;
  },
  releaseCreateClaims: async () => {},
}));

const realSessions = await import('../../lib/sessions');
mock.module('../../lib/sessions', () => ({
  ...realSessions,
  createProjectSession: async () => ({ row: createdSessionRow() }),
}));

const realActor = await import('../actor');
mock.module('../actor', () => ({
  ...realActor,
  resolveProjectAutomationActor: async () => 'automation-user-1',
}));

const realBackpressure = await import('../backpressure');
mock.module('../backpressure', () => ({
  ...realBackpressure,
  sessionBackpressureState: async () => ({ shouldQueue: false, reason: null }),
}));

const realTriggerAlerts = await import('../../lib/trigger-alerts');
mock.module('../../lib/trigger-alerts', () => ({
  ...realTriggerAlerts,
  clearTriggerAlert: async (input: { projectId: string; accountId: string; slug: string; source: 'fire' }) => {
    clearTriggerAlertCalls.push(input);
    return true;
  },
}));

const realStore = await import('../store');
mock.module('../store', () => ({
  ...realStore,
  claimDueLifecycleCommands: async () => claimed,
  markCommandFailed: async (
    row: { commandId: string },
    message: string,
    opts: { retryable: boolean; attempts: number; result?: Record<string, unknown> },
  ) => {
    failedCalls.push({
      commandId: row.commandId,
      message,
      retryable: opts.retryable,
      result: opts.result,
      outcome: markCommandFailedOutcome,
    });
    return markCommandFailedOutcome;
  },
  markCommandSucceeded: async (
    row: { commandId: string },
    result: Record<string, unknown>,
    sessionId?: string | null,
  ) => {
    succeededCalls.push({
      commandId: row.commandId,
      result,
      sessionId: sessionId ?? null,
      applied: markCommandSucceededApplied,
    });
    return markCommandSucceededApplied;
  },
}));

const realInstanceRelease = await import('../instance-release');
mock.module('../instance-release', () => ({
  ...realInstanceRelease,
  loadSandboxMetadataForSessions: async () => new Map(),
  releaseCommandToOwningInstance: async () => {},
}));

// The queued create's post-create prompt delivery refuses: that is the failure
// the first test pins (`initial prompt delivery refused`).
const realFollowUp = await import('../follow-up-delivery');
mock.module('../follow-up-delivery', () => ({
  ...realFollowUp,
  deliverThroughQueue: async () => 'refused',
}));

const { drainSessionLifecycleQueue } = await import('../drain');

function clearTriggerAlertInputOf(): { projectId: string; accountId: string; slug: string; source: 'fire' } {
  return { projectId: PROJECT_ID, accountId: ACCOUNT_ID, slug: TRIGGER_SLUG, source: 'fire' };
}

/** A full typed `project_sessions` row — the shape `createProjectSession` returns. */
function createdSessionRow(): ProjectSessionRow {
  const now = new Date();
  return {
    sessionId: SESSION_ID,
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    branchName: 'main',
    baseRef: 'main',
    sandboxProvider: 'daytona',
    sandboxId: null,
    sandboxUrl: null,
    runtimeSessionId: null,
    agentName: 'default',
    status: 'queued',
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
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}

function queuedCreateRow(overrides: Partial<SessionLifecycleCommandRow> = {}): SessionLifecycleCommandRow {
  const now = new Date();
  return {
    commandId: 'cmd-create-1',
    commandType: 'create_session',
    // A trigger create: `commandTriggerSlug` resolves the slug only for
    // `source: 'trigger:<kind>'` rows, which is what the alert-clear
    // assertion below needs.
    source: 'trigger:git',
    artifactId: null,
    status: 'running',
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    sessionId: null,
    actorUserId: null,
    idempotencyKey: 'key-1',
    payload: {
      body: {},
      postingPrincipalType: undefined,
      postCreate: [{ type: 'bind_chat_thread', platform: 'slack', workspaceId: 'ws-1', threadId: 't-1' }],
      metadata: { trigger_kind: 'git', trigger_slug: TRIGGER_SLUG },
    },
    result: {},
    attempts: 1,
    availableAt: now,
    lockedBy: 'worker-x',
    lockedUntil: new Date(now.getTime() + 5 * 60_000),
    lastError: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  delete cfg.KORTIX_INSTANCE_ID;
  bindChatThreadCalls = 0;
  clearTriggerAlertCalls = [];
  failedCalls = [];
  succeededCalls = [];
  markCommandFailedOutcome = 'queued';
  markCommandSucceededApplied = true;
  claimed = [queuedCreateRow()];
});

describe('drainSessionLifecycleQueue — create_session post-create finalization', () => {
  test('a post-create action that refuses keeps the row queued with result.post_create_error set', async () => {
    claimed = [
      queuedCreateRow({
        payload: {
          body: {},
          postCreate: [{ type: 'deliver_prompt', source: 'trigger:git', text: 'run' }],
          metadata: { trigger_kind: 'git', trigger_slug: TRIGGER_SLUG },
        },
      }),
    ];

    const result = await drainSessionLifecycleQueue({ limit: 10 });

    expect(failedCalls).toHaveLength(1);
    const [failure] = failedCalls;
    expect(failure.retryable).toBe(true);
    expect(failure.result).toEqual({
      status: 'created',
      session_id: SESSION_ID,
      source: 'trigger:git',
      post_create_error: 'initial prompt delivery refused',
    });
    expect(failure.outcome).toBe('queued');
    // The row stays queued for a retry: the drain counts it as queued, not failed.
    expect(result.queued).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(clearTriggerAlertCalls).toEqual([]);
  });

  test('a post-create action that succeeds closes the row succeeded and clears its trigger alert', async () => {
    const result = await drainSessionLifecycleQueue({ limit: 10 });

    expect(failedCalls).toHaveLength(0);
    expect(bindChatThreadCalls).toBe(1);
    // Row finalization: the success write carries the created result under
    // this row's lease, and the write applied (the lease still held).
    expect(succeededCalls).toHaveLength(1);
    const [succeeded] = succeededCalls;
    expect(succeeded.commandId).toBe('cmd-create-1');
    expect(succeeded.result).toEqual({
      status: 'created',
      session_id: SESSION_ID,
      source: 'trigger:git',
    });
    expect(succeeded.sessionId).toBe(SESSION_ID);
    expect(succeeded.applied).toBe(true);
    expect(clearTriggerAlertCalls).toEqual([
      clearTriggerAlertInputOf(),
    ]);
    expect(result.succeeded).toBe(1);
  });

  test('a success write that lost its lease clears no trigger alert', async () => {
    markCommandSucceededApplied = false;

    const result = await drainSessionLifecycleQueue({ limit: 10 });

    expect(failedCalls).toHaveLength(0);
    expect(succeededCalls).toHaveLength(1);
    // The write ran and lost (`applied: false`): this drain no longer owns the
    // row, so it must not end the fire's alert streak it did not finish.
    expect(clearTriggerAlertCalls).toEqual([]);
    expect(result.succeeded).toBe(1);
  });
});
