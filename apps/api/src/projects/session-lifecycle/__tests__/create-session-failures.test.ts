import { beforeEach, expect, mock, test } from 'bun:test';
import { projects } from '@kortix/db';
import type { CreateSessionCommand, SessionLifecycleResult } from '../types';
import type { ProjectRow, ProjectSessionRow } from '../../lib/serializers';
import type { SessionLifecycleCommandRow } from '../store';
import { RepositoryDisconnectedError, repositoryDisconnectedBody } from '../../../shared/repository-health';

const ACCOUNT_ID = 'acct-1';
const PROJECT_ID = 'proj-1';
const KEY = 'key-1';
const COMMAND_ID = 'cmd-existing-1';
const SESSION_ID = 'sess-1';
let existing = false;
let projectPresent = true;
let actor: string | null = 'user-1';
let createError: SessionLifecycleResult['error'];
let thrown: Error | undefined;
let postFails = false;
let outcome: 'queued' | 'dead_lettered' = 'queued';
let claimedRow: SessionLifecycleCommandRow;
const realConfig = await import('../../../config');
mock.module('../../../config', () => ({ ...realConfig, config: { KORTIX_URL: 'https://api.test' } }));
mock.module('../../../shared/db', () => ({
  hasDatabase: () => true,
  withDbTransaction: <T,>(action: () => Promise<T>): Promise<T> => action(),
  db: { select: () => ({ from: (table: unknown) => ({ where: () => ({ limit: async () => table === projects && projectPresent ? [projectRowFor()] : [] }) }) }) },
}));
const realStore = await import('../store');
mock.module('../store', () => ({
  ...realStore,
  claimCreateSessionCommand: async () => ({ row: claimedRow, existing }),
  markCommandFailed: async () => outcome,
  markCommandSucceeded: async () => true,
}));
const realLease = await import('../command-lease');
mock.module('../command-lease', () => ({ ...realLease, withCommandLeaseHeartbeat: async <T,>(_row: SessionLifecycleCommandRow, run: () => Promise<T>) => run() }));
const realSessions = await import('../../lib/sessions');
mock.module('../../lib/sessions', () => ({ ...realSessions, createProjectSession: async () => {
  if (thrown) throw thrown;
  return createError ? { error: createError } : { row: createdSessionRow() };
} }));
const realBackpressure = await import('../backpressure');
mock.module('../backpressure', () => ({ ...realBackpressure, sessionBackpressureState: async () => ({ shouldQueue: false, reason: null }) }));
const realActor = await import('../actor');
mock.module('../actor', () => ({ ...realActor, resolveProjectAutomationActor: async () => actor }));
const realDelivery = await import('../follow-up-delivery');
mock.module('../follow-up-delivery', () => ({ ...realDelivery, deliverThroughQueue: async () => postFails ? 'refused' : 'delivered' }));
const { createSession, executeQueuedCreate } = await import('../create-session');
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

function createdSessionRow(): ProjectSessionRow {
  const now = new Date(0);
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


beforeEach(() => {
  existing = false;
  projectPresent = true;
  actor = 'user-1';
  createError = undefined;
  thrown = undefined;
  postFails = false;
  outcome = 'queued';
  claimedRow = existingRowFor({ sessionId: null, actorUserId: null, payload: { body: {}, requestingPrincipalType: 'human' } });
});

const postCreate: CreateSessionCommand['postCreate'] = [{ type: 'deliver_prompt', source: 'ui', text: 'synthetic prompt' }];

test('unkeyed post-create failure has no command id, retry or requeued flag', async () => {
  postFails = true;
  expect(await createSession({ ...commandFor({}), idempotencyKey: undefined, postCreate })).toEqual({
    status: 'failed', sessionId: SESSION_ID, row: createdSessionRow(), retryable: false,
    error: { status: 500, body: { error: 'initial prompt delivery refused' } },
  });
});

test.each(['queued', 'dead_lettered'] as const)('leased post-create failure: %s', async (next) => {
  postFails = true;
  outcome = next;
  expect(await createSession({ ...commandFor({}), postCreate })).toEqual({
    status: 'failed', commandId: COMMAND_ID, sessionId: SESSION_ID, row: createdSessionRow(), retryable: true,
    requeued: next !== 'dead_lettered', error: { status: 500, body: { error: 'initial prompt delivery refused' } },
  });
});

test('leased create throw preserves its retryable 503 body', async () => {
  thrown = new Error('synthetic clone timeout');
  expect(await createSession(commandFor({}))).toEqual({ status: 'failed', commandId: COMMAND_ID, retryable: true, requeued: true, error: { status: 503, body: { error: thrown.message } } });
});

test('disconnected repository throw is terminal and has the canonical 409 body', async () => {
  const error = new RepositoryDisconnectedError({ reason: 'app_uninstalled', repository: 'synthetic/repo', installationId: null });
  thrown = error;
  expect(await createSession(commandFor({}))).toEqual({ status: 'failed', commandId: COMMAND_ID, retryable: false, requeued: false, error: { status: 409, body: repositoryDisconnectedBody(error) } });
});

test('queued create missing project is a terminal 404 without requeued', async () => {
  projectPresent = false;
  expect(await executeQueuedCreate(claimedRow)).toEqual({ status: 'failed', commandId: COMMAND_ID, retryable: false, error: { status: 404, body: { error: 'Project not found' } } });
});

test('queued create missing owner is a terminal 409 without requeued', async () => {
  actor = null;
  expect(await executeQueuedCreate(claimedRow)).toEqual({ status: 'failed', commandId: COMMAND_ID, retryable: false, error: { status: 409, body: { error: 'No account owner available to own the session' } } });
});

test('archived workspace is a terminal 404 without command id', async () => {
  expect(await createSession({ ...commandFor({}), idempotencyKey: undefined, project: projectRowFor({ status: 'archived' }) })).toEqual({ status: 'failed', retryable: false, error: { status: 404, body: { error: 'This workspace was deleted', code: 'project_archived' } } });
});

test.each([400, 429, 500, 503])('create error %s passes through the exact error and retryability', async (status) => {
  createError = { status, body: { error: 'synthetic provider error', code: 'synthetic' } };
  expect(await createSession({ ...commandFor({}), idempotencyKey: undefined })).toEqual({ status: 'failed', error: createError, retryable: status !== 400 });
});
