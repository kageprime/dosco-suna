// `/v1/ops/overview` sums 24 h of token columns across every account. Each
// `usage_events` token column is int4, so `sum()` is bigint: the aggregate must
// stay bigint. Casting it to `::int` made Postgres throw `integer out of range`
// once the all-account total passed 2,147,483,647 (KRTX-4862).
import { describe, expect, test } from 'bun:test';
import { usageEvents } from '@kortix/db';

const confirmed = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === 'I_UNDERSTAND_THIS_DELETES_TEST_DATA' &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const withDb = confirmed ? describe : describe.skip;

const { db } = await import('../shared/db');
const { seedAccount } = await import('../__tests__/helpers/integration-fixtures');
const { usageLast24h } = await import('./index');

// Each value fits int4 on its own; three of them do not.
const ROW_TOKENS = 1_000_000_000;

withDb('ops overview usage aggregate', () => {
  test('sums past int4 without Postgres raising integer out of range', async () => {
    const accountId = await seedAccount('ops-usage-overflow');
    const rows = [1, 2, 3].map(() => ({
      accountId,
      provider: 'kortix',
      model: 'kortix/test',
      route: 'chat',
      inputTokens: ROW_TOKENS,
      outputTokens: ROW_TOKENS,
      cachedTokens: ROW_TOKENS,
    }));
    await db.insert(usageEvents).values(rows);

    const usage = await usageLast24h();

    expect(usage).toEqual([
      {
        provider: 'kortix',
        calls: 3,
        input_tokens: 3 * ROW_TOKENS,
        output_tokens: 3 * ROW_TOKENS,
        cached_tokens: 3 * ROW_TOKENS,
        cost_usd: 0,
      },
    ]);
  });
});
