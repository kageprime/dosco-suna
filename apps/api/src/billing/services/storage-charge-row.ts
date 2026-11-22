import { storageCharges } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { STORAGE_RATES_USD_PER_GIB_HOUR, type StorageResourceKind } from '../../platform/providers/compute-rates';
import { db } from '../../shared/db';
import type { SettleInput } from '../wallet';
import type { StorageOwner, UnattributedReason } from './storage-owners';

/** A difference below this stays uncharged until it grows past it. */
export const MIN_STORAGE_CHARGE_USD = 0.000001;
/** The charge state of one (feed, kind, resource, day) row. */
export interface StorageChargeState {
  chargedGibHours: number;
  chargeSeq: number;
  pendingGibHours: number | null;
  pendingUsd: number | null;
}

export type StorageChargePlan =
  | { action: 'none' }
  | { action: 'replay'; seq: number; gibHours: number; amountUsd: number }
  | { action: 'charge'; seq: number; gibHours: number; amountUsd: number };

/** USD for `gibHours` of one meter, rounded to the ledger's 10 decimals. */
export function storageChargeUsd(kind: StorageResourceKind, gibHours: number): number {
  return Math.round(gibHours * STORAGE_RATES_USD_PER_GIB_HOUR[kind] * 1e10) / 1e10;
}

/**
 * The next wallet write for a row: a pending charge first (same key, same
 * amount), else the GiB-hours Platinum metered past what was charged. Never a
 * refund: a smaller reading than what was charged charges nothing.
 */
export function planStorageCharge(
  kind: StorageResourceKind,
  state: StorageChargeState,
  meteredGibHours: number,
): StorageChargePlan {
  if (state.pendingGibHours !== null && state.pendingUsd !== null) {
    return { action: 'replay', seq: state.chargeSeq + 1, gibHours: state.pendingGibHours, amountUsd: state.pendingUsd };
  }
  if (!Number.isFinite(meteredGibHours)) return { action: 'none' };
  const amountUsd = storageChargeUsd(kind, meteredGibHours - state.chargedGibHours);
  if (amountUsd < MIN_STORAGE_CHARGE_USD) return { action: 'none' };
  return { action: 'charge', seq: state.chargeSeq + 1, gibHours: meteredGibHours, amountUsd };
}

export function storageChargeKey(feed: string, kind: string, resourceId: string, day: string, seq: number): string {
  return `platinum-storage:${feed}:${kind}:${resourceId}:${day}:${seq}`;
}

export interface StoredRow extends StorageChargeState, StorageOwner {
  id: string;
  resourceKind: StorageResourceKind;
  resourceId: string;
  usageDay: string;
  waived: boolean;
  /** What was metered: the larger of the receipt and the events. */
  gibHours: number;
  eventGibHours: number;
}

/** The deps the charge step needs: shared with box-disk-charges.ts. */
export interface StorageSettleDeps {
  /** Whether the account's storageBilling entitlement is on (and it has a credit account). */
  storageBilled(accountId: string): Promise<boolean>;
  settle(input: SettleInput): Promise<unknown>;
}

/**
 * Charge one row up to `meteredGibHours`. Returns the USD charged, or why
 * nothing was. Shared by the volume feed and the box disk meter.
 */
export async function chargeStorageRow(
  feed: string,
  row: StoredRow,
  meteredGibHours: number,
  deps: StorageSettleDeps,
): Promise<number | 'unattributed' | 'waived' | 'none'> {
  if (!row.accountId) return 'unattributed';
  let state: StorageChargeState = row;
  let charged = 0;
  // At most a replay and one new charge.
  for (let step = 0; step < 2; step++) {
    const plan = planStorageCharge(row.resourceKind, state, meteredGibHours);
    if (plan.action === 'none') break;
    if (plan.action === 'charge') {
      if (!(await deps.storageBilled(row.accountId))) {
        await markWaived(row.id, true);
        return 'waived';
      }
      await markPending(row.id, state.chargeSeq, plan.gibHours, plan.amountUsd);
    }
    const deltaGibHours = plan.gibHours - state.chargedGibHours;
    const unit = row.resourceKind === 'box_disk' || row.resourceKind === 'box_disk_archived' ? 'GB-hours' : 'GiB-hours';
    await deps.settle({
      accountId: row.accountId,
      amount: plan.amountUsd,
      description: `${storageLabel(row)} · ${row.usageDay} · ${deltaGibHours.toFixed(2)} ${unit}`,
      kind: 'storage_debit',
      key: { request: storageChargeKey(feed, row.resourceKind, row.resourceId, row.usageDay, plan.seq) },
      audit: {
        storage_feed: feed,
        storage_resource_kind: row.resourceKind,
        platinum_resource_id: row.resourceId,
        usage_day: row.usageDay,
        gib_hours: deltaGibHours,
        charge_seq: plan.seq,
        project_id: row.projectId,
        session_id: row.sessionId,
        drive_id: row.driveId,
      },
    });
    await finalizeCharge(row.id, plan.seq, plan.gibHours, plan.amountUsd);
    charged += plan.amountUsd;
    state = { chargedGibHours: plan.gibHours, chargeSeq: plan.seq, pendingGibHours: null, pendingUsd: null };
  }
  if (row.waived && charged > 0) await markWaived(row.id, false);
  return charged > 0 ? charged : 'none';
}

