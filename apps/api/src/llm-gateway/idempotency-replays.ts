import { gatewayIdempotencyReplays } from '@kortix/db';
import { eq, gt, lt, and, count, inArray, sql } from 'drizzle-orm';
import { z } from '@hono/zod-openapi';
import { db } from '../shared/db';

/**
 * The gateway's Idempotency-Key replay, shared across its replicas (KRTX-4612).
 * `key` is the gateway's sha256 over credential + operation + client key + body.
 * The gateway keeps the same one-hour TTL for its own copy.
 */
const TTL_MS = 60 * 60 * 1000;
/** Matches the gateway's cap on what it shares, with room for header bytes. */
const MAX_BODY_CHARS = 2 * 1024 * 1024;

export const ReplayKeySchema = z.string().regex(/^[0-9a-f]{64}$/);
export const ReplayAnswerSchema = z.object({
  status: z.number().int().min(200).max(299),
  statusText: z.string().max(200),
  headers: z.array(z.tuple([z.string().max(200), z.string().max(8192)])).max(100),
  body: z.string().max(MAX_BODY_CHARS),
});
export type ReplayAnswer = z.infer<typeof ReplayAnswerSchema>;

export async function getReplay(key: string): Promise<(ReplayAnswer & { expiresAt: number }) | null> {
  const [row] = await db
    .select({
      status: gatewayIdempotencyReplays.status,
      statusText: gatewayIdempotencyReplays.statusText,
      headers: gatewayIdempotencyReplays.headers,
      body: gatewayIdempotencyReplays.body,
      expiresAt: gatewayIdempotencyReplays.expiresAt,
    })
    .from(gatewayIdempotencyReplays)
    .where(and(eq(gatewayIdempotencyReplays.keyHash, key), gt(gatewayIdempotencyReplays.expiresAt, new Date())))
    .limit(1);
  return row ? { ...row, expiresAt: row.expiresAt.getTime() } : null;
}

/** Past this many live rows an answer stays replica-local: the table is shared by every tenant. */
const MAX_LIVE_ROWS = 10_000;
/** Serializes admission: without it concurrent writers all see the same count and all insert. */
const ADMISSION_LOCK = 4612_0001;
/** Expired rows deleted per statement, so a backlog is swept in bounded batches. */
const SWEEP_BATCH = 1000;

/** First writer wins: a retry that raced the first answer keeps the answer clients already saw. */
export async function putReplay(key: string, answer: ReplayAnswer, now = new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADMISSION_LOCK})`);
    // An expired row of this very key blocks its insert (primary key), so it goes first.
    await tx
      .delete(gatewayIdempotencyReplays)
      .where(and(eq(gatewayIdempotencyReplays.keyHash, key), lt(gatewayIdempotencyReplays.expiresAt, now)));
    const [live] = await tx
      .select({ n: count() })
      .from(gatewayIdempotencyReplays)
      .where(gt(gatewayIdempotencyReplays.expiresAt, now));
    if ((live?.n ?? 0) >= MAX_LIVE_ROWS) return;
    await tx
      .insert(gatewayIdempotencyReplays)
      .values({ keyHash: key, ...answer, expiresAt: new Date(now.getTime() + TTL_MS) })
      .onConflictDoNothing();
  });
}

/** Deletes every expired row, one bounded batch at a time. Returns how many went. */
export async function sweepExpiredReplays(now = new Date()): Promise<number> {
  let total = 0;
  for (;;) {
    const batch = db
      .select({ keyHash: gatewayIdempotencyReplays.keyHash })
      .from(gatewayIdempotencyReplays)
      .where(lt(gatewayIdempotencyReplays.expiresAt, now))
      .limit(SWEEP_BATCH);
    const gone = await db
      .delete(gatewayIdempotencyReplays)
      .where(inArray(gatewayIdempotencyReplays.keyHash, batch))
      .returning({ keyHash: gatewayIdempotencyReplays.keyHash });
    total += gone.length;
    if (gone.length < SWEEP_BATCH) return total;
  }
}
