/**
 * Volume storage billing: Platinum meters every volume Kortix creates (a
 * project's Files drive `kd-…`, a session's /workspace volume `kws-<session>`,
 * a box's scratch disk, Kortix's own Workers' storage) on its stored bytes.
 * This tick turns what Platinum metered into a charge in credits on the
 * account that owns the resource, at the Kortix storage rate
 * (STORAGE_RATES_USD_PER_GIB_HOUR, platform/providers/compute-rates.ts).
 *
 * Two sources, one row per (control plane, meter, resource, UTC day):
 *
 * - The events feed (`GET /v1/billing/events?event_type=volume.storage`,
 *   Platinum #2434): one immutable event per resource per UTC day, split at a
 *   resize, a price change or a delete, listed ~2 minutes after its span
 *   closes. Growth Platinum bills back to an ended day arrives as a new event
 *   dated that day. Each event is applied once (its id is kept on the row), and
 *   the feed has no 1,000-volume cap. A cursor per feed in
 *   kortix.platform_settings (`platinum.volume_storage.events.<feed>`) walks it.
 * - The daily receipts (`GET /v1/billing/volume-usage`): the fallback for a
 *   Platinum without the events feed, and for the days before the feed's first
 *   whole day. A day is read once it has ended and stays open for
 *   STORAGE_REVISION_DAYS, because Platinum can add GiB-hours to an ended day.
 *   The cursor `platinum.volume_storage.cursor.<feed>` holds the oldest open day.
 *
 * A row's metered GiB-hours are the larger of its receipt and the sum of its
 * events (the events of a day add up to its receipt), and every charge is the
 * difference between that and what was already charged. So a day read from
 * both sources at the switch-over is charged once, and nothing falls between.
 *
 * Exactly once: each charge has its own sequence number. The row records the
 * charge (pending_*) before the wallet call, the wallet key is
 * `platinum-storage:<feed>:<kind>:<resource>:<day>:<seq>`, and the row is
 * finalized after. A crash between the two replays the same pending amount
 * under the same key, which moves no money twice.
 *
 * Attribution: drive → account and project; `kws-<session_id>` → session →
 * account and project; a scratch disk → the session box. A resource Kortix
 * cannot attribute (another deployment's in the same Platinum org, a deleted
 * owner, a volume Platinum no longer lists, a Worker's storage) is recorded
 * with no account and an `unattributed_reason`: Kortix's own cost, never
 * charged to anyone.
 *
 * Never retroactive: the first tick of a feed starts both sources at its own
 * day. The disk of a stopped or archived box is billed by box-disk-charges.ts
 * into the same table.
 */
import { storageCharges } from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { type StorageResourceKind } from '../../platform/providers/compute-rates';
import { db } from '../../shared/db';
import { platinumJson } from '../../shared/platinum';
import { settleAndCheckAutoTopup } from './wallet-debits';

import { STORAGE_ROW_COLUMNS, type StoredRow, type StorageSettleDeps, chargeStorageRow, toStoredRow } from './storage-charge-row';
import { type PlatinumVolumeUsageResource, type StorageOwner, resolveOwners, rowKey } from './storage-owners';
import { type StorageFeed, accountStorageBilled, addDays, dayStartMs, readPlatformSetting, storageFeeds, utcDay, writePlatformSetting } from './storage-shared';
export * from './storage-charge-row';
export * from './storage-owners';
export * from './storage-shared';

export const STORAGE_CURSOR_KEY = 'platinum.volume_storage.cursor';
/** An ended day is read again on this many later days, for late growth. */
export const STORAGE_REVISION_DAYS = 3;
/** Days a tick reads at most, oldest first: a worker down for weeks catches up over several ticks. */
const MAX_DAYS_PER_TICK = 7;
/** A day that still fails this long after it ended leaves the window (logged): it cannot pin the cursor. */
const MAX_OPEN_DAYS = 14;
/** Platinum's largest page; the endpoint has no cursor (see the truncation log below). */
const USAGE_PAGE_LIMIT = 1000;
/** Volume names looked up per tick; the rest resolve on the next tick. */
const MAX_NAME_LOOKUPS_PER_TICK = 300;

export const STORAGE_EVENTS_KEY = 'platinum.volume_storage.events';
/** The event_type of a volume meter event in GET /v1/billing/events. */
export const VOLUME_STORAGE_EVENT = 'volume.storage';
/** Platinum's largest events page. */
const EVENTS_PAGE_LIMIT = 500;
/** Event pages a tick reads at most; the rest are read on the next tick. */
const MAX_EVENT_PAGES_PER_TICK = 40;

