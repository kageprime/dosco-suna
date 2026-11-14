import { describe, expect, mock, test } from 'bun:test';
import { DrizzleQueryError } from 'drizzle-orm/errors';

// The aggregation under test: one invariant's throw — a statement timeout
// (57014) on a prod-sized expand table such as credit_ledger — must mark its
// slot errored and let the remaining checks run, so
// `scripts/workspace-invariants.ts` exits 1 with a report instead of dying as
// an unhandled rejection. The mock keys on the SQL text; the queries
// themselves are proven against real PostgreSQL by
// workspaces.integration.test.ts.
const sqlText = (query: unknown): string => {
  const chunks = (query as { queryChunks?: Array<{ value?: string[] }> }).queryChunks ?? [];
  return chunks.map((chunk) => (chunk.value ?? []).join('')).join('');
};

const executed: string[] = [];

/** The exact shape prod throws: drizzle's pg session wraps the driver's 57014
 * in a DrizzleQueryError whose own message is the whole statement plus its
 * params — the wrapper hides the timeout. */
const drizzleTimeout = (query: unknown): DrizzleQueryError => {
  const timeout = new Error('canceling statement due to statement timeout') as Error & { code: string };
  timeout.code = '57014';
  return new DrizzleQueryError(sqlText(query), ['0.5'], timeout);
};

mock.module('../../shared/db', () => ({
  db: {
    execute: async (query: unknown) => {
      executed.push(sqlText(query));
      // The one done run: i2, i3, i5, i7 and i8 loop over it.
      if (sqlText(query).includes("workspace_split_runs WHERE phase = 'done'")) {
        return [{
          run_id: 'run-1',
          project_id: 'p-1',
          from_account_id: 'a-1',
          to_account_id: 'a-2',
          completed_at: '2026-11-12T00:00:00Z',
          plan: {},
          copied_ids: { undecryptableSecrets: [], groups: {}, memberships: [] },
        }];
      }
      // I2's per-table violation counts are the shape prod timed out on during
      // the 2026-11-12 burst.
      if (sqlText(query).includes('account_id <> ')) {
        throw drizzleTimeout(query);
      }
      // I10's per-table violation count is the shape prod timed out on
      // (i10 compares names, not workspace ids).
      if (sqlText(query).includes('workspace_id IS DISTINCT FROM')) {
        throw drizzleTimeout(query);
      }
      if (sqlText(query).includes('workspace_expand_tables')) return [{ name: 'credit_ledger' }];
      return [];
    },
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({}),
  },
}));
mock.module('../../secrets/account-resource', () => ({ probeAccountSecret: () => 'ok' }));
mock.module('../../projects/surface', () => ({
  PROJECT_TRANSFER_TABLES: [] as Array<Record<string, unknown>>,
  projectGrantCounts: async () => ({}),
  reachingUsersSql: () => 'true',
}));

const { checkSplitRunsMoved, checkWorkspaceInvariants } = await import('./invariants');

describe('checkWorkspaceInvariants degradation', () => {
  test('a timing-out invariant marks its slot errored; the rest of the report still runs', async () => {
    const report = await checkWorkspaceInvariants();
    expect(Object.keys(report).sort()).toEqual([
      'I1',
      'I10',
      'I11',
      'I12',
      'I2',
      'I3',
      'I4',
      'I5',
      'I6',
      'I7',
      'I8',
      'I9',
    ]);
    expect(report.I10).toMatchObject({ ok: false, violations: 0, sample: [] });
    // The driver's cause with its SQLSTATE reaches the report; the wrapper's
    // SQL-and-params message never does.
    expect(report.I10.error).toContain('canceling statement due to statement timeout');
    expect(report.I10.error).toContain('57014');
    expect(report.I10.error).not.toContain('Failed query');
    expect(report.I10.error).not.toContain('params:');
    expect(report.I10.error).not.toContain('SELECT');
    // The run continued past the throwing check: I11 and I12 executed after it.
    expect(executed.some((query) => query.includes('stripe_subscription_id'))).toBe(true);
    expect(report.I11.ok).toBe(true);
    expect(report.I12.ok).toBe(true);
  });

  test('checkSplitRunsMoved degrades the same way: the repair pass must not die on a timed-out I2', async () => {
    // The split runner's repair pass calls this inside the leader tick; a
    // throw here failed the whole tick on 2026-11-12 and left the run's
    // repaired_at recorded without its I2 result. It must return the errored
    // shape instead — the same degradation the full report applies per check.
    const result = await checkSplitRunsMoved(['run-1']);
    expect(result).toMatchObject({ ok: false, violations: 0, sample: [] });
    expect(result.error).toContain('57014');
    expect(result.error).toContain('canceling statement due to statement timeout');
    expect(result.error).not.toContain('Failed query');
    expect(result.error).not.toContain('params:');
  });
});
