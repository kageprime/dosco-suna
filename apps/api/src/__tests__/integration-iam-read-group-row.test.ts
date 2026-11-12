/**
 * Characterization pin for the account fence the one `account_groups` row
 * reader keeps (KRTX-4587). The codebase-analysis pass (unit api-identity)
 * found the fence duplicated once per projection, seven single-row readers of
 * `account_groups`, and the dedupe collapses them into one. The fence must
 * survive the collapse: the account's own group row resolves, a group id of
 * another account does not.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { accountGroups, accounts } from '@kortix/db';
import { db } from '../shared/db';
import { groupRow as readGroupRow } from '../iam/group-read';

const ACCOUNT_A = crypto.randomUUID();
const ACCOUNT_B = crypto.randomUUID();
let groupIdInA = '';

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT_A, name: 'read-model-a' });
  await db.insert(accounts).values({ accountId: ACCOUNT_B, name: 'read-model-b' });
  const [row] = await db
    .insert(accountGroups)
    .values({ accountId: ACCOUNT_A, name: 'group-in-a' })
    .returning();
  groupIdInA = row.groupId;
});

describe('the account-fenced group row reader (KRTX-4587)', () => {
  test("the account's own group resolves to its row", async () => {
    const rows = await readGroupRow(ACCOUNT_A, groupIdInA);
    expect(rows).toHaveLength(1);
    expect((rows[0] as { accountId: string }).accountId).toBe(ACCOUNT_A);
  });

  test('a group id of another account does not resolve', async () => {
    expect(await readGroupRow(ACCOUNT_B, groupIdInA)).toEqual([]);
    expect(await readGroupRow(ACCOUNT_B, crypto.randomUUID())).toEqual([]);
  });
});
