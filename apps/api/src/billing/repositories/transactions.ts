import { eq, desc, sql, and, gte, inArray, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { creditLedger, creditUsage, creditPurchases } from '@kortix/db';
import { db } from '../../shared/db';

// Reads only. Every credit_ledger write goes through billing/wallet.

/**
 * The most rows a pagination count may scan. `SELECT count(*) WHERE
 * account_id = $1` reads the account's whole ledger slice on every page view,
 * and for a heavy account the planner turns it into a parallel seq scan of the
 * whole table (KRTX-3175, measured 2026-11-10: a 1M-row account counted
 * through a full-table scan). Bounded at 10k the count is a
 * single-digit-millisecond index read. `total` stays exact below the cap; at
 * or above it, `total` reports the cap and pagination stops there — the
 * manual 50-row pager never pages that deep.
 */
export const COUNT_SCAN_CAP = 10_000;

/** `min(exact total, COUNT_SCAN_CAP)`: counts at most COUNT_SCAN_CAP rows of
 * `table` under `where`, stopping at the cap instead of scanning the account's
 * whole slice. */
async function boundedCount(table: PgTable, where: SQL): Promise<number> {
  const bounded = db
    .$with('counted_rows')
    .as(db.select({ one: sql`1` }).from(table).where(where).limit(COUNT_SCAN_CAP));
  const [countResult] = await db
    .with(bounded)
    .select({ count: sql<number>`count(*)` })
    .from(bounded);
  return Number(countResult?.count ?? 0);
}

export async function getTransactions(
  accountId: string,
  limit: number,
  offset: number,
  typeFilter?: string | string[],
) {
  const conditions = [eq(creditLedger.accountId, accountId)];

  const typeFilters = Array.isArray(typeFilter)
    ? typeFilter.filter(Boolean)
    : typeFilter
      ? [typeFilter]
      : [];

  if (typeFilters.length === 1) {
    conditions.push(eq(creditLedger.type, typeFilters[0]!));
  } else if (typeFilters.length > 1) {
    conditions.push(inArray(creditLedger.type, typeFilters));
  }

  const where = conditions.length === 1 ? conditions[0] : and(...conditions)!;

  const rows = await db
    .select()
    .from(creditLedger)
    .where(where)
    .orderBy(desc(creditLedger.createdAt))
    .limit(limit)
    .offset(offset);

  return { rows, total: await boundedCount(creditLedger, where) };
}

export async function getTransactionsSummary(accountId: string, days: number) {
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const [result] = await db
    .select({
      totalCredits: sql<string>`coalesce(sum(case when amount > 0 then amount else 0 end), 0)`,
      totalDebits: sql<string>`coalesce(sum(case when amount < 0 then abs(amount) else 0 end), 0)`,
      count: sql<number>`count(*)`,
    })
    .from(creditLedger)
    .where(and(eq(creditLedger.accountId, accountId), gte(creditLedger.createdAt, since)));

  return {
    totalCredits: Number(result?.totalCredits ?? 0),
    totalDebits: Number(result?.totalDebits ?? 0),
    count: Number(result?.count ?? 0),
  };
}

export async function getUsageRecords(
  accountId: string,
  limit: number,
  offset: number,
) {
  const accountFilter = eq(creditUsage.accountId, accountId);
  const rows = await db
    .select()
    .from(creditUsage)
    .where(accountFilter)
    .orderBy(desc(creditUsage.createdAt))
    .limit(limit)
    .offset(offset);

  return { rows, total: await boundedCount(creditUsage, accountFilter) };
}

export async function insertPurchase(data: typeof creditPurchases.$inferInsert) {
  const [row] = await db.insert(creditPurchases).values(data).returning();
  return row;
}

export async function updatePurchaseStatus(
  id: string,
  status: string,
  completedAt?: string,
) {
  await db
    .update(creditPurchases)
    .set({ status, completedAt: completedAt ?? null })
    .where(eq(creditPurchases.id, id));
}

export async function getPurchaseByPaymentIntent(stripePaymentIntentId: string) {
  const [row] = await db
    .select()
    .from(creditPurchases)
    .where(eq(creditPurchases.stripePaymentIntentId, stripePaymentIntentId))
    .limit(1);

  return row ?? null;
}