/** One `volume.storage` event of GET /v1/billing/events (Platinum apps/api/src/billingEvents.ts). */
export interface PlatinumStorageEvent {
  id: string;
  cursor?: string;
  sandbox_id?: string | null;
  event_type: string;
  /** The resource kind: volume, volume_snapshot, scratch, worker_storage. */
  size_class: string | null;
  /** GiB-hours. */
  quantity: number;
  unit_price_micros: number;
  amount_micros: number;
  ts: string;
  resource: {
    kind: string;
    id: string;
    name: string | null;
    region: string | null;
    bytes: number;
    started_at: string;
    ended_at: string;
    debited_micros: number;
  } | null;
}

export interface PlatinumEventsPage {
  events: PlatinumStorageEvent[];
  next_cursor: string | null;
}

/** Where the events feed of one control plane stands. */
export interface StorageEventsState {
  /** The cursor after the last event applied; null before the first. */
  cursor: string | null;
  /** The first UTC day charged from events: the day the feed's first tick ran. */
  since: string;
  /** The first UTC day the feed covers in full: receipts are read only before it. Null until an event is seen. */
  fullFrom: string | null;
}

export interface PlatinumVolumeUsagePage {
  total_gib_hours: number;
  total_metered_micros: number;
  resources: PlatinumVolumeUsageResource[];
}

/** A meter of Platinum's volume feed. The box disk kinds are Kortix's own meter, never read from Platinum. */
export function isStorageResourceKind(kind: unknown): kind is StorageResourceKind {
  return kind === 'volume' || kind === 'volume_snapshot' || kind === 'scratch' || kind === 'worker_storage';
}

/** The ended days a tick reads: from the cursor through yesterday, oldest first, at most MAX_DAYS_PER_TICK. */
export function storageDaysToRead(cursor: string, today: string): string[] {
  const floor = addDays(today, -MAX_OPEN_DAYS);
  const days: string[] = [];
  for (let day = cursor < floor ? floor : cursor; day < today && days.length < MAX_DAYS_PER_TICK; day = addDays(day, 1)) {
    days.push(day);
  }
  return days;
}

/**
 * The cursor after a tick: the oldest day that is still open. A day stays open
 * while it is within STORAGE_REVISION_DAYS of today, failed this tick, or was
 * not read this tick.
 */
export function nextStorageCursor(cursor: string, today: string, read: string[], failed: ReadonlySet<string>): string {
  const revisionFloor = addDays(today, -STORAGE_REVISION_DAYS);
  const oldestFailed = read.find((day) => failed.has(day));
  const unread = read.length ? addDays(read[read.length - 1] as string, 1) : cursor;
  const candidates = [revisionFloor, unread, ...(oldestFailed ? [oldestFailed] : [])];
  const next = candidates.reduce((min, day) => (day < min ? day : min));
  // Never back past where it was, and never older than the open-day floor.
  const floor = addDays(today, -MAX_OPEN_DAYS);
  if (next < cursor) return cursor < floor ? floor : cursor;
  return next < floor ? floor : next;
}

