import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PgClient } from '../__tests__/helpers/pg-client';

const databaseUrl = process.env.TEST_DATABASE_URL;

let client: PgClient | null = null;

/**
 * `/v1/ops/overview` reads `kortix.usage_events` for the last 24 hours across
 * every account (`WHERE created_at >= now() - interval '24 hours'`). Every
 * other index on the table leads with account_id, project_id, session_id or
 * provider, so only an index that LEADS with created_at lets that read skip a
 * full scan of the billing ledger (KRTX-4862: the scan outlived the 25 s
 * request deadline in prod).
 */
describe.skipIf(!databaseUrl)('usage_events — ops overview time-range index', () => {
  beforeAll(async () => {
    client = new PgClient({ connectionString: databaseUrl });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
  });

  test('a valid index on usage_events leads with created_at', async () => {
    const result = await client!.query<{ indexname: string }>(
      `SELECT c.relname AS indexname
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
        WHERE i.indrelid = 'kortix.usage_events'::regclass
          AND i.indisvalid
          AND i.indpred IS NULL
          AND a.attname = 'created_at'`,
    );
    expect(result.rows.map((row) => row.indexname)).toEqual(['idx_usage_events_created_at']);
  });
});
