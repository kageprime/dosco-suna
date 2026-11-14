import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { sessionSandboxes } from '@kortix/db';
import * as realComputeMetering from '../../billing/services/compute-metering';
import { renderSql } from './test-support/render-sql';
import { mockConfigModule } from './test-support/mock-config';

/**
 * Characterization of the metadata SQL this sweep writes (KRTX-4468). The
 * sweep hand-writes every strip+merge; the refactor adopts the canonical
 * helpers. Whatever the source looks like after, the writes must keep:
 *   - the heal write clearing EXACTLY the three loss keys;
 *   - the verified and stop/settle writes stripping EXACTLY
 *     `providerStopPendingAt` (and never an object replace, which would
 *     erase a sibling a concurrent writer added);
 *   - every write stamping `parkedVerifiedAt` from the PASS clock, and the
 *     batch stamp strip-less (merge-only: it races nothing).
 */
type UpdateCall = { table: unknown; set: Record<string, unknown>; predicate: unknown };

let selectedRows: Array<Record<string, unknown>> = [];
let transactionRows: Array<Record<string, unknown>> = [];
let updates: UpdateCall[] = [];
let stopped: string[] = [];
let computeEnds: string[] = [];

mock.module('../../config', () => mockConfigModule({ ALLOWED_SANDBOX_PROVIDERS: ['platinum'] }));
mock.module('../../platform/providers', () => ({
  getProvider: (_provider: string) => ({
    getStatus: async (externalId: string) => statuses[externalId] ?? 'unknown',
    stop: async (externalId: string) => {
      stopped.push(externalId);
    },
    recoverInPlace: undefined,
  }),
}));

const statuses: Record<string, string> = {};

mock.module('../../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => selectedRows,
          }),
        }),
      }),
    }),
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn({
        select: () => ({
          from: () => ({
            where: () => ({
              for: () => ({
                limit: async () => transactionRows,
              }),
            }),
          }),
        }),
        update: updater,
      }),
    update: updater,
  },
}));

function updater(table: unknown) {
  return {
    set: (set: Record<string, unknown>) => ({
      where: (predicate?: unknown) => {
        updates.push({ table, set, predicate });
        return Promise.resolve([]);
      },
    }),
  };
}

mock.module('../../billing/services/compute-metering', () => ({
  ...realComputeMetering,
  endComputeSession: async (sandboxId: string) => {
    computeEnds.push(sandboxId);
  },
}));
mock.module('../runtime-identity', () => ({
  MAX_IN_PLACE_RECOVERY_ATTEMPTS: 3,
  inPlaceRecoveryAttempts: () => 0,
  claimInPlaceRuntimeRecovery: async () => null,
  isKortixInitiatedRemoval: () => false,
  markInPlaceRuntimeRecoveryAccepted: async () => null,
  preserveEstablishedRuntime: async (row: unknown) => row,
}));
mock.module('../session-lifecycle/runtime-wake-fence', () => ({
  runtimeWakeInProgress: () => false,
}));
mock.module('../../lib/logger', () => ({ logger: { warn: () => {}, info: () => {} } }));

const { verifyParkedRuntimes } = await import('./parked-runtime-verification');

const NOW = new Date('2026-09-24T12:00:00.000Z');

function baseRow(metadata: Record<string, unknown>): Record<string, unknown> {
  return {
    sandboxId: 'sb_char_1',
    sessionId: 'ses_char_1',
    externalId: 'ext_char_1',
    provider: 'platinum',
    status: 'stopped',
    metadata,
  };
}

/** Every `- 'key'` in the rendered metadata expression, in order. */
function strippedKeys(rendered: string): string[] {
  return [...rendered.matchAll(/- '([A-Za-z][A-Za-z0-9_]*)'/g)].map((match) => match[1]);
}

function renderMetadata(call: UpdateCall): string {
  return renderSql(call.set.metadata).replace(/\s+/g, ' ');
}

/** The pass's own write, not the loop's batch stamp (which strips nothing). */
function loopWrites(): UpdateCall[] {
  return updates.filter((call) => renderMetadata(call).includes("- '"));
}

beforeEach(() => {
  selectedRows = [];
  transactionRows = [];
  updates = [];
  stopped = [];
  computeEnds = [];
  for (const key of Object.keys(statuses)) delete statuses[key];
});

