import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  type ActiveTurnRenewalDependencies,
  activeTurnRenewalIntervalMs,
  runActiveTurnRenewal,
} from './active-turn-renewal';
import { startActiveTurnRenewal, stopActiveTurnRenewal } from '../worker/jobs/active-turn-renewal';
import type { ReapResult } from './sandbox-reaper';

// leaderTimer consults the lease every tick; the test runs a sole leader.
mock.module('../shared/leader-election', () => ({ isLeader: () => true }));

function reapResult(overrides: Partial<ReapResult> = {}): ReapResult {
  return {
    candidates: 0,
    matching: 0,
    deferred: 0,
    stopped: 0,
    reconciled: 0,
    billingClosed: 0,
    skipped: 0,
    lifecycleRenewed: 0,
    husksFinalized: 0,
    turnsSettled: 0,
    errors: 0,
    transient: 0,
    ...overrides,
  };
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(async () => {
  await stopActiveTurnRenewal();
});

describe('active-turn lifecycle renewal loop', () => {
  test('runs faster than the one-minute provider lifecycle test timeout', () => {
    expect(activeTurnRenewalIntervalMs({})).toBe(20_000);
    expect(
      activeTurnRenewalIntervalMs({
        KORTIX_ACTIVE_TURN_RENEWAL_INTERVAL_MS: '60000',
      }),
    ).toBe(30_000);
    expect(
      activeTurnRenewalIntervalMs({
        KORTIX_ACTIVE_TURN_RENEWAL_INTERVAL_MS: '1000',
      }),
    ).toBe(5_000);
  });

  test('reaps only rows with durable active-turn authority', async () => {
    const calls: unknown[][] = [];
    const result = await runActiveTurnRenewal({
      reap: async (...args: unknown[]) => {
        calls.push(args);
        return reapResult({ candidates: 1, matching: 1, skipped: 1, lifecycleRenewed: 1 });
      },
      now: () => new Date('2026-08-17T06:00:00.000Z'),
    });

    expect(result.lifecycleRenewed).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toEqual(new Date('2026-08-17T06:00:00.000Z'));
    expect(calls[0]?.[2]).toEqual({ activeTurnsOnly: true });
  });

  test('start schedules serial passes and stop ends the chain', async () => {
    let runs = 0;
    startActiveTurnRenewal({
      reap: async () => {
        runs += 1;
        return reapResult();
      },
      intervalMs: () => 60_000,
    });
    startActiveTurnRenewal({
      reap: async () => {
        runs += 1;
        return reapResult();
      },
      intervalMs: () => 60_000,
    });
    await flushAsync();

    expect(runs).toBe(1);

    await stopActiveTurnRenewal();
    await Bun.sleep(30);
    expect(runs).toBe(1);
  });

  test('a slow pass subtracts its runtime from the next delay', async () => {
    let runs = 0;
    const clock = [0, 25];

    startActiveTurnRenewal({
      reap: async () => {
        runs += 1;
        return reapResult();
      },
      intervalMs: () => 40,
      monotonicNowMs: () => clock.shift() ?? 25,
    });
    await flushAsync();
    expect(runs).toBe(1);
    // A 25 ms pass over a 40 ms interval returns the next delay: 15 ms. A
    // full-interval re-arm would fire the second pass at ~40 ms, after this
    // window, so the count pins the subtraction.
    await Bun.sleep(30);
    expect(runs).toBe(2);
    await stopActiveTurnRenewal();
  });

  test('an in-flight pass re-arms nothing after stop and restart', async () => {
    let finishOldPass: (() => void) | undefined;
    const oldPass = new Promise<void>((resolve) => {
      finishOldPass = resolve;
    });
    let oldRuns = 0;
    let newRuns = 0;

    startActiveTurnRenewal({
      reap: async () => {
        oldRuns += 1;
        await oldPass;
        return reapResult();
      },
      intervalMs: () => 20,
    });
    await flushAsync();
    expect(oldRuns).toBe(1);

    const stopping = stopActiveTurnRenewal();
    startActiveTurnRenewal({
      reap: async () => {
        newRuns += 1;
        return reapResult();
      },
      intervalMs: () => 60_000,
    });
    await flushAsync();
    expect(newRuns).toBe(1);

    finishOldPass?.();
    await stopping;
    await Bun.sleep(30);
    expect(oldRuns).toBe(1);
    expect(newRuns).toBe(1);
  });

  test('the explicit disable flag starts no pass', async () => {
    let runs = 0;
    startActiveTurnRenewal(
      {
        reap: async () => {
          runs += 1;
          return reapResult();
        },
      },
      { KORTIX_ACTIVE_TURN_RENEWAL_ENABLED: 'false' },
    );
    await flushAsync();
    expect(runs).toBe(0);
  });
});
