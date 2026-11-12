/** Regression coverage for the shared log-window throttle: the first line of
 * a window logs, later lines count toward the next emitted line's
 * `suppressed`. Moved here from dead-credential-log.test.ts with the engine
 * (shared/log-window.ts); the marked-refusal handler behavior stays pinned in
 * dead-credential-log.test.ts.
 */
import { describe, expect, test } from 'bun:test';

const { logWindowDecision, logWindowWarnDecision, resetLogWindowsForTests } = await import('./log-window');

describe('log window decision', () => {
  test('the first refusal of a message logs, repeats inside the window are suppressed with the count kept', () => {
    resetLogWindowsForTests();
    let now = 1_000_000;
    expect(logWindowDecision('POST /p -> 401 [HTTPException] PAT not found or revoked', now)).toEqual({
      log: true,
      suppressed: 0,
    });
    for (let i = 1; i <= 4; i += 1) {
      now += 5_000;
      expect(logWindowDecision('POST /p -> 401 [HTTPException] PAT not found or revoked', now)).toEqual({
        log: false,
        suppressed: 0,
      });
    }
  });

  test('the next logged line after the window carries the volume suppressed since the previous one', () => {
    resetLogWindowsForTests();
    let now = 2_000_000;
    const key = 'POST /p -> 401 [HTTPException] PAT not found or revoked';
    expect(logWindowDecision(key, now).log).toBe(true);
    for (let i = 0; i < 3; i += 1) {
      now += 1_000;
      logWindowDecision(key, now);
    }
    now += 601_000;
    const next = logWindowDecision(key, now);
    expect(next.log).toBe(true);
    expect(next.suppressed).toBe(3);
    // The count resets with the window: a refusal long after the burst does
    // not inherit the stale volume.
    now += 601_000;
    const later = logWindowDecision(key, now);
    expect(later.log).toBe(true);
    expect(later.suppressed).toBe(0);
  });

  test('a different message logs independently of another one inside its window', () => {
    resetLogWindowsForTests();
    const now = 3_000_000;
    expect(logWindowDecision('POST /p/turn-stream -> 401 [HTTPException] PAT not found or revoked', now).log).toBe(true);
    expect(logWindowDecision('POST /p/audit/events -> 401 [HTTPException] PAT not found or revoked', now).log).toBe(true);
    expect(logWindowDecision('POST /p/turn-stream -> 401 [HTTPException] PAT not found or revoked', now + 1_000).log).toBe(false);
  });

  test('the tracked-window map is bounded: the oldest key is evicted past the cap', () => {
    resetLogWindowsForTests();
    const now = 4_000_000;
    // Past the cap, the first key must have been evicted, so it logs again
    // immediately instead of being suppressed forever.
    expect(logWindowDecision('key-a', now).log).toBe(true);
    for (let i = 0; i < 20_000; i += 1) logWindowDecision(`key-${i}`, now);
    expect(logWindowDecision('key-a', now + 1_000).log).toBe(true);
  });
});

describe('log window warn decision — the escalation cap (KRTX-4674 residual)', () => {
  // The severity escalation (dead-credential-log's burst band, applied by the
  // error handler and the sandbox-proxy forward refusals) is evaluated per
  // ten-minute window and is replica-local: a caller grinding past the band
  // through a whole hour made EVERY window's line ship at warn — 16/15/15
  // lines per route across three replicas in the 2026-11-11 09:00 UTC hour —
  // above the infra-sweep's new-warn-pattern bar (10/h per normalized
  // pattern), which re-filed the issue. The cap: the hour's first escalated
  // line stays warn, the hour's other windows drop to info.
  test('a grind hour spends one warn slot per key: five escalated windows ship one warn', () => {
    resetLogWindowsForTests();
    const key = 'GET /p -> 403 [HTTPException] mfa';
    const band = 10; // dead-credential-log.ts DEAD_CREDENTIAL_BURST_SUPPRESSED
    let now = 1_000_000;
    let warnsAllowed = 0;
    // One 10-minute window per loop: open it, leave the burst band pending,
    // open the next — the next decision reports the pending volume, which is
    // the line the escalation would ship at warn. Five of them fit inside an
    // hour; the sixth lands past it.
    for (let w = 0; w < 5; w += 1) {
      logWindowDecision(key, now);
      for (let i = 0; i < band; i += 1) logWindowDecision(key, now + 1_000);
      const next = logWindowDecision(key, now + 601_000);
      if (next.log && next.suppressed >= band && logWindowWarnDecision(key, now + 601_000)) {
        warnsAllowed += 1;
      }
      now += 601_000;
    }
    expect(warnsAllowed).toBe(1);
  });

  test('the warn slot renews after the hour, and the budget is per key', () => {
    resetLogWindowsForTests();
    const sessions = 'GET /p/sessions -> 403 mfa';
    const triggers = 'GET /p/triggers -> 403 mfa';
    expect(logWindowWarnDecision(sessions, 1_000_000)).toBe(true);
    expect(logWindowWarnDecision(sessions, 1_001_000)).toBe(false);
    // A different key keeps its own hour.
    expect(logWindowWarnDecision(triggers, 1_002_000)).toBe(true);
    // Past the hour the slot renews.
    expect(logWindowWarnDecision(sessions, 1_000_000 + 3_700_000)).toBe(true);
  });
});
