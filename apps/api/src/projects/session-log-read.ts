/**
 * Reads over the session log (P4.2). Postgres only: nothing here reaches a box.
 *
 * `readSessionLogPage` serves `GET .../log` (`SessionLogPage`, `@kortix/api-contract/session-log`).
 *
 * The v1 transcript reads (`toV1` of the log in the v1 window shape: `GET …/transcript`, the open
 * bundle's v1 window) were removed by session-log plan P8.3. `withKeptToolInputs` still runs
 * `toV1` on one message of a `fromV1` thread, to serve an old backfilled tool call with the input
 * the v1 mirror kept.
 *
 * `readSessionLogPage` answers `'unknown_thread'` for a `thread` the session does not have.
 */
import {
  toV1,
  ModelRefSchema,
  type SessionLog,
  type SessionLogBlock,
  type SessionLogMessage,
  type SessionLogPage,
} from '@kortix/api-contract/session-log';
import { KORTIX_TRANSCRIPT_SCHEMA } from '@kortix/api-contract/transcript';
import { sessionLogMessages, sessionLogs, sessionLogThreads } from '@kortix/db';
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../shared/db';
import { restoreStrippedToolParts } from './lib/stripped-tool-parts';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type J = Record<string, unknown>;
type ThreadRow = { threadId: string; parentThreadId: string | null; record: J };

const READ_ONLY = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const;

const v1Ext = (record: J) =>
  Object.values((record.ext ?? {}) as Record<string, { version?: string; native_id?: string; data?: J }>).find(
    (e) => e?.version === KORTIX_TRANSCRIPT_SCHEMA,
  );
const rootOf = (threads: ThreadRow[]) => threads.find((t) => t.parentThreadId === null) ?? threads[0];

function readThreads(tx: Tx, sessionId: string): Promise<ThreadRow[]> {
  return tx
    .select({ threadId: sessionLogThreads.threadId, parentThreadId: sessionLogThreads.parentThreadId, record: sessionLogThreads.record })
    .from(sessionLogThreads)
    .where(eq(sessionLogThreads.sessionId, sessionId))
    .orderBy(asc(sessionLogThreads.createdAt), asc(sessionLogThreads.threadId));
}

// ─── GET .../log ─────────────────────────────────────────────────────────────

type PageInput = { sessionId: string; threadId: string | null; beforeSeq: number | null; limit: number };

const threadScope = (input: PageInput, threadId: string) =>
  and(
    eq(sessionLogMessages.sessionId, input.sessionId),
    eq(sessionLogMessages.threadId, threadId),
    isNull(sessionLogMessages.deletedAt),
    input.beforeSeq === null ? undefined : lt(sessionLogMessages.seq, input.beforeSeq),
  ) as SQL;

/** Rows the page window would carry, newest first, each with its stored record size (`pg_column_size`, bytes on disk ≈ a lower bound of the JSON payload). */
type SizedWindowRow = { seq: number; bytes: number };

/**
 * How many window rows the page budget serves.
 *
 * Rows arrive seq-descending (newest first). The page keeps the newest whole
 * messages and drops the tail rows that would overflow `budget`; the newest
 * message is served however large it is (an empty page answers nothing, and the
 * route's clients read that as no log). A dropped tail means older messages
 * exist: the caller answers `has_more: true` and clients read on with `before_seq`.
 */
export function keptUnderBudget(rows: SizedWindowRow[], budget: number): {
  keptCount: number;
  /** The oldest kept row's `seq`; `null` when nothing was dropped (no lower bound needed). */
  oldestKeptSeq: number | null;
  dropped: boolean;
} {
  let acc = 0;
  let keptCount = 0;
  for (const row of rows) {
    if (keptCount > 0 && acc + row.bytes > budget) break;
    acc += row.bytes;
    keptCount += 1;
  }
  const dropped = keptCount < rows.length;
  return { keptCount, oldestKeptSeq: dropped ? rows[keptCount - 1]!.seq : null, dropped };
}