function storageLabel(row: Pick<StoredRow, 'resourceKind' | 'driveId' | 'sessionId'>): string {
  if (row.resourceKind === 'box_disk') return 'Stopped computer disk';
  if (row.resourceKind === 'box_disk_archived') return 'Archived computer disk';
  if (row.resourceKind === 'scratch') return 'Scratch disk';
  if (row.driveId) return 'Files storage';
  if (row.sessionId) return 'Workspace storage';
  return 'Storage';
}

export const STORAGE_ROW_COLUMNS = {
  id: storageCharges.id,
  resourceKind: storageCharges.resourceKind,
  resourceId: storageCharges.resourceId,
  usageDay: storageCharges.usageDay,
  accountId: storageCharges.accountId,
  projectId: storageCharges.projectId,
  sessionId: storageCharges.sessionId,
  driveId: storageCharges.driveId,
  volumeName: storageCharges.volumeName,
  unattributedReason: storageCharges.unattributedReason,
  waived: storageCharges.waived,
  gibHours: storageCharges.gibHours,
  eventGibHours: storageCharges.eventGibHours,
  chargedGibHours: storageCharges.chargedGibHours,
  chargeSeq: storageCharges.chargeSeq,
  pendingGibHours: storageCharges.pendingGibHours,
  pendingUsd: storageCharges.pendingUsd,
};
type RawRow = Pick<typeof storageCharges.$inferSelect, keyof typeof STORAGE_ROW_COLUMNS>;

export function toStoredRow(raw: RawRow): StoredRow {
  const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));
  return {
    id: raw.id,
    resourceKind: raw.resourceKind as StorageResourceKind,
    resourceId: raw.resourceId,
    usageDay: raw.usageDay,
    accountId: raw.accountId ?? null,
    projectId: raw.projectId ?? null,
    sessionId: raw.sessionId ?? null,
    driveId: raw.driveId ?? null,
    volumeName: raw.volumeName ?? null,
    unattributedReason: (raw.unattributedReason as UnattributedReason | null) ?? null,
    waived: raw.waived === true,
    gibHours: num(raw.gibHours) ?? 0,
    eventGibHours: num(raw.eventGibHours) ?? 0,
    chargedGibHours: num(raw.chargedGibHours) ?? 0,
    chargeSeq: Number(raw.chargeSeq) || 0,
    pendingGibHours: num(raw.pendingGibHours),
    pendingUsd: num(raw.pendingUsd),
  };
}

async function markPending(id: string, seq: number, gibHours: number, amountUsd: number): Promise<void> {
  const updated = await db
    .update(storageCharges)
    .set({ pendingGibHours: String(gibHours), pendingUsd: String(amountUsd), updatedAt: new Date() })
    .where(and(eq(storageCharges.id, id), eq(storageCharges.chargeSeq, seq), sql`${storageCharges.pendingUsd} is null`))
    .returning({ id: storageCharges.id });
  // Another process moved the row first (a leadership flap): stop, the next tick reads it fresh.
  if (!updated.length) throw new Error('storage charge row changed under this tick');
}

async function finalizeCharge(id: string, seq: number, gibHours: number, amountUsd: number): Promise<void> {
  await db
    .update(storageCharges)
    .set({
      chargedGibHours: String(gibHours),
      chargedUsd: sql`${storageCharges.chargedUsd} + ${String(amountUsd)}::numeric`,
      chargeSeq: seq,
      pendingGibHours: null,
      pendingUsd: null,
      updatedAt: new Date(),
    })
    .where(and(eq(storageCharges.id, id), eq(storageCharges.chargeSeq, seq - 1)));
}

async function markWaived(id: string, waived: boolean): Promise<void> {
  await db.update(storageCharges).set({ waived, updatedAt: new Date() }).where(eq(storageCharges.id, id));
}
