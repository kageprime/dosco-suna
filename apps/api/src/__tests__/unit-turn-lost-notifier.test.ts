import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import { logger } from '../lib/logger';
import { notifyTurnLost, registerTurnLostNotifier } from '../shared/turn-lost-notifier';

// Mirrors unit-session-failure-notifier.test.ts for the turn-lost relay: every
// registered relay hears the notice, one relay's failure never stops the next,
// and a failure is logged, never thrown to the caller (the reaper must not
// break on a relay).
const registered: Array<() => void> = [];
const register = (fn: (id: string, token: string) => unknown) => {
  registered.push(registerTurnLostNotifier(fn));
};

afterEach(() => {
  while (registered.length) registered.pop()!();
});

describe('turn-lost-notifier', () => {
  test('forwards sessionId + turnToken to the registered relay', () => {
    const seen: Array<[string, string]> = [];
    register((id, token) => seen.push([id, token]));
    notifyTurnLost('s1', 't1');
    expect(seen).toEqual([['s1', 't1']]);
  });

  test('every registered relay hears the notice; registering the same function twice calls it once', () => {
    const seen: string[] = [];
    register(() => seen.push('a'));
    const fn = () => seen.push('b');
    register(fn);
    register(fn);
    notifyTurnLost('s1', 't1');
    expect(seen.sort()).toEqual(['a', 'b']);
  });

  test('unregistering removes the relay', () => {
    let calls = 0;
    const remove = registerTurnLostNotifier(() => (calls += 1));
    remove();
    notifyTurnLost('s1', 't1');
    expect(calls).toBe(0);
  });

  test('a throwing relay is swallowed and does not stop the next relay', () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      let reached = false;
      register(() => {
        throw new Error('relay exploded');
      });
      register(() => (reached = true));
      expect(() => notifyTurnLost('s1', 't1')).not.toThrow();
      expect(reached).toBe(true);
      expect(warn).toHaveBeenCalledWith('[turn-lost-notifier] relay failed', {
        sessionId: 's1',
        error: 'relay exploded',
      });
    } finally {
      warn.mockRestore();
    }
  });

  // Bun does not fail a test on an unhandled rejection, so "did not throw" is
  // not proof here. The rejection must reach the notifier's own catch.
  test('a rejecting async relay is caught and logged, not left unhandled', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      register(async () => {
        throw new Error('async relay exploded');
      });
      notifyTurnLost('s1', 't1');
      await new Promise((r) => setTimeout(r, 5));
      expect(warn).toHaveBeenCalledWith('[turn-lost-notifier] relay failed', {
        sessionId: 's1',
        error: 'async relay exploded',
      });
    } finally {
      warn.mockRestore();
    }
  });
});
