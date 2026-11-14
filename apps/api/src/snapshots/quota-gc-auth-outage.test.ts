// KRTX-4792 regression (G9 item on PR #12557, head d46c247): the quota GC's
// org-listing failure never reached the maintenance sweep's `.catch` — the
// pass RESOLVES with `observationStatus: 'org_list_failed'` — so a Daytona
// org listing that answers 401 escalated nothing (`org_list_failed,
// captured: 0`, the reviewer's probe). The fix escalates inside the listing
// catch, where the failure is actually observed.
//
// Run: pnpm --filter kortix-api test src/snapshots/quota-gc-auth-outage.test.ts
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const captured: Array<{ error: unknown; context?: Record<string, unknown> }> = [];
const errorLogs: Array<{ message: string; context?: Record<string, unknown> }> = [];

// Mock before the first import (the ESM cache keeps the original instance
// otherwise) — same pattern as src/apps/remove-app-runtime-auth-outage.test.ts.
mock.module('../lib/sentry', () => ({
  captureException: (error: unknown, context?: Record<string, unknown>) => {
    captured.push({ error, context });
  },
}));
mock.module('../lib/logger', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (message: string, context?: Record<string, unknown>) => {
      errorLogs.push({ message, context });
    },
    localError: () => {},
    localWarn: () => {},
    flush: async (): Promise<void> => {},
  },
  isLoggingTransportError: () => false,
}));

const { reconcileSnapshotQuota } = await import('./quota-gc');
const { __resetProviderAuthOutageForTest } = await import('../shared/provider-auth');

/** The Daytona SDK's real 401 shape: statusCode 401 ("Invalid credentials"). */
function daytona401(): Error {
  return Object.assign(new Error('Invalid credentials'), {
    name: 'DaytonaAuthenticationError',
    statusCode: 401,
  });
}

/** The quota GC's IO with only the listing failing — never touches a real provider. */
function ioWithFailingList(): Parameters<typeof reconcileSnapshotQuota>[1] {
  return {
    isConfigured: () => true,
    listSnapshots: async () => { throw daytona401(); },
    loadReferencedSnapshotNames: async () => new Set<string>(),
    deleteSnapshotById: async () => true,
  };
}

beforeEach(() => {
  captured.length = 0;
  errorLogs.length = 0;
  __resetProviderAuthOutageForTest();
});

describe('reconcileSnapshotQuota auth-outage escalation', () => {
  test('an org-listing 401 degrades the pass AND escalates the outage (the G9 probe)', async () => {
    const result = await reconcileSnapshotQuota({ now: 1_700_000_000_000 }, ioWithFailingList());
    // The documented degradation is unchanged: the pass resolves, deletes nothing.
    expect(result.observationStatus).toBe('org_list_failed');
    expect(result.deleted).toBe(0);
    // The fix: the failure is escalated, not swallowed.
    expect(captured.length).toBe(1);
    const event = captured[0];
    if (!event) throw new Error('expected one captured event');
    const message = event.error instanceof Error ? event.error.message : '';
    expect(message).toContain('[daytona] API rejects every call');
    expect(message).toContain('DAYTONA_API_KEY');
    expect(errorLogs.length).toBe(1);
    const log = errorLogs[0];
    if (!log) throw new Error('expected one error log line');
    expect(log.message).toContain('DAYTONA_API_KEY');
  });

  test('a referenced-name (DB) failure is not a provider auth outage and never escalates', async () => {
    const result = await reconcileSnapshotQuota(
      { now: 1_700_000_000_000 },
      {
        isConfigured: () => true,
        listSnapshots: async () => [],
        loadReferencedSnapshotNames: async () => {
          throw new Error('database unavailable');
        },
        deleteSnapshotById: async () => true,
      },
    );
    expect(result.observationStatus).toBe('referenced_names_failed');
    expect(captured.length).toBe(0);
    expect(errorLogs.length).toBe(0);
  });

  test('a repeated listing 401 inside the 15 min window escalates once', async () => {
    const io = ioWithFailingList();
    await reconcileSnapshotQuota({ now: 1_700_000_000_000 }, io);
    await reconcileSnapshotQuota({ now: 1_700_000_000_000 + 5 * 60_000 }, io);
    expect(captured.length).toBe(1);
  });
});
