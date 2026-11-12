/**
 * The give-up line of an exhausted preview forward is rate-limited.
 *
 * The line fired once per failed request, and the failed-request rate IS the
 * caller's poll rate: one browser preview pane polling a stopped dev server —
 * the box itself stayed healthy, the daemon port answered throughout —
 * emitted 49 warns in 15 min from ONE sandbox (KRTX-4695). The line ships
 * through the shared log-noise throttle (shared/log-window.ts), keyed per
 * (sandbox, port) window: first line per window, the next window's line
 * carrying `suppressed`, severity following the window's volume (KRTX-4454)
 * so a one-off dead port ships info and a hammered one stays warn. The key
 * is the port's episode, not the message, so one dead port cannot mask
 * another's first line.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { logger } from '../../lib/logger';
import { DEAD_CREDENTIAL_BURST_SUPPRESSED } from '../../shared/dead-credential-log';
import { resetLogWindowsForTests } from '../../shared/log-window';
import { reportPortNotAnswering } from './retry';

type ShippedLine = { channel: string; args: unknown[] };
let shipped: ShippedLine[] = [];
let spies: Array<{ mockRestore: () => void }> = [];

function giveUpMessage(sandboxId: string): string {
  return `[PREVIEW] Sandbox ${sandboxId}:3000 still not answering after 4 attempts (status 502)`;
}

function shippedGiveUpLines(): ShippedLine[] {
  return shipped.filter(
    (line) => typeof line.args[0] === 'string' && (line.args[0] as string).includes('not answering after'),
  );
}

beforeEach(() => {
  resetLogWindowsForTests();
  shipped = [];
  spies = [
    spyOn(logger, 'info').mockImplementation((...args: unknown[]) => {
      shipped.push({ channel: 'logger.info', args });
    }),
    spyOn(logger, 'warn').mockImplementation((...args: unknown[]) => {
      shipped.push({ channel: 'logger.warn', args });
    }),
  ];
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
});

describe('reportPortNotAnswering — the give-up line is throttled', () => {
  test('49 exhausted polls of one dead port ship ONE line, not 49', () => {
    const start = Date.now();
    // The observed incident: one poll of a dead port every ~5 s for 15 min.
    for (let i = 0; i < 49; i += 1) {
      reportPortNotAnswering(giveUpMessage('sbx-test'), 'sbx-test', 3000, start + i * 5_000);
    }
    expect(shippedGiveUpLines().length).toBe(1);
  });

  test('the message text passes through verbatim — the log sweep groups on it', () => {
    const message = giveUpMessage('sbx-test');
    reportPortNotAnswering(message, 'sbx-test', 3000, Date.now());
    expect(shippedGiveUpLines()[0]?.args[0]).toBe(message);
  });

  test('keyed per sandbox and port: another dead port ships its own first line', () => {
    const start = Date.now();
    reportPortNotAnswering(giveUpMessage('sbx-one'), 'sbx-one', 3000, start);
    reportPortNotAnswering(giveUpMessage('sbx-two'), 'sbx-two', 3000, start + 1_000);
    expect(shippedGiveUpLines().length).toBe(2);
    expect(shippedGiveUpLines()[1]?.args[1]).toMatchObject({
      sandboxId: 'sbx-two',
      port: 3000,
      suppressed: 0,
    });
  });

  test('the first line of the next window carries the suppressed count', () => {
    const start = Date.now();
    for (let i = 0; i < 3; i += 1) {
      reportPortNotAnswering(giveUpMessage('sbx-test'), 'sbx-test', 3000, start + i * 5_000);
    }
    // Eleven minutes later the window has passed: the next line ships and
    // reports what the last window swallowed.
    reportPortNotAnswering(giveUpMessage('sbx-test'), 'sbx-test', 3000, start + 11 * 60_000);
    const lines = shippedGiveUpLines();
    expect(lines.length).toBe(2);
    expect((lines[1]?.args[1] as Record<string, unknown>).suppressed).toBe(2);
  });

  test('severity follows the window volume: a one-off dead port ships info, a hammered one warn', () => {
    const start = Date.now();
    // One give-up, never repeated: churn band, the line ships at info.
    reportPortNotAnswering(giveUpMessage('sbx-test'), 'sbx-test', 3000, start);
    expect(shippedGiveUpLines().length).toBe(1);
    expect(shippedGiveUpLines()[0]?.channel).toBe('logger.info');

    // A preview pane polling a dead port every ~5 s: 12 suppressed in the
    // window, above the burst band (KRTX-4454), so the next window's line
    // keeps the pattern at warn for the infra sweep.
    for (let i = 0; i < 12; i += 1) {
      reportPortNotAnswering(giveUpMessage('sbx-hammered'), 'sbx-hammered', 3000, start + 30 * 60_000 + i * 5_000);
    }
    reportPortNotAnswering(giveUpMessage('sbx-hammered'), 'sbx-hammered', 3000, start + 41 * 60_000);
    const warns = shippedGiveUpLines().filter((line) => line.channel === 'logger.warn');
    expect(warns.length).toBe(1);
    expect((warns[0]?.args[1] as Record<string, unknown>).suppressed).toBe(11);
  });
});

describe('the escalation shares the hourly warn cap (KRTX-4674)', () => {
  // The severity escalation is evaluated per ten-minute window and is
  // replica-local: a caller grinding past the burst band through a whole hour
  // made every window's line ship at warn. The escalation asks the shared
  // hourly warn budget (logWindowWarnDecision) before it ships warn: the
  // hour's first escalated line stays warn, the second drops to info carrying
  // the suppressed count, and the slot renews after the hour.
  test('first escalated window warns, the second ships info with the suppressed count, the slot renews after the hour', () => {
    const band = DEAD_CREDENTIAL_BURST_SUPPRESSED;
    const start = Date.now();
    // Window 1 opens and fills past the burst band (the first call ships the
    // line, the rest swell the pending count).
    for (let i = 0; i <= band; i += 1) {
      reportPortNotAnswering(giveUpMessage('sbx-cap'), 'sbx-cap', 3000, start + i * 1_000);
    }
    // The hour's first escalated line ships at warn.
    reportPortNotAnswering(giveUpMessage('sbx-cap'), 'sbx-cap', 3000, start + 11 * 60_000);
    // Window 2 fills past the band again, inside the same warn hour.
    for (let i = 0; i < band; i += 1) {
      reportPortNotAnswering(giveUpMessage('sbx-cap'), 'sbx-cap', 3000, start + 11 * 60_000 + 1_000 + i * 1_000);
    }
    // The second escalated window of the hour drops to info, suppressed kept.
    reportPortNotAnswering(giveUpMessage('sbx-cap'), 'sbx-cap', 3000, start + 22 * 60_000);
    // Window 3 fills past the band; past the warn hour the slot renews.
    for (let i = 0; i < band; i += 1) {
      reportPortNotAnswering(giveUpMessage('sbx-cap'), 'sbx-cap', 3000, start + 22 * 60_000 + 1_000 + i * 1_000);
    }
    reportPortNotAnswering(giveUpMessage('sbx-cap'), 'sbx-cap', 3000, start + 73 * 60_000);

    const lines = shippedGiveUpLines();
    expect(lines.map((line) => line.channel)).toEqual(['logger.info', 'logger.warn', 'logger.info', 'logger.warn']);
    expect((lines[1]?.args[1] as Record<string, unknown>).suppressed).toBe(band);
    expect((lines[2]?.args[1] as Record<string, unknown>).suppressed).toBe(band);
  });
});
