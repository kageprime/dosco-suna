import { drives, projectSessions, sessionSandboxes } from '@kortix/db';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import type { StorageFeed } from './storage-shared';

export interface PlatinumVolumeUsageResource {
  resource_kind: string;
  resource_id: string;
  gib_hours: number;
  metered_micros: number;
}

export type UnattributedReason = 'not_kortix' | 'volume_gone' | 'owner_gone' | 'unsupported_kind';

export interface StorageOwner {
  accountId: string | null;
  projectId: string | null;
  sessionId: string | null;
  driveId: string | null;
  volumeName: string | null;
  unattributedReason: UnattributedReason | null;
}

const DRIVE_VOLUME = /^kd-[0-9a-f]{20}$/;
const WORKSPACE_VOLUME = /^kws-(.+)$/;

/** What a volume name says about its owner: a Files drive, a session's /workspace, or neither. */
export function classifyVolumeName(name: string): { kind: 'drive' } | { kind: 'workspace'; sessionId: string } | { kind: 'other' } {
  if (DRIVE_VOLUME.test(name)) return { kind: 'drive' };
  const workspace = WORKSPACE_VOLUME.exec(name);
  if (workspace?.[1]) return { kind: 'workspace', sessionId: workspace[1] };
  return { kind: 'other' };
}

export function rowKey(resource: { resource_kind: string; resource_id: string }): string {
  return `${resource.resource_kind}:${resource.resource_id}`;
}

const UNATTRIBUTED = (reason: UnattributedReason, volumeName: string | null = null): StorageOwner => ({
  accountId: null,
  projectId: null,
  sessionId: null,
  driveId: null,
  volumeName,
  unattributedReason: reason,
});

/**
 * The owner of every resource that has no row for this day yet: first the
 * owner its row of an earlier day recorded, then the database by volume id,
 * then Platinum's name for the volume. A resource missing from the map waits
 * for the next tick (the per-tick name lookups ran out).
 */
export async function resolveOwners(
  feed: StorageFeed,
  deps: { volumeName(feed: StorageFeed, volumeId: string): Promise<string | null> },
  resources: PlatinumVolumeUsageResource[],
  lookups: { left: number },
  /** Volume names the caller already has (an event carries its volume's name): no Platinum lookup for these. */
  known: ReadonlyMap<string, string | null> = new Map(),
): Promise<Map<string, StorageOwner>> {
  const owners = new Map<string, StorageOwner>();
  if (!resources.length) return owners;

  await resolveFromEarlierRows(feed, resources, owners);
  const pending = resources.filter((r) => !owners.has(rowKey(r)));

  // Legacy volume snapshots, and Kortix's own Workers' storage: Kortix's cost.
  for (const r of pending.filter((r) => r.resource_kind === 'volume_snapshot' || r.resource_kind === 'worker_storage')) {
    owners.set(rowKey(r), UNATTRIBUTED('unsupported_kind', known.get(r.resource_id) ?? null));
  }

  await resolveScratchOwners(pending, owners);
  await resolveVolumeOwners(feed, deps, lookups, known, pending, owners);
  return owners;
}

async function resolveFromEarlierRows(
  feed: StorageFeed,
  resources: PlatinumVolumeUsageResource[],
  owners: Map<string, StorageOwner>,
): Promise<void> {
  // 1. An earlier day's row: one lookup per volume for its whole life.
  const earlier = await db.execute(sql`
    SELECT DISTINCT ON (resource_kind, resource_id)
           resource_kind, resource_id, account_id, project_id, session_id, drive_id, volume_name, unattributed_reason
      FROM kortix.storage_charges
     WHERE feed = ${feed.name} AND resource_id = ANY(${sql.param(resources.map((r) => r.resource_id))}::text[])
     ORDER BY resource_kind, resource_id, usage_day DESC`);
  for (const r of earlier as unknown as Array<Record<string, string | null>>) {
    // A deleted account or project was set null on the earlier row: the volume is now unattributed.
    owners.set(rowKey({ resource_kind: r.resource_kind as string, resource_id: r.resource_id as string }), {
      accountId: r.account_id ?? null,
      projectId: r.project_id ?? null,
      sessionId: r.session_id ?? null,
      driveId: r.drive_id ?? null,
      volumeName: r.volume_name ?? null,
      unattributedReason: r.account_id ? null : ((r.unattributed_reason as UnattributedReason | null) ?? 'owner_gone'),
    });
  }
}

