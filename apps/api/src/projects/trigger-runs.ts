/**
 * Trigger run history reads (KRTX-1743). A run is one row of
 * `project_trigger_executions`; this module lists runs, loads one for replay,
 * and serializes them onto the wire. Writes live in trigger-execution-store.ts.
 */
import type { TriggerRun } from '@kortix/api-contract';
import { gatewayRequestLogs, projectTriggerExecutions } from '@kortix/db';
import { and, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { isSecretKey } from '../connectors/args-preview';
import { db } from '../shared/db';
import { totalSpendSql } from '../shared/llm-spend';
import { isUuid } from '../shared/validate';
import { loadVisibleSessionsForList } from './lib/session-visibility';

export const TRIGGER_RUN_STATUSES = ['queued', 'running', 'fired', 'failed', 'skipped', 'rejected'] as const;
export type TriggerRunApiStatus = (typeof TRIGGER_RUN_STATUSES)[number];

/** DB status → API status. `requeued` is a create back on the lifecycle queue. */
const API_STATUS: Record<string, TriggerRunApiStatus> = {
  queued: 'queued',
  requeued: 'queued',
  running: 'running',
  succeeded: 'fired',
  dead_lettered: 'failed',
  failed: 'failed',
  skipped: 'skipped',
  rejected: 'rejected',
};

export function triggerRunApiStatus(dbStatus: string): TriggerRunApiStatus {
  return API_STATUS[dbStatus] ?? 'failed';
}

function dbStatusesFor(status: TriggerRunApiStatus): string[] {
  return Object.keys(API_STATUS).filter((key) => API_STATUS[key] === status);
}

const t = projectTriggerExecutions;
const g = gatewayRequestLogs;

// Drizzle renders a bare column unqualified inside a select field, so a
// correlated subquery names both tables' columns in full.
const run = (column: string) => sql.raw(`"kortix"."project_trigger_executions"."${column}"`);
const log = (column: string) => sql.raw(`"kortix"."gateway_request_logs"."${column}"`);

/** Ruling 4: LLM spend of the run's session inside `[started_at, ended_at or now]`. */
const costSql = sql<number | null>`case when ${run('session_id')} is null then null else (
  select ${totalSpendSql} from ${g}
   where ${log('project_id')} = ${run('project_id')}
     and ${log('session_id')} = ${run('session_id')}
     and ${log('created_at')} >= coalesce(${run('claimed_at')}, ${run('created_at')})
     and ${log('created_at')} <= coalesce(${run('run_ended_at')}, now())
) end`;

const runColumns = {
  row: t,
  // Full microsecond precision: a JS Date would truncate it and break the cursor.
  createdAtText: sql<string>`${t.createdAt}::text`,
};

type RunRow = { row: typeof t.$inferSelect; createdAtText: string };

function encodeCursor(row: RunRow | { createdAt: string; executionId: string }): string {
  const key = 'row' in row ? [row.createdAtText, row.row.executionId] : [row.createdAt, row.executionId];
  return Buffer.from(JSON.stringify(key)).toString('base64url');
}

/** `created_at::text` as Postgres prints it: `2026-10-16 18:03:54.382+00`. */
const PG_TIMESTAMPTZ_TEXT = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?[+-](\d{2})(?::(\d{2}))?$/;

/**
 * True when the fields name a real instant. The fields are round-tripped
 * through `Date.UTC`, because `Date.parse` accepts 2026-02-30 and Postgres
 * throws on it.
 */
function isRealTimestamp(text: string): boolean {
  const m = PG_TIMESTAMPTZ_TEXT.exec(text);
  if (!m) return false;
  const [y, mo, d, h, mi, sec, offH, offM] = [m[1], m[2], m[3], m[4], m[5], m[6], m[8], m[9] ?? '00'].map(Number) as number[];
  if (offH! > 15 || offM! > 59) return false;
  const t = new Date(Date.UTC(y!, mo! - 1, d!, h!, mi!, sec!));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo! - 1 && t.getUTCDate() === d
    && t.getUTCHours() === h && t.getUTCMinutes() === mi && t.getUTCSeconds() === sec;
}

/** Null when the cursor is not one this module issued. */
export function decodeTriggerRunCursor(cursor: string): { createdAt: string; executionId: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [createdAt, executionId] = parsed;
    if (typeof createdAt !== 'string' || !isRealTimestamp(createdAt)) return null;
    if (!isUuid(executionId)) return null;
    return { createdAt, executionId };
  } catch {
    return null;
  }
}

/** Every value under a credential-named key becomes `[redacted]`. The DB keeps the original. */
export function redactRunPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactRunPayload);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [key, isSecretKey(key) ? '[redacted]' : redactRunPayload(inner)]),
  );
}

export function serializeTriggerRun({ row }: Pick<RunRow, 'row'>, costUsd: number | null | undefined): TriggerRun {
  const status = triggerRunApiStatus(row.status);
  const startedAt = row.claimedAt ?? row.createdAt;
  // A run is open while it waits, runs, or its session's turn is still going.
  const open = status === 'queued' || status === 'running' || row.runStatus === 'running';
  const endedAt = open ? null : (row.runEndedAt ?? row.completedAt);
  return {
    run_id: row.executionId,
    slug: row.slug,
    source: row.source as TriggerRun['source'],
    status,
    run_status: (row.runStatus as TriggerRun['run_status']) ?? null,
    error: row.lastError,
    run_error: row.runError,
    session_id: row.sessionId,
    command_id: row.commandId,
    replay_of: row.replayOf,
    payload_verified: row.payloadVerified,
    payload: redactRunPayload(row.payload) as Record<string, unknown>,
    scheduled_for: row.scheduledFor.toISOString(),
    created_at: row.createdAt.toISOString(),
    started_at: startedAt.toISOString(),
    ended_at: endedAt?.toISOString() ?? null,
    duration_ms: endedAt ? Math.max(0, endedAt.getTime() - startedAt.getTime()) : null,
    cost_usd: costUsd ?? null,
  };
}

