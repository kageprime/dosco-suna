import { describe, expect, test } from 'bun:test';

import { isTerminalFireFailure } from './trigger-fire-failure';

describe('isTerminalFireFailure: a scheduled fire no retry can fix ends on its first failure', () => {
  test('retryable: false is terminal, whatever the code', () => {
    expect(isTerminalFireFailure({ retryable: false })).toBe(true);
    expect(isTerminalFireFailure({ retryable: false, errorCode: 'app_call_failed' })).toBe(true);
  });

  test('retryable: true or absent with no permanent code is retried', () => {
    expect(isTerminalFireFailure({ retryable: true })).toBe(false);
    expect(isTerminalFireFailure({})).toBe(false);
    expect(isTerminalFireFailure({ errorCode: 'something_transient' })).toBe(false);
  });

  test('a permanent code stays terminal even when the fire says retryable', () => {
    for (const errorCode of [
      'insufficient_credits',
      'subscription_required',
      'no_account',
      'no_usable_model',
      'INVALID_SESSION_MODEL',
      'reminder_session_gone',
      'repository_disconnected',
    ]) {
      expect(isTerminalFireFailure({ retryable: true, errorCode })).toBe(true);
    }
  });
});
