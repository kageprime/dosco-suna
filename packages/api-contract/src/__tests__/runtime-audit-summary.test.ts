import { describe, expect, test } from 'bun:test';
import {
  RUNTIME_AUDIT_SECRET_VALUE_RE,
  RUNTIME_AUDIT_STRUCTURAL_WRAPPER_KEYS,
  RUNTIME_AUDIT_SUMMARY_KEYS,
  isSafeRuntimeAuditSummary,
} from '../runtime-relay';

/**
 * The single definition of the runtime audit summary allowlist. Before
 * KRTX-4621 apps/api's ingestion guard and kortixd's relay sanitizer each
 * kept a hand copy, and the copies had already drifted on `custom`. Both ends
 * import this module for their audit types already.
 */
describe('runtime audit summary allowlist', () => {
  test('one key set: the union both ends ingest and relay, custom included', () => {
    expect([...RUNTIME_AUDIT_SUMMARY_KEYS].sort()).toEqual([
      'agent',
      'agentID',
      'agentId',
      'agentName',
      'archived',
      'bytes',
      'callID',
      'callId',
      'compacting',
      'completed',
      'count',
      'created',
      'custom',
      'delivery',
      'depth',
      'duration',
      'durationMs',
      'end',
      'error',
      'executionID',
      'executionId',
      'filename',
      'id',
      'info',
      'message',
      'messageID',
      'messageId',
      'mime',
      'mode',
      'modelID',
      'multiple',
      'name',
      'parentID',
      'parentId',
      'part',
      'partID',
      'partId',
      'path',
      'providerID',
      'role',
      'session',
      'sessionID',
      'sessionId',
      'session_id',
      'size',
      'start',
      'state',
      'status',
      'time',
      'tool',
      'toolCallID',
      'toolCallId',
      'type',
      'updated',
    ]);
  });

  test('one credential-shaped-value regex', () => {
    for (const secret of [
      'Bearer abc123.def',
      'sk-abcdefghijklmnop',
      'ghp_abcdefghij1234',
      'kortix_pat_abcdefghij1234',
      'password=hunter2',
      'api_key=abc123',
      'x-token=abc123',
    ]) {
      expect(RUNTIME_AUDIT_SECRET_VALUE_RE.test(secret)).toBe(true);
    }
    for (const plain of [
      'sk',
      'hello world',
      'token without a value',
      'bearer:missing-space',
      'session_1234567890',
    ]) {
      expect(RUNTIME_AUDIT_SECRET_VALUE_RE.test(plain)).toBe(false);
    }
  });

  test('the structural wrapper keys', () => {
    expect([...RUNTIME_AUDIT_STRUCTURAL_WRAPPER_KEYS].sort()).toEqual([
      'error',
      'info',
      'message',
      'part',
      'session',
      'state',
    ]);
  });

  test('the recursive safe-summary validator: every allowlisted key passes, wrappers recurse', () => {
    expect(
      isSafeRuntimeAuditSummary({
        sessionID: 'ses_1',
        custom: 'note',
        part: { callID: 'call_1', state: { status: 'completed', time: { start: 100 } } },
      }),
    ).toBe(true);
    expect(isSafeRuntimeAuditSummary(null)).toBe(false);
    expect(isSafeRuntimeAuditSummary({ prompt: 'private' })).toBe(false);
    expect(isSafeRuntimeAuditSummary({ name: 'sk-abcdefghijklmnop' })).toBe(false);
    // A structural wrapper only survives as a recursively safe object; the
    // sanitizer never persists a primitive wrapper value.
    expect(isSafeRuntimeAuditSummary({ message: 'primitive prompt body' })).toBe(false);
    expect(isSafeRuntimeAuditSummary({ message: { name: 'x' } })).toBe(true);
    expect(isSafeRuntimeAuditSummary({ id: { id: { id: { id: { id: 1 } } } } })).toBe(true);
    expect(isSafeRuntimeAuditSummary({ id: { id: { id: { id: { id: { id: 1 } } } } } })).toBe(
      false,
    );
  });
});
