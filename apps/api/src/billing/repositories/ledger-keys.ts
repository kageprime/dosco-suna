import { creditLedger } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../../shared/db';

/** Did a wallet write under this request key commit? Answers an ambiguous failure (a lost response). */
export async function ledgerRequestKeyExists(requestKey: string): Promise<boolean> {
  const [row] = await db
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(eq(creditLedger.idempotencyKey, requestKey))
    .limit(1);
  return Boolean(row);
}

/** The amount (USD) of the ledger row a Stripe-event-keyed grant wrote, or 0 when none did. */
export async function ledgerEventAmount(stripeEventId: string): Promise<number> {
  const [row] = await db
    .select({ amount: creditLedger.amount })
    .from(creditLedger)
    .where(eq(creditLedger.stripeEventId, stripeEventId))
    .limit(1);
  return row ? Number(row.amount) : 0;
}
