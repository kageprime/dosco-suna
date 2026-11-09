/**
 * The scheduled-account-deletion worker.
 *
 * `processScheduledDeletions()` existed with tests but no caller since the
 * schema moved to `kortix` (KRTX-1260): the only wired processor was the
 * legacy pg_cron job, whose SQL read the pre-baseline `public` copy of
 * `account_deletion_requests`. These tests pin the wiring: start() runs the
 * first tick immediately (the leader drains the backlog it inherits), with
 * billing on or off (self-host deletes accounts too), ticks are serialized and
 * stop() awaits the tick in flight.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const actualConfig = await import('../config');
const { observeWorkerTicks } = await import('../shared/audit-scope');
const ORIGINAL_BILLING_ENABLED = actualConfig.config.KORTIX_BILLING_INTERNAL_ENABLED;

type ProcessorResult = { processed: number; errors: string[] };

let processorCalls = 0;
let processor: () => Promise<ProcessorResult> = async () => ({ processed: 0, errors: [] });

// leaderTimer consults the lease every tick; the test runs a sole leader.
mock.module('../shared/leader-election', () => ({ isLeader: () => true }));

mock.module('../billing/services/account-deletion', () => ({
  processScheduledDeletions: async () => processor(),
}));

const { startAccountDeletionSchedule, stopAccountDeletionSchedule } = await import(
  '../worker/jobs/account-deletion'
);

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

beforeEach(() => {
  processorCalls = 0;
  processor = async () => ({ processed: 0, errors: [] });
  actualConfig.config.KORTIX_BILLING_INTERNAL_ENABLED = true;
});

afterAll(async () => {
  await stopAccountDeletionSchedule();
  actualConfig.config.KORTIX_BILLING_INTERNAL_ENABLED = ORIGINAL_BILLING_ENABLED;
});

describe('startAccountDeletionSchedule', () => {
  test('the started worker executes the due deletions on its first tick', async () => {
    processor = async () => {
      processorCalls += 1;
      return { processed: 3, errors: [] };
    };
    startAccountDeletionSchedule();
    await until(() => processorCalls === 1, 'the first tick');
    await stopAccountDeletionSchedule();
    expect(processorCalls).toBe(1);
  });

  test('a failing tick is contained, not an unhandled rejection', async () => {
    processor = async () => {
      processorCalls += 1;
      throw new Error('db unavailable');
    };
    startAccountDeletionSchedule();
    await until(() => processorCalls === 1, 'the failing first tick');
    await expect(stopAccountDeletionSchedule()).resolves.toBeUndefined();
    await Bun.sleep(50);
    expect(processorCalls).toBe(1);
  });

  // The heartbeat (`worker/runtime/heartbeat.ts`) moves `lastOkAt` only when
  // the tick settles without an error; a tick that throws every time leaves
  // the last success behind so the 2 h StaleJobs alarm can fire for a dead
  // deleter. A catch INSIDE the `runWorkerTick` callback would settle the
  // failing sweep as ok and blind that alarm.
  test('a failing sweep settles the tick as an error, not ok', async () => {
    const settlements: { worker: string; failed: boolean }[] = [];
    observeWorkerTicks(
      (worker) =>
        (error?: unknown) => {
          settlements.push({ worker, failed: error !== undefined });
        },
    );
    processor = async () => {
      processorCalls += 1;
      throw new Error('db unavailable');
    };
    try {
      startAccountDeletionSchedule();
      await until(
        () => settlements.some((s) => s.worker === 'account-deletion'),
        'the failing tick to settle',
      );
    } finally {
      await stopAccountDeletionSchedule();
      observeWorkerTicks(null);
    }
    const ticks = settlements.filter((s) => s.worker === 'account-deletion');
    expect(ticks).toHaveLength(1);
    expect(ticks[0].failed).toBe(true);
  });

  // Self-hosted deployments run with billing off. Their users request
  // deletions through the same routes, and the auth-user-delete trigger
  // schedules orphan accounts there too.
  test('billing disabled still executes the due deletions', async () => {
    actualConfig.config.KORTIX_BILLING_INTERNAL_ENABLED = false;
    processor = async () => {
      processorCalls += 1;
      return { processed: 1, errors: [] };
    };
    startAccountDeletionSchedule();
    await until(() => processorCalls === 1, 'the first tick with billing off');
    await stopAccountDeletionSchedule();
    expect(processorCalls).toBe(1);
  });

  test('stop awaits the tick in flight and no tick fires after stop', async () => {
    let release: () => void = () => {};
    processor = async () => {
      processorCalls += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { processed: 1, errors: [] };
    };
    startAccountDeletionSchedule();
    await until(() => processorCalls === 1, 'the first tick');
    const stopped = stopAccountDeletionSchedule();
    release();
    await stopped;
    await Bun.sleep(50);
    expect(processorCalls).toBe(1);
  });

  test('a second start while running does not double-schedule', async () => {
    processor = async () => {
      processorCalls += 1;
      return { processed: 0, errors: [] };
    };
    startAccountDeletionSchedule();
    startAccountDeletionSchedule();
    await until(() => processorCalls === 1, 'the single first tick');
    await Bun.sleep(50);
    expect(processorCalls).toBe(1);
    await stopAccountDeletionSchedule();
  });
});
