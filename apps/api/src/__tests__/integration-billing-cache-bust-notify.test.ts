/**
 * Integration test (real local PostgreSQL): a plan change clears the billing
 * cache on every replica. The cache is replica-local with a 30 s TTL, and dev
 * runs two API replicas behind round robin. After a checkout,
 * `sync-subscription` moved the plan on one replica, and the model list read
 * right after it could reach the other one: that replica still served the Free
 * plan, so the composer showed "No model" (audit finding F-004). Replica A
 * calls `invalidateAccountBilling`; replica B (a second LISTEN client standing
 * in for it) must hear it, and a bust announced by B must drop this replica's
 * cached entry.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import postgres from 'postgres';
import { config } from '../config';
import { BILLING_BUST_CHANNEL, startConfigBaseMoveBroadcast, stopConfigBaseMoveBroadcast } from '../shared/pg-broadcast';
import { invalidateAccountBilling, resolveAccountBilling } from '../billing/services/billing-cache';

let otherReplica: postgres.Sql;
const heard: string[] = [];

beforeAll(async () => {
  otherReplica = postgres(config.DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });
  await otherReplica.listen(BILLING_BUST_CHANNEL, (payload) => heard.push(payload));
  expect(await startConfigBaseMoveBroadcast()).toBe(true);
});

afterAll(async () => {
  await stopConfigBaseMoveBroadcast();
  await otherReplica.end({ timeout: 2 }).catch(() => {});
});

/** Wait for a NOTIFY round trip: until `done()` holds, at most 2 s. */
async function until(done: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100 && !(await done()); i += 1) await Bun.sleep(20);
}

test('a plan change on this replica announces the bust to the other replica', async () => {
  const accountId = crypto.randomUUID();
  invalidateAccountBilling(accountId);
  await until(() => heard.includes(accountId));
  expect(heard).toContain(accountId);
});

test('a bust announced by the other replica drops this replica’s entry for that account only', async () => {
  const accountId = crypto.randomUUID();
  const otherAccount = crypto.randomUUID();
  const cached = await resolveAccountBilling(accountId, { row: null });
  const otherCached = await resolveAccountBilling(otherAccount, { row: null });

  await otherReplica.notify(BILLING_BUST_CHANNEL, accountId);
  await until(async () => (await resolveAccountBilling(accountId)) !== cached);

  expect(await resolveAccountBilling(accountId)).not.toBe(cached);
  expect(await resolveAccountBilling(otherAccount)).toBe(otherCached);
});

test('a payload that is not an account id is ignored', async () => {
  const accountId = crypto.randomUUID();
  const cached = await resolveAccountBilling(accountId, { row: null });
  await otherReplica.notify(BILLING_BUST_CHANNEL, 'not-a-uuid');
  // A valid bust sent after it marks that the invalid one was delivered first.
  const marker = crypto.randomUUID();
  await otherReplica.notify(BILLING_BUST_CHANNEL, marker);
  await until(() => heard.includes(marker));
  expect(await resolveAccountBilling(accountId)).toBe(cached);
});