/** One page of one thread. Null when the session has no stored log (a new session). */
export function readSessionLogPage(input: PageInput): Promise<SessionLogPage | 'unknown_thread' | null> {
  return db.transaction(async (tx) => {
    const [log] = await tx
      .select({ generation: sessionLogs.generation, record: sessionLogs.record })
      .from(sessionLogs)
      .where(eq(sessionLogs.sessionId, input.sessionId))
      .limit(1);
    if (!log) return null;
    const threads = await readThreads(tx, input.sessionId);
    if (input.threadId !== null && !threads.some((t) => t.threadId === input.threadId)) return 'unknown_thread' as const;
    let threadId = input.threadId ?? rootOf(threads)?.threadId ?? null;
    if (threadId === null) {
      // A journal batch may carry messages before their thread upsert.
      const [first] = await tx
        .select({ threadId: sessionLogMessages.threadId })
        .from(sessionLogMessages)
        .where(eq(sessionLogMessages.sessionId, input.sessionId))
        .orderBy(asc(sessionLogMessages.seq))
        .limit(1);
      threadId = first?.threadId ?? null;
    }
    const threadRecord = threads.find((t) => t.threadId === threadId)?.record;
    // The page budget bounds the read's wire cost: `GET …/log` serves a window of whole stored
    // records and a heavy session's page carried tens of MB (the read scales with the page
    // payload: 40 MB ran ~330 ms on loopback; prod `db;dur` was ~96 % of a 1–5 s read —
    // KRTX-4508). Probe the window's seq and sizes first (TOAST pointers, no payload), keep
    // the newest run under `SESSION_LOG_PAGE_MAX_BYTES`, then read only those records in full.
    // A pointer read (`limit: 0` — the snapshot route's `?transcript=0`, documented "session,
    // generation, threads, no messages") reads NO payload at all: it used to read the newest
    // record whole and slice it away, which paid a heavy session's multi-MB detoast on every
    // session open (KRTX-4733: prod slow rows 1.1–4.8 s, `db;dur` 90–98 % of wall).
    let budgetCut = false;
    let windowRows: SizedWindowRow[] = [];
    const rows =
      threadId === null
        ? []
        : await (async () => {
            const scope = threadScope(input, threadId);
            windowRows = await tx
              .select({ seq: sessionLogMessages.seq, bytes: sql<number>`pg_column_size(${sessionLogMessages.record})::int` })
              .from(sessionLogMessages)
              .where(scope)
              .orderBy(desc(sessionLogMessages.seq))
              .limit(input.limit + 1);
            if (input.limit === 0) return [];
            const kept = keptUnderBudget(windowRows, config.SESSION_LOG_PAGE_MAX_BYTES);
            budgetCut = kept.dropped;
            let payloadScope = scope;
            if (kept.dropped) {
              payloadScope = and(scope, gte(sessionLogMessages.seq, kept.oldestKeptSeq!)) as SQL;
            }
            return (await tx
              .select({ record: sessionLogMessages.record })
              .from(sessionLogMessages)
              .where(payloadScope)
              .orderBy(desc(sessionLogMessages.seq))
              .limit(kept.keptCount));
          })();
    return {
      session: log.record as SessionLogPage['session'],
      generation: log.generation,
      threads: threads.map((t) => t.record as SessionLogPage['threads'][number]),
      thread_id: threadId,
      messages: rows
        .slice(0, input.limit)
        .reverse()
        .map((r) => withKeptToolInputs(log.record as J, threadRecord, r.record as SessionLogMessage)),
      // The probe's row count is the truth for every limit: with `limit: 0` the page serves
      // no messages, so "older messages exist" is just "the window holds a row" (the payload
      // `rows` are empty and the budget never cut a one-row window).
      has_more: budgetCut || windowRows.length > input.limit,
    };
  }, READ_ONLY);
}

type ToolCall = Extract<SessionLogBlock, { type: 'tool_call' }>;
const stripped = (b: SessionLogBlock): b is ToolCall =>
  b.type === 'tool_call' && (b.input === null || b.input === undefined) && (b.status === 'complete' || b.status === 'error');

/**
 * A tool call the old v1 mirror stripped (no input, no output: a row saved before 2026-09-28 and
 * backfilled into the log) is served with what it kept, as the v1 window serves it
 * (`restoreStrippedToolParts`). The block gets the proven input, and a command its output. Its v1
 * residual becomes the restored part, so `toV1` of the page (the SDK's v1 view) gives the row the
 * v1 window gives. Storage is unchanged. A message of a thread without the v1 ext passes as is.
 */
export function withKeptToolInputs(session: J, thread: J | undefined, message: SessionLogMessage): SessionLogMessage {
  if (!thread || !v1Ext(thread) || !message.blocks?.some(stripped)) return message;
  const parts = new Map(
    toV1({ ...session, threads: [{ ...thread, messages: [message] }] } as unknown as SessionLog)
      .rows.flatMap((row) => row.parts as unknown as J[])
      .map((part) => [part.id, part]),
  );
  return {
    ...message,
    blocks: message.blocks.map((b) => {
      const part = stripped(b) ? parts.get(b.id) : undefined;
      if (!part) return b;
      const [restored] = restoreStrippedToolParts([part]);
      if (restored === part) return b;
      const state = restored!.state as J;
      const call = b as ToolCall;
      const output = typeof state.output === 'string' && call.result && !call.result.content.some((c) => c.type === 'text') ? state.output : null;
      const key = Object.keys(call.ext ?? {}).find((k) => call.ext![k]!.version === KORTIX_TRANSCRIPT_SCHEMA);
      return {
        ...call,
        input: state.input,
        ...(output !== null && { result: { ...call.result!, content: [{ type: 'text' as const, text: output }, ...call.result!.content] } }),
        ...(key && { ext: { ...call.ext, [key]: { ...call.ext![key]!, data: { set: restored } } } }),
      };
    }),
  };
}

/** Bounded inventory read: no sandbox wake and no per-session log requests. */
export async function readSessionConversationModels(sessionIds: string[]): Promise<Map<string, string>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await db.select({
    sessionId: sessionLogs.sessionId,
    model: sql<unknown>`${sessionLogs.record}->'selection'->'model'`,
  }).from(sessionLogs).where(inArray(sessionLogs.sessionId, sessionIds));
  const models = new Map<string, string>();
  for (const row of rows) {
    const parsed = ModelRefSchema.safeParse(row.model);
    if (parsed.success && parsed.data.provider.trim() && parsed.data.model.trim()) {
      models.set(row.sessionId, `${parsed.data.provider}/${parsed.data.model}`);
    }
  }
  return models;
}
