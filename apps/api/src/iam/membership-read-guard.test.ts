/**
 * Characterization pin for the malformed-account-id guard on the member probe
 * (KRTX-4587). A slug, a truncated id or a stray path segment in a uuid-typed
 * predicate dies as SQLSTATE 22P02 → an opaque 500 (Better Stack pattern
 * 97669531, KRTX-211). The read-model dedupe moved the guard onto the one
 * full-row member reader. It must answer no row with zero DB reads for a
 * malformed account id, and reach the DB for a well-formed one.
 */
import { describe, expect, mock, test } from 'bun:test';

let reads = 0;
mock.module('../shared/db', () => ({
  db: {
    select: () => {
      reads += 1;
      return {
        from: () => ({
          where: () => ({
            limit: async () => [{ accountId: 'stub-member-row' } as unknown],
          }),
        }),
      };
    },
  },
}));

const USER = '00000000-0000-4000-a000-000000000001';

// Imported after the mock so the reader binds to the mocked db: the
// guard-owning reader (KRTX-4587).
const { accountMemberRow: readGuardedMemberRow } = (await import(
  '../iam/membership-read'
)) as typeof import('../iam/membership-read');

describe('the guarded member row reader (KRTX-4587)', () => {
  test('a malformed account id answers no row without a DB read', async () => {
    reads = 0;
    const rows = await readGuardedMemberRow('not-a-uuid', USER);
    expect(rows).toEqual([]);
    expect(reads).toBe(0);
  });

  test('a well-formed account id reaches the database', async () => {
    reads = 0;
    const rows = await readGuardedMemberRow(crypto.randomUUID(), USER);
    expect(rows[0]?.accountId).toBe('stub-member-row');
    expect(reads).toBe(1);
  });
});
