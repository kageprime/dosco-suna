// Behavior pin for `trigger-scheduler`: the old hand-rolled scheduler swept at
// startup at once (`tick()` then a fixed-cadence loop), and the `Job` wiring guard
// pins the start call in `unit-worker-scope-wiring.test.ts`. This file pins the
// sweep itself: the first tick runs immediately on `start()`, not after a full
// interval.
import { describe, expect, mock, test } from 'bun:test';

let intervalMs = 200;
let sweeps = 0;
mock.module('../../config', () => ({ config: { KORTIX_TRIGGER_SCHEDULER_ENABLED: true } }));
mock.module('../../lib/logger', () => ({ logger: { info() {}, warn() {}, error() {} } }));
mock.module('../../shared/leader-election', () => ({ isLeader: () => true }));
mock.module('../../shared/audit-scope', () => ({
  runWorkerTick: async (_name: string, fn: () => Promise<void>) => fn(),
}));
mock.module('../../projects/lib/trigger-scheduler', () => ({
  runProjectTriggerSchedulerTick: async () => {
    sweeps += 1;
  },
}));
mock.module('../../projects/lib/trigger-scheduler-state', () => ({
  schedulerSweepIsStale: () => false,
  triggerSchedulerIntervalMs: () => intervalMs,
}));
const { startProjectTriggerScheduler, stopProjectTriggerScheduler } = await import('./trigger-scheduler');

describe('trigger-scheduler', () => {
  test('start() sweeps immediately, before the first interval elapses', async () => {
    startProjectTriggerScheduler();
    await Bun.sleep(10); // 191 ms of the 200 ms interval still remain
    expect(sweeps).toBeGreaterThanOrEqual(1);
    stopProjectTriggerScheduler();
  });

  test('stop() ends the chain', async () => {
    startProjectTriggerScheduler();
    await Bun.sleep(5);
    await stopProjectTriggerScheduler();
    const seen = sweeps;
    await Bun.sleep(intervalMs + 50);
    expect(sweeps).toBe(seen);
  });
});