describe('parked-runtime metadata writes (characterization)', () => {
  test('heal-restored clears exactly the three loss keys and stamps the pass clock', async () => {
    selectedRows = [
      baseRow({
        runtimeIdentityState: 'unavailable',
        runtimeUnavailableReason: 'provider_removed',
        runtimeUnavailableAt: '2026-09-20T00:00:00.000Z',
        lastAliveAt: '111',
      }),
    ];
    statuses.ext_char_1 = 'stopped'; // PRESENT_AND_SETTLED → heal

    await verifyParkedRuntimes(NOW);

    expect(loopWrites().length).toBe(1);
    const rendered = renderMetadata(loopWrites()[0]!);
    expect(strippedKeys(rendered)).toEqual([
      'runtimeIdentityState',
      'runtimeUnavailableReason',
      'runtimeUnavailableAt',
    ]);
    // The merged delta is exactly the two stamps, both on the pass clock. The
    // pre-refactor write stamped `runtimeRestoredAt` from `new Date()` at
    // write time (the drift KRTX-4468 strikes healMetadataPatch for); the
    // refactor folds both stamps onto the pass clock, pinned below.
    const merged = JSON.parse(/\{\s*"[\s\S]*\}/.exec(rendered)![0]) as Record<string, string>;
    expect(Object.keys(merged)).toEqual(['runtimeRestoredAt', 'parkedVerifiedAt']);
    expect(merged.parkedVerifiedAt).toBe(NOW.toISOString());
    expect(merged.runtimeRestoredAt).toBe(NOW.toISOString());
    // The strip+merge shape keeps every sibling: the base is `coalesce`,
    // not a whole-object reset, and the merged delta rides `||`.
    expect(rendered).toContain('coalesce(');
    expect(rendered).toContain(' || ');
  });

  test.each([
    ['stop-pending', 'running', true],
    ['settle-stop-pending', 'stopped', false],
  ])('%s strips exactly providerStopPendingAt and keeps the siblings', async (
    _action,
    providerStatus,
    providerStop,
  ) => {
    const pendingAt = NOW.toISOString();
    selectedRows = [
      baseRow({
        providerStopPendingAt: pendingAt,
        lastAliveAt: '222',
        pendingStopObservedAtMs: '5',
      }),
    ];
    statuses.ext_char_1 = providerStatus;
    transactionRows = [{ sandboxId: 'sb_char_1' }];

    await verifyParkedRuntimes(NOW);

    expect(loopWrites().length).toBe(1);
    const rendered = renderMetadata(loopWrites()[0]!);
    expect(strippedKeys(rendered)).toEqual(['providerStopPendingAt']);
    expect(rendered).toContain(`"parkedVerifiedAt":"${NOW.toISOString()}"`);
    expect(rendered).toContain('coalesce(');
    expect(rendered).toContain(' || ');
    expect(computeEnds).toEqual(['sb_char_1']);
    expect(stopped).toEqual(providerStop ? ['ext_char_1'] : []);
  });

  test('verified stamps only and strips exactly providerStopPendingAt', async () => {
    selectedRows = [baseRow({ lastAliveAt: '333' })];
    statuses.ext_char_1 = 'stopped';

    await verifyParkedRuntimes(NOW);

    expect(loopWrites().length).toBe(1);
    const rendered = renderMetadata(loopWrites()[0]!);
    expect(strippedKeys(rendered)).toEqual(['providerStopPendingAt']);
    expect(rendered).toContain(`"parkedVerifiedAt":"${NOW.toISOString()}"`);
  });

  test('the batch stamp is merge-only: it strips nothing', async () => {
    selectedRows = [
      baseRow({ lastAliveAt: '444' }),
      baseRow({ providerStopPendingAt: NOW.toISOString() }),
    ];
    statuses.ext_char_1 = 'stopped';
    statuses.ext_char_2 = 'stopped';

    await verifyParkedRuntimes(NOW);

    const stamps = updates.filter((call) => !renderMetadata(call).includes("- '"));
    expect(stamps.length).toBe(1);
    const rendered = renderMetadata(stamps[0]!);
    expect(strippedKeys(rendered)).toEqual([]);
    expect(rendered).toContain(`"parkedVerifiedAt":"${NOW.toISOString()}"`);
  });
});