/** At most this many pages are read to fill one visible page (ruling 6 hides some rows). */
const MAX_SCAN_PAGES = 5;

/**
 * One page of the runs list, newest first. It reads no spend: the visibility
 * scan below discards rows the caller may not open, and a spend aggregate over
 * `gateway_request_logs` computed for a discarded row is pure waste (KRTX-4854:
 * one project whose runs are mostly hidden paid up to 5 scanned pages x 26
 * aggregates and hit the 25 s request deadline). Spend is read once, for the
 * runs that are returned, by `triggerRunCostsQuery`.
 */
export function triggerRunsPageQuery(input: {
  projectId: string;
  slug?: string;
  status?: TriggerRunApiStatus;
  cursor: { createdAt: string; executionId: string } | null;
  limit: number;
}) {
  const filters: SQL[] = [eq(t.projectId, input.projectId)];
  if (input.slug) filters.push(eq(t.slug, input.slug));
  if (input.status === 'failed') {
    // A failed run is a fire that failed OR a fire whose agent turn failed:
    // the second is the most common failure and must not hide behind `fired`.
    filters.push(or(inArray(t.status, dbStatusesFor('failed')), eq(t.runStatus, 'failed'))!);
  } else if (input.status) {
    filters.push(inArray(t.status, dbStatusesFor(input.status)));
  }
  if (input.cursor) filters.push(sql`(${t.createdAt}, ${t.executionId}) < (${input.cursor.createdAt}::timestamptz, ${input.cursor.executionId}::uuid)`);
  return db
    .select(runColumns)
    .from(t)
    .where(and(...filters))
    .orderBy(desc(t.createdAt), desc(t.executionId))
    .limit(input.limit + 1);
}

/**
 * LLM spend of each given run (ruling 4), as a correlated aggregate over
 * `gateway_request_logs`. Named and exported so the covering-index DB suite can
 * EXPLAIN the exact statement the route runs (KRTX-4795): the spend read must
 * stay index-only on a covering index of `gateway_request_logs` — the same
 * contract KRTX-4022 and KRTX-4638 pinned for the other gateway-log readers. A
 * column read that drifts out of every covering index's INCLUDE turns the scan
 * into per-row heap fetches of the wide (request/response jsonb) rows, and a
 * page of runs pays that once per row.
 */
export function triggerRunCostsQuery(projectId: string, executionIds: readonly string[]) {
  return db
    .select({ executionId: t.executionId, costUsd: costSql })
    .from(t)
    .where(and(eq(t.projectId, projectId), inArray(t.executionId, [...executionIds])));
}

/** Spend by run id for the returned runs; a run with no session maps to null. */
async function triggerRunCosts(projectId: string, executionIds: readonly string[]): Promise<Map<string, number | null>> {
  if (executionIds.length === 0) return new Map();
  const rows = await triggerRunCostsQuery(projectId, executionIds);
  return new Map(rows.map((r) => [r.executionId, r.costUsd === null ? null : Number(r.costUsd)]));
}

/**
 * Runs newest first, keyset-paged on `(created_at, execution_id)`. A run with a
 * session is listed only when the caller may open that session (ruling 6).
 */
export async function listVisibleTriggerRuns(input: {
  loaded: Parameters<typeof loadVisibleSessionsForList>[0];
  binding: string | null;
  slug?: string;
  status?: TriggerRunApiStatus;
  limit: number;
  cursor: { createdAt: string; executionId: string } | null;
}): Promise<{ runs: TriggerRun[]; next_cursor: string | null }> {
  const kept: RunRow[] = [];
  const finish = async (nextCursor: string | null) => {
    const costs = await triggerRunCosts(input.loaded.row.projectId, kept.map((r) => r.row.executionId));
    return { runs: kept.map((r) => serializeTriggerRun(r, costs.get(r.row.executionId))), next_cursor: nextCursor };
  };
  let cursor = input.cursor;
  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    const rows: RunRow[] = await triggerRunsPageQuery({
      projectId: input.loaded.row.projectId,
      slug: input.slug,
      status: input.status,
      cursor,
      limit: input.limit,
    });
    const more = rows.length > input.limit;
    const batch = rows.slice(0, input.limit);
    const sessionIds = batch.flatMap((r) => (r.row.sessionId ? [r.row.sessionId] : []));
    const visible = await loadVisibleSessionsForList(input.loaded, sessionIds, input.binding, input.binding);
    for (const [index, r] of batch.entries()) {
      if (r.row.sessionId && !visible.has(r.row.sessionId)) continue;
      kept.push(r);
      if (kept.length === input.limit) {
        return finish(more || index + 1 < batch.length ? encodeCursor(r) : null);
      }
    }
    if (!more) return finish(null);
    const last = batch[batch.length - 1]!;
    cursor = { createdAt: last.createdAtText, executionId: last.row.executionId };
  }
  // The scan budget ran out on hidden rows: a short page that continues after the last scanned row.
  return finish(cursor ? encodeCursor(cursor) : null);
}

/** One run of one trigger, unredacted, for replay. Null when it is not that trigger's. */
export async function loadTriggerRunForReplay(projectId: string, slug: string, runId: string) {
  if (!isUuid(runId)) return null;
  const [row] = await db
    .select()
    .from(t)
    .where(and(eq(t.projectId, projectId), eq(t.slug, slug), eq(t.executionId, runId)))
    .limit(1);
  return row ?? null;
}
