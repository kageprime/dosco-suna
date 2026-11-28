import { platformSettings } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { platinumHomeOrigin, platinumRegionControlPlane } from '../../shared/platinum';
import { platinumUsRegion } from '../../shared/platinum-region';
import { getCreditAccount } from '../repositories/credit-accounts';
import { resolveAccountBilling } from './billing-cache';

const DAY_MS = 86_400_000;
/** One control plane. `origin` undefined is PLATINUM_API_URL. */
export interface StorageFeed {
  name: string;
  origin?: string;
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function dayStartMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

export function addDays(day: string, days: number): string {
  return utcDay(dayStartMs(day) + days * DAY_MS);
}

export async function readPlatformSetting(key: string): Promise<unknown> {
  const [row] = await db
    .select({ value: platformSettings.value })
    .from(platformSettings)
    .where(eq(platformSettings.key, key));
  return row?.value ?? null;
}

export async function writePlatformSetting(key: string, value: Record<string, unknown>): Promise<void> {
  await db
    .insert(platformSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value, updatedAt: new Date() } });
}

/** Kortix's storage charge rule: compute's (compute-metering.ts startComputeSession), then the storageBilling override. */
export async function accountStorageBilled(accountId: string): Promise<boolean> {
  // No credit account, nothing to debit. Recorded as waived, so the day closes.
  if (!(await getCreditAccount(accountId))) return false;
  return (await resolveAccountBilling(accountId)).entitlements.storageBilling !== false;
}

export function storageFeeds(): StorageFeed[] {
    const region = platinumUsRegion();
    const origin = region ? platinumRegionControlPlane(region) : null;
    // A PLATINUM_API_URL that already is the region's control plane reads it as home.
    const away = region && origin && origin !== platinumHomeOrigin() ? [{ name: region, origin }] : [];
    return [{ name: 'home' }, ...away];
}
