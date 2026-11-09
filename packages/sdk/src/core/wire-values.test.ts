import { expect, test } from 'bun:test';
import * as sdk from '../index';

test('runtimeSupports takes every contract capability, session.steer included', () => {
  const caps = ['session.subagents', 'session.steer'];
  expect(sdk.runtimeSupports(caps, 'session.steer')).toBe(true);
  expect(sdk.runtimeSupports(caps, 'session.team_tasks')).toBe(false);
  expect(sdk.RUNTIME_CAPABILITIES).toContain('session.log.v2');
});

test('the SDK root exports the value sets and their decisions', () => {
  expect(sdk.THREAD_STATUSES).toEqual(['idle', 'busy', 'retry', 'compacting']);
  expect(sdk.toKortixSessionStatusType('compacting')).toBe('busy');
  expect(sdk.toRuntimeThreadStatus('retry')).toBe('busy');
  expect(sdk.SESSION_CONTROL_FRAME_TYPES).toContain('kortix.control.turn');
  expect(sdk.SESSION_STREAM_FRAME_TYPES).toContain('kortix.stream.revoked');
  expect(sdk.isParkedRuntimeDownReason('sandbox_stopped')).toBe(true);
  expect(sdk.isSessionStartTransportReason('runtime_status_unknown')).toBe(true);
  expect(sdk.isSessionPromptReason('held')).toBe(true);
  expect(sdk.CREDIT_ACCOUNT_PAYMENT_STATUSES).toContain('cancelling');
});