async function resolveScratchOwners(pending: PlatinumVolumeUsageResource[], owners: Map<string, StorageOwner>): Promise<void> {
  // 2. Scratch disks: the resource id is the box's Platinum id.
  const scratch = pending.filter((r) => r.resource_kind === 'scratch');
  if (scratch.length) {
    const boxes = await db
      .select({ externalId: sessionSandboxes.externalId, accountId: sessionSandboxes.accountId, projectId: sessionSandboxes.projectId, sessionId: sessionSandboxes.sessionId })
      .from(sessionSandboxes)
      .where(and(eq(sessionSandboxes.provider, 'platinum'), inArray(sessionSandboxes.externalId, scratch.map((r) => r.resource_id))));
    const byId = new Map(boxes.map((b) => [b.externalId, b]));
    for (const r of scratch) {
      const box = byId.get(r.resource_id);
      owners.set(
        rowKey(r),
        box
          ? { accountId: box.accountId, projectId: box.projectId ?? null, sessionId: box.sessionId, driveId: null, volumeName: null, unattributedReason: null }
          : UNATTRIBUTED('not_kortix'),
      );
    }
  }
}

async function resolveVolumeOwners(
  feed: StorageFeed,
  deps: { volumeName(feed: StorageFeed, volumeId: string): Promise<string | null> },
  lookups: { left: number },
  known: ReadonlyMap<string, string | null>,
  pending: PlatinumVolumeUsageResource[],
  owners: Map<string, StorageOwner>,
): Promise<void> {
  // 3. Volumes: a drive that recorded the volume id, else Platinum's name.
  const volumes = pending.filter((r) => r.resource_kind === 'volume');
  if (!volumes.length) return;
  const byVolumeId = await db
    .select({ driveId: drives.driveId, accountId: drives.accountId, projectId: drives.projectId, volumeId: drives.platinumVolumeId, name: drives.platinumVolumeName })
    .from(drives)
    .where(inArray(drives.platinumVolumeId, volumes.map((r) => r.resource_id)));
  const driveById = new Map(byVolumeId.map((d) => [d.volumeId, d]));
  const named: Array<{ resource: PlatinumVolumeUsageResource; name: string }> = [];
  for (const r of volumes) {
    const drive = driveById.get(r.resource_id);
    if (drive) {
      owners.set(rowKey(r), { accountId: drive.accountId, projectId: drive.projectId ?? null, sessionId: null, driveId: drive.driveId, volumeName: drive.name, unattributedReason: null });
      continue;
    }
    let name = known.get(r.resource_id) ?? null;
    if (!name) {
      if (lookups.left <= 0) continue;
      lookups.left -= 1;
      name = await deps.volumeName(feed, r.resource_id);
    }
    if (!name) owners.set(rowKey(r), UNATTRIBUTED('volume_gone'));
    else named.push({ resource: r, name });
  }
  if (!named.length) return;

  const driveNames = named.filter((n) => classifyVolumeName(n.name).kind === 'drive').map((n) => n.name);
  const driveRows = driveNames.length
    ? await db
        .select({ driveId: drives.driveId, accountId: drives.accountId, projectId: drives.projectId, name: drives.platinumVolumeName, move: drives.platinumVolumeMove })
        .from(drives)
        .where(or(inArray(drives.platinumVolumeName, driveNames), inArray(sql<string>`${drives.platinumVolumeMove}->>'from_name'`, driveNames)))
    : [];
  const driveByName = new Map<string, (typeof driveRows)[number]>();
  for (const d of driveRows) {
    driveByName.set(d.name, d);
    // A region move's old volume, until it is purged, belongs to the same drive.
    if (d.move?.from_name) driveByName.set(d.move.from_name, d);
  }
  const sessionIds = named.flatMap((n) => {
    const c = classifyVolumeName(n.name);
    return c.kind === 'workspace' ? [c.sessionId] : [];
  });
  const sessions = sessionIds.length
    ? await db
        .select({ sessionId: projectSessions.sessionId, accountId: projectSessions.accountId, projectId: projectSessions.projectId })
        .from(projectSessions)
        .where(inArray(projectSessions.sessionId, sessionIds))
    : [];
  const sessionById = new Map(sessions.map((s) => [s.sessionId, s]));

  for (const { resource, name } of named) {
    const c = classifyVolumeName(name);
    if (c.kind === 'drive') {
      const d = driveByName.get(name);
      owners.set(
        rowKey(resource),
        d ? { accountId: d.accountId, projectId: d.projectId ?? null, sessionId: null, driveId: d.driveId, volumeName: name, unattributedReason: null } : UNATTRIBUTED('owner_gone', name),
      );
    } else if (c.kind === 'workspace') {
      const s = sessionById.get(c.sessionId);
      owners.set(
        rowKey(resource),
        s ? { accountId: s.accountId, projectId: s.projectId, sessionId: s.sessionId, driveId: null, volumeName: name, unattributedReason: null } : UNATTRIBUTED('owner_gone', name),
      );
    } else {
      owners.set(rowKey(resource), UNATTRIBUTED('not_kortix', name));
    }
  }
}
