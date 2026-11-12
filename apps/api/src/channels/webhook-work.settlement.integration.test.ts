/**
 * The settlement half of `runWebhookWork` on a REAL claim row: a fast failure
 * whose claim release blocks on a held row lock (the DB blip the release code
 * guards) must hold an `awaitSettlement` caller (the redelivery job) until the
 * delete finished and the failure hook ran — the hook's `claimsReleased` is
 * the redelivery's TTL-hold decision, and a resolved job is never retried.
 *
 * Runs in the db-suites lane (real Postgres; a held `reserve()` row lock, not
 * a mock, parks the DELETE).
 */
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { chatEventDedup } from '@kortix/db';
import { config } from '../config';
import { db } from '../shared/db';
import { recordClaim, runWebhookWork } from './webhook-work';

const EVENT_ID = 'slack:event:settlement-hold';

describe('runWebhookWork settlement on a live claim row', () => {
  test('awaitSettlement resolves only after the blocked claim delete finished', async () => {
    // The claim row the replay's work would hold: what `releaseClaims` deletes.
    await db
      .insert(chatEventDedup)
      .values({ eventId: EVENT_ID, expiresAt: new Date(Date.now() + 600_000) });

    // Park the release: a dedicated postgres.js client (the integration-suite
    // pattern, src/shared/__tests__/integration-pg-broadcast.test.ts) holds
    // the row lock inside an open transaction, so the work's DELETE blocks on
    // the DB exactly like a contended remove does.
    const locker = postgres(config.DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });
    await locker`begin`;
    await locker`select 1 from kortix.chat_event_dedup where event_id = ${EVENT_ID} for update`;

    const hookCalls: Array<{ acked: boolean; claimsReleased: boolean }> = [];
    const settled = runWebhookWork(
      'slack-event-redelivery',
      async () => {
        recordClaim(EVENT_ID);
        throw new Error('replay work failed');
      },
      { ackWaitMs: 250, awaitSettlement: true, onFailure: (info) => void hookCalls.push({ ...info }) },
    );

    // The timer fired and the outcome is already 'failed' — the settlement
    // wait holds the caller while the delete waits on the row lock.
    await Bun.sleep(500);
    let resolvedAfterTimer = false;
    void settled.then(() => (resolvedAfterTimer = true));
    await Bun.sleep(10);
    expect(resolvedAfterTimer).toBe(false);

    // Free the lock: the delete finishes, the hook runs, THEN the call
    // resolves — the redeliver reads the hook's `claimsReleased` intact.
    await locker`commit`;
    await locker.end({ timeout: 2 });
    const outcome = await settled;
    expect(outcome).toBe('failed');
    expect(hookCalls).toEqual([{ acked: true, claimsReleased: true }]);

    const left = await db.select().from(chatEventDedup).where(eq(chatEventDedup.eventId, EVENT_ID));
    expect(left).toHaveLength(0);
  });
});