export interface StorageChargeDeps extends StorageSettleDeps {
  feeds(): StorageFeed[];
  /** One UTC day of Platinum's volume receipts, or null when this Platinum has no volume meter (404). */
  usage(feed: StorageFeed, day: string): Promise<PlatinumVolumeUsagePage | null>;
  /** One page of `volume.storage` events after `cursor`, or null when this Platinum has no events feed (404). */
  storageEvents(feed: StorageFeed, cursor: string | null): Promise<PlatinumEventsPage | null>;
  /** A volume's name by id, or null when Platinum no longer lists it (404). */
  volumeName(feed: StorageFeed, volumeId: string): Promise<string | null>;
  readCursor(key: string): Promise<string | null>;
  writeCursor(key: string, day: string): Promise<void>;
  readEventsState(key: string): Promise<StorageEventsState | null>;
  writeEventsState(key: string, state: StorageEventsState): Promise<void>;
  now(): number;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function notFound(error: unknown): boolean {
  return error instanceof Error && (error as { status?: unknown }).status === 404;
}

export const storageChargeDeps: StorageChargeDeps = {
  feeds: storageFeeds,
  async usage(feed, day) {
    const start = dayStartMs(day);
    const query = new URLSearchParams({ since_ms: String(start), until_ms: String(start), limit: String(USAGE_PAGE_LIMIT) });
    try {
      return await platinumJson<PlatinumVolumeUsagePage>(`/v1/billing/volume-usage?${query}`, {}, feed.origin);
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  },
  async storageEvents(feed, cursor) {
    const query = new URLSearchParams({ event_type: VOLUME_STORAGE_EVENT, limit: String(EVENTS_PAGE_LIMIT) });
    if (cursor) query.set('cursor', cursor);
    try {
      return await platinumJson<PlatinumEventsPage>(`/v1/billing/events?${query}`, {}, feed.origin);
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  },
  async volumeName(feed, volumeId) {
    try {
      const volume = await platinumJson<{ name?: unknown }>(`/v1/volumes/${encodeURIComponent(volumeId)}`, {}, feed.origin);
      return typeof volume.name === 'string' && volume.name ? volume.name : null;
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  },
  async readCursor(key) {
    const day = ((await readPlatformSetting(key)) as { day?: unknown } | null)?.day;
    return typeof day === 'string' && DAY_PATTERN.test(day) ? day : null;
  },
  async writeCursor(key, day) {
    await writePlatformSetting(key, { day });
  },
  async readEventsState(key) {
    const value = (await readPlatformSetting(key)) as Record<string, unknown> | null;
    if (!value || typeof value.since !== 'string' || !DAY_PATTERN.test(value.since)) return null;
    return {
      cursor: typeof value.cursor === 'string' && value.cursor ? value.cursor : null,
      since: value.since,
      fullFrom: typeof value.fullFrom === 'string' && DAY_PATTERN.test(value.fullFrom) ? value.fullFrom : null,
    };
  },
  async writeEventsState(key, state) {
    await writePlatformSetting(key, { ...state });
  },
  storageBilled: accountStorageBilled,
  settle: settleAndCheckAutoTopup,
  now: () => Date.now(),
};

export interface StorageChargeResult {
  days: number;
  /** volume.storage events applied this tick. */
  events: number;
  charged: number;
  chargedUsd: number;
  unattributed: number;
  waived: number;
  failed: number;
}

// replica-local: feeds this process already logged as missing (404); a peer logs its own once.
const missingFeedLogged = new Set<string>();

/** Charge everything Platinum's volume meter settled since the last tick. */
export async function syncStorageCharges(deps: StorageChargeDeps = storageChargeDeps): Promise<StorageChargeResult> {
  const total: StorageChargeResult = { days: 0, events: 0, charged: 0, chargedUsd: 0, unattributed: 0, waived: 0, failed: 0 };
  const lookups = { left: MAX_NAME_LOOKUPS_PER_TICK };
  for (const feed of deps.feeds()) {
    try {
      // Events first: they decide which days the receipts still cover.
      const fullFrom = await syncEventFeed(feed, deps, total, lookups);
      await syncFeed(feed, deps, total, lookups, fullFrom);
    } catch (error) {
      logger.error('[storage-billing] charge sync failed; the next tick retries', {
        feed: feed.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return total;
}

/**
 * Apply the feed's new `volume.storage` events and charge the rows they grow.
 * Returns the first day the events cover in full, or null when this feed has
 * listed no event yet (the receipts then cover every day).
 */
async function syncEventFeed(
  feed: StorageFeed,
  deps: StorageChargeDeps,
  total: StorageChargeResult,
  lookups: { left: number },
): Promise<string | null> {
  const key = `${STORAGE_EVENTS_KEY}.${feed.name}`;
  const today = utcDay(deps.now());
  let state = await deps.readEventsState(key);
  if (!state) {
    // Never retroactive: the first day charged from events is the one this tick runs on.
    state = { cursor: null, since: today, fullFrom: null };
    await deps.writeEventsState(key, state);
  }
  for (let page = 0; page < MAX_EVENT_PAGES_PER_TICK; page++) {
    const body = await deps.storageEvents(feed, state.cursor);
    if (!body) return state.fullFrom; // This Platinum has no events feed.
    const events = Array.isArray(body.events) ? body.events : [];
    if (!events.length) break;
    if (!state.fullFrom) {
      // The feed starts mid-day at the earliest (Platinum began writing events at a
      // deploy): its first day is partial, the next is whole.
      const first = events.map(eventDay).filter((d): d is string => !!d).sort()[0];
      if (first) state = { ...state, fullFrom: addDays(first, 1) };
    }
    const ok = await applyEvents(feed, events, state.since, deps, total, lookups);
    // A failed event holds the cursor: the next tick reads the page again, and the
    // events already applied are skipped by their ids.
    if (!ok) break;
    const last = events[events.length - 1];
    state = { ...state, cursor: body.next_cursor ?? last?.cursor ?? state.cursor };
    await deps.writeEventsState(key, state);
    if (!body.next_cursor) break;
  }
  await deps.writeEventsState(key, state);
  return state.fullFrom;
}

function eventDay(event: PlatinumStorageEvent): string | null {
  const started = Date.parse(event?.resource?.started_at ?? '');
  return Number.isFinite(started) ? utcDay(started) : null;
}

interface UsableEvent {
  event: PlatinumStorageEvent;
  kind: StorageResourceKind;
  resourceId: string;
  day: string;
  gibHours: number;
  micros: number;
}

/** Apply one page of events. Returns false when any must be retried. */
async function applyEvents(
  feed: StorageFeed,
  events: PlatinumStorageEvent[],
  since: string,
  deps: StorageChargeDeps,
  total: StorageChargeResult,
  lookups: { left: number },
): Promise<boolean> {
  const usable: UsableEvent[] = [];
  for (const event of events) {
    const kind = event?.size_class ?? event?.resource?.kind;
    const day = eventDay(event);
    if (
      event?.event_type !== VOLUME_STORAGE_EVENT ||
      typeof event.id !== 'string' ||
      !event.id ||
      typeof event.resource?.id !== 'string' ||
      !event.resource.id ||
      !isStorageResourceKind(kind) ||
      !day
    ) {
      logger.error('[storage-billing] malformed volume.storage event skipped', { feed: feed.name, event });
      continue;
    }
    // Before this feed's first tick: never charged.
    if (day < since) continue;
    usable.push({
      event,
      kind,
      resourceId: event.resource.id,
      day,
      gibHours: Math.max(Number(event.quantity) || 0, 0),
      micros: Math.max(Math.round(Number(event.amount_micros) || 0), 0),
    });
  }
  if (!usable.length) return true;

  const existing = await loadRows(feed.name, usable.map((u) => ({ kind: u.kind, resourceId: u.resourceId, day: u.day })));
  // A resource's owner is the same on every day: resolve it once, by the name the event carries.
  const unowned = new Map<string, PlatinumVolumeUsageResource>();
  const known = new Map<string, string | null>();
  for (const u of usable) {
    if (existing.has(dayRowKey(u.kind, u.resourceId, u.day))) continue;
    unowned.set(rowKey({ resource_kind: u.kind, resource_id: u.resourceId }), {
      resource_kind: u.kind,
      resource_id: u.resourceId,
      gib_hours: 0,
      metered_micros: 0,
    });
    if (u.event.resource?.name) known.set(u.resourceId, u.event.resource.name);
  }
  const owners = await resolveOwners(feed, deps, [...unowned.values()], lookups, known);

  let ok = true;
  for (const u of usable) {
    try {
      const owner =
        existing.get(dayRowKey(u.kind, u.resourceId, u.day)) ?? owners.get(rowKey({ resource_kind: u.kind, resource_id: u.resourceId }));
      if (!owner) {
        ok = false; // Name lookups ran out this tick: the next tick resolves it.
        continue;
      }
      const row = await applyEvent(feed.name, u, owner);
      total.events += 1;
      tally(total, await chargeStorageRow(feed.name, row, row.gibHours, deps));
    } catch (error) {
      ok = false;
      total.failed += 1;
      logger.error('[storage-billing] event charge failed; the next tick retries it with the same key', {
        feed: feed.name,
        eventId: u.event.id,
        resourceKind: u.kind,
        resourceId: u.resourceId,
        day: u.day,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return ok;
}

function tally(total: StorageChargeResult, outcome: number | 'unattributed' | 'waived' | 'none'): void {
  if (outcome === 'unattributed') total.unattributed += 1;
  else if (outcome === 'waived') total.waived += 1;
  else if (typeof outcome === 'number') {
    total.charged += 1;
    total.chargedUsd += outcome;
  }
}

async function syncFeed(
  feed: StorageFeed,
  deps: StorageChargeDeps,
  total: StorageChargeResult,
  lookups: { left: number },
  fullFrom: string | null,
): Promise<void> {
  const key = `${STORAGE_CURSOR_KEY}.${feed.name}`;
  const today = utcDay(deps.now());
  const cursor = await deps.readCursor(key);
  if (!cursor) {
    // Never retroactive: the first day charged is the one this tick runs on.
    await deps.writeCursor(key, today);
    return;
  }
  // The events cover every day from fullFrom on: receipts only before it.
  const days = storageDaysToRead(cursor, today).filter((day) => !fullFrom || day < fullFrom);
  if (!days.length) return;
  const failed = new Set<string>();
  const read: string[] = [];
  for (const day of days) {
    const page = await deps.usage(feed, day);
    if (!page) {
      if (!missingFeedLogged.has(feed.name)) {
        missingFeedLogged.add(feed.name);
        logger.warn('[storage-billing] this Platinum has no volume meter (404); no storage is charged', { feed: feed.name });
      }
      return;
    }
    read.push(day);
    total.days += 1;
    const ok = await chargeDay(feed, day, page, deps, total, lookups);
    if (!ok) failed.add(day);
  }
  const next = nextStorageCursor(cursor, today, read, failed);
  if (next !== cursor) await deps.writeCursor(key, next);
}

/** Charge one day of one feed's receipts. Returns false when any resource must be retried. */
async function chargeDay(
  feed: StorageFeed,
  day: string,
  page: PlatinumVolumeUsagePage,
  deps: StorageChargeDeps,
  total: StorageChargeResult,
  lookups: { left: number },
): Promise<boolean> {
  const resources = (Array.isArray(page.resources) ? page.resources : []).filter((r) => {
    if (typeof r?.resource_id === 'string' && r.resource_id && isStorageResourceKind(r.resource_kind)) return true;
    logger.error('[storage-billing] malformed volume receipt skipped', { feed: feed.name, day, resource: r });
    return false;
  });
  if (resources.length >= USAGE_PAGE_LIMIT) {
    // GET /v1/billing/volume-usage has no cursor: past 1,000 resources a day the
    // smallest receipts are not listed. Recorded as Kortix's own cost here.
    const listed = resources.reduce((sum, r) => sum + (Number(r.gib_hours) || 0), 0);
    logger.error('[storage-billing] Platinum listed only the largest volumes of the day; the rest are not charged', {
      feed: feed.name,
      day,
      listed: resources.length,
      unlistedGibHours: Math.max(0, (Number(page.total_gib_hours) || 0) - listed),
    });
  }
  const existing = await loadRows(feed.name, resources.map((r) => ({ kind: r.resource_kind, resourceId: r.resource_id, day })));
  const owners = await resolveOwners(
    feed,
    deps,
    resources.filter((r) => !existing.has(dayRowKey(r.resource_kind, r.resource_id, day))),
    lookups,
  );
  let ok = true;
  for (const resource of resources) {
    const kind = resource.resource_kind as StorageResourceKind;
    const gibHours = Math.max(Number(resource.gib_hours) || 0, 0);
    const micros = Math.max(Math.round(Number(resource.metered_micros) || 0), 0);
    let row = existing.get(dayRowKey(kind, resource.resource_id, day)) ?? null;
    try {
      if (!row) {
        const owner = owners.get(rowKey(resource));
        if (!owner) {
          ok = false; // Name lookups ran out this tick: the next tick resolves it.
          continue;
        }
        row = await insertRow(feed.name, day, kind, resource.resource_id, owner, gibHours, micros);
      } else {
        row = await recordReading(row, gibHours, micros);
      }
      // The receipt and the events measure the same GiB-hours: charge up to the larger.
      tally(total, await chargeStorageRow(feed.name, row, Math.max(gibHours, row.eventGibHours), deps));
    } catch (error) {
      ok = false;
      total.failed += 1;
      logger.error('[storage-billing] charge failed; the next tick retries it with the same key', {
        feed: feed.name,
        day,
        resourceKind: kind,
        resourceId: resource.resource_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return ok;
}

function dayRowKey(kind: string, resourceId: string, day: string): string {
  return `${kind}:${resourceId}:${day}`;
}

/** The rows of these (kind, resource, day) keys that exist, by dayRowKey. */
async function loadRows(feed: string, keys: Array<{ kind: string; resourceId: string; day: string }>): Promise<Map<string, StoredRow>> {
  const rows = new Map<string, StoredRow>();
  if (!keys.length) return rows;
  const found = await db
    .select(STORAGE_ROW_COLUMNS)
    .from(storageCharges)
    .where(
      and(
        eq(storageCharges.feed, feed),
        inArray(storageCharges.resourceId, [...new Set(keys.map((k) => k.resourceId))]),
        inArray(storageCharges.usageDay, [...new Set(keys.map((k) => k.day))]),
      ),
    );
  const wanted = new Set(keys.map((k) => dayRowKey(k.kind, k.resourceId, k.day)));
  for (const raw of found) {
    const row = toStoredRow(raw);
    const key = dayRowKey(row.resourceKind, row.resourceId, row.usageDay);
    if (wanted.has(key)) rows.set(key, row);
  }
  return rows;
}

async function insertRow(
  feed: string,
  day: string,
  kind: StorageResourceKind,
  resourceId: string,
  owner: StorageOwner,
  gibHours: number,
  micros: number,
): Promise<StoredRow> {
  const [raw] = await db
    .insert(storageCharges)
    .values({
      feed,
      resourceKind: kind,
      resourceId,
      usageDay: day,
      accountId: owner.accountId,
      projectId: owner.projectId,
      sessionId: owner.sessionId,
      driveId: owner.driveId,
      volumeName: owner.volumeName,
      unattributedReason: owner.accountId ? null : (owner.unattributedReason ?? 'owner_gone'),
      gibHours: String(gibHours),
      platinumMicros: micros,
    })
    .onConflictDoUpdate({
      target: [storageCharges.feed, storageCharges.resourceKind, storageCharges.resourceId, storageCharges.usageDay],
      set: {
        gibHours: sql`greatest(${String(gibHours)}::numeric, ${storageCharges.eventGibHours})`,
        platinumMicros: sql`greatest(${micros}::bigint, ${storageCharges.platinumMicros})`,
        updatedAt: new Date(),
      },
    })
    .returning(STORAGE_ROW_COLUMNS);
  if (!raw) throw new Error('storage charge row was not written');
  return toStoredRow(raw);
}

/** Record a receipt's reading on its row: the metered GiB-hours become the larger of the receipt and the events. */
async function recordReading(row: StoredRow, gibHours: number, micros: number): Promise<StoredRow> {
  const metered = Math.max(gibHours, row.eventGibHours);
  if (metered === row.gibHours) return row;
  await db
    .update(storageCharges)
    .set({
      gibHours: sql`greatest(${String(gibHours)}::numeric, ${storageCharges.eventGibHours})`,
      platinumMicros: sql`greatest(${micros}::bigint, ${storageCharges.platinumMicros})`,
      updatedAt: new Date(),
    })
    .where(eq(storageCharges.id, row.id));
  return { ...row, gibHours: metered };
}

/**
 * Add one event to its row, once: the event id is kept on the row, and an id
 * already there adds nothing. Returns the row as it stands after.
 */
async function applyEvent(feed: string, u: UsableEvent, owner: StorageOwner): Promise<StoredRow> {
  const [raw] = await db
    .insert(storageCharges)
    .values({
      feed,
      resourceKind: u.kind,
      resourceId: u.resourceId,
      usageDay: u.day,
      accountId: owner.accountId,
      projectId: owner.projectId,
      sessionId: owner.sessionId,
      driveId: owner.driveId,
      volumeName: owner.volumeName,
      unattributedReason: owner.accountId ? null : (owner.unattributedReason ?? 'owner_gone'),
      gibHours: String(u.gibHours),
      eventGibHours: String(u.gibHours),
      eventIds: [u.event.id],
      platinumMicros: u.micros,
    })
    .onConflictDoUpdate({
      target: [storageCharges.feed, storageCharges.resourceKind, storageCharges.resourceId, storageCharges.usageDay],
      set: {
        eventGibHours: sql`${storageCharges.eventGibHours} + excluded.event_gib_hours`,
        eventIds: sql`${storageCharges.eventIds} || excluded.event_ids`,
        gibHours: sql`greatest(${storageCharges.gibHours}, ${storageCharges.eventGibHours} + excluded.event_gib_hours)`,
        platinumMicros: sql`${storageCharges.platinumMicros} + excluded.platinum_micros`,
        updatedAt: new Date(),
      },
      setWhere: sql`not (${u.event.id} = any(${storageCharges.eventIds}))`,
    })
    .returning(STORAGE_ROW_COLUMNS);
  if (raw) return toStoredRow(raw);
  // Applied before (a replayed page): the row as it is, for a pending charge to finish.
  const [current] = await db
    .select(STORAGE_ROW_COLUMNS)
    .from(storageCharges)
    .where(
      and(
        eq(storageCharges.feed, feed),
        eq(storageCharges.resourceKind, u.kind),
        eq(storageCharges.resourceId, u.resourceId),
        eq(storageCharges.usageDay, u.day),
      ),
    );
  if (!current) throw new Error('storage charge row was not written');
  return toStoredRow(current);
}
