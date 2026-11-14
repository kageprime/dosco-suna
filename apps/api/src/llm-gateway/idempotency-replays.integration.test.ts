import { beforeEach, describe, expect, test } from 'bun:test';
import { gatewayIdempotencyReplays } from '@kortix/db';
import { sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { getReplay, putReplay, sweepExpiredReplays } from './idempotency-replays';

const key = 'cd'.repeat(32);
const answer = { status: 200, statusText: 'OK', headers: [['content-type', 'application/json']] as [string, string][], body: '{"id":"cmpl-1"}' };

describe('gateway Idempotency-Key replay on PostgreSQL (KRTX-4612)', () => {
  beforeEach(async () => {
    if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required');
    await db.execute(sql`DELETE FROM kortix.gateway_idempotency_replays`);
  });

  test('a stored answer is read back byte for byte; the first writer wins', async () => {
    expect(await getReplay(key)).toBeNull();
    await putReplay(key, answer);
    await putReplay(key, { ...answer, body: '{"id":"cmpl-2"}' });
    expect(await getReplay(key)).toEqual({ ...answer, expiresAt: expect.any(Number) });
  });

  test('an expired answer is not served, and the next write replaces it', async () => {
    await putReplay(key, answer, new Date(Date.now() - 2 * 60 * 60 * 1000));
    expect(await getReplay(key)).toBeNull();
    await putReplay(key, { ...answer, body: '{"id":"cmpl-3"}' });
    expect(await getReplay(key)).toEqual({ ...answer, body: '{"id":"cmpl-3"}', expiresAt: expect.any(Number) });
  });

  const fill = (n: number, expires: string) => db.execute(sql`
    INSERT INTO kortix.gateway_idempotency_replays (key_hash, status, status_text, headers, body, expires_at)
    SELECT md5(i::text) || md5((i + 1)::text), 200, 'OK', '[]'::jsonb, '{}', ${expires}::timestamptz
    FROM generate_series(1, ${n}) AS i`);
  const rows = async () => (await db.select({ k: gatewayIdempotencyReplays.keyHash }).from(gatewayIdempotencyReplays)).length;

  test('the sweep deletes every expired row, across batches, and keeps live ones', async () => {
    await fill(2500, '2000-01-01T00:00:00Z');
    await putReplay(key, answer);
    expect(await sweepExpiredReplays()).toBe(2500);
    expect(await rows()).toBe(1);
    expect(await getReplay(key)).toEqual({ ...answer, expiresAt: expect.any(Number) });
  });

  test('concurrent writers at the ceiling never exceed it', async () => {
    await fill(9_990, '2999-01-01T00:00:00Z');
    await Promise.all(Array.from({ length: 30 }, (_, i) => putReplay(i.toString(16).padStart(64, '0'), answer)));
    expect(await rows()).toBe(10_000);
  });

  test('past the live-row ceiling the answer is not stored', async () => {
    await fill(10_000, '2999-01-01T00:00:00Z');
    await putReplay(key, answer);
    expect(await getReplay(key)).toBeNull();
    expect(await rows()).toBe(10_000);
  });
});
