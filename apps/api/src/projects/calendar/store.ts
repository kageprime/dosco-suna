// Calendar rows (flag `calendar`): `kortix.calendar_items` and
// `kortix.calendar_comments`. Reads and writes only; the rules live in
// service.ts.
import { calendarComments, calendarItems, projectSessions } from '@kortix/db';
import { CALENDAR_LIMITS } from '@kortix/api-contract';
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { db } from '../../shared/db';

export type CalendarItemRow = typeof calendarItems.$inferSelect;
export type CalendarCommentRow = typeof calendarComments.$inferSelect;
export type CalendarItemInsert = typeof calendarItems.$inferInsert;

export interface CalendarListFilter {
  from: Date | null;
  to: Date | null;
  /** Also list open items with no date. */
  undated: boolean;
  status: 'open' | 'done' | null;
  assignee: { userId: string } | { agent: string } | null;
}

function assigneeWhere(assignee: CalendarListFilter['assignee']): SQL | undefined {
  if (!assignee) return undefined;
  return 'userId' in assignee ? eq(calendarItems.assigneeUserId, assignee.userId) : eq(calendarItems.assigneeAgent, assignee.agent);
}

/** Dated items in `[from, to)` (time order), then open undated items (newest first). */
export async function listCalendarItems(projectId: string, filter: CalendarListFilter): Promise<CalendarItemRow[]> {
  const common = [eq(calendarItems.projectId, projectId), assigneeWhere(filter.assignee), filter.status ? eq(calendarItems.status, filter.status) : undefined];
  const dated = db
    .select()
    .from(calendarItems)
    .where(and(
      ...common,
      sql`${calendarItems.startsAt} IS NOT NULL`,
      filter.from ? gte(calendarItems.startsAt, filter.from) : undefined,
      filter.to ? lt(calendarItems.startsAt, filter.to) : undefined,
    ))
    .orderBy(asc(calendarItems.startsAt), asc(calendarItems.itemId))
    .limit(CALENDAR_LIMITS.list_items);
  const undated = filter.undated && filter.status !== 'done'
    ? db
      .select()
      .from(calendarItems)
      .where(and(...common, isNull(calendarItems.startsAt), eq(calendarItems.status, 'open')))
      .orderBy(desc(calendarItems.itemId))
      .limit(CALENDAR_LIMITS.undated_items)
    : Promise.resolve([] as CalendarItemRow[]);
  const [datedRows, undatedRows] = await Promise.all([dated, undated]);
  return [...datedRows, ...undatedRows];
}

export async function getCalendarItem(projectId: string, itemId: string): Promise<CalendarItemRow | null> {
  const [row] = await db
    .select()
    .from(calendarItems)
    .where(and(eq(calendarItems.projectId, projectId), eq(calendarItems.itemId, itemId)))
    .limit(1);
  return row ?? null;
}

export async function insertCalendarItem(values: CalendarItemInsert): Promise<CalendarItemRow> {
  const [row] = await db.insert(calendarItems).values(values).returning();
  return row!;
}

export async function updateCalendarItem(
  projectId: string,
  itemId: string,
  patch: Partial<Omit<CalendarItemInsert, 'itemId' | 'projectId'>>,
): Promise<CalendarItemRow | null> {
  const [row] = await db
    .update(calendarItems)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(calendarItems.projectId, projectId), eq(calendarItems.itemId, itemId)))
    .returning();
  return row ?? null;
}

/** Deletes the item and (by cascade) its comments. False when it did not exist. */
export async function deleteCalendarItem(projectId: string, itemId: string): Promise<boolean> {
  const rows = await db
    .delete(calendarItems)
    .where(and(eq(calendarItems.projectId, projectId), eq(calendarItems.itemId, itemId)))
    .returning({ itemId: calendarItems.itemId });
  return rows.length > 0;
}

export async function listCalendarComments(itemId: string): Promise<CalendarCommentRow[]> {
  return db
    .select()
    .from(calendarComments)
    .where(eq(calendarComments.itemId, itemId))
    .orderBy(asc(calendarComments.commentId))
    .limit(CALENDAR_LIMITS.comments);
}

export async function insertCalendarComment(values: typeof calendarComments.$inferInsert): Promise<CalendarCommentRow> {
  const [row] = await db.insert(calendarComments).values(values).returning();
  await db.update(calendarItems).set({ updatedAt: new Date() }).where(eq(calendarItems.itemId, values.itemId));
  return row!;
}

/** Comment count per item. No query for an empty list. */
export async function calendarCommentCounts(itemIds: readonly string[]): Promise<Map<string, number>> {
  if (itemIds.length === 0) return new Map();
  const rows = await db
    .select({ itemId: calendarComments.itemId, n: count() })
    .from(calendarComments)
    .where(inArray(calendarComments.itemId, [...itemIds]))
    .groupBy(calendarComments.itemId);
  return new Map(rows.map((row) => [row.itemId, Number(row.n)]));
}

/** The agent a session of this project runs, or null when the session is not one of its sessions. */
export async function sessionAgentName(projectId: string, sessionId: string): Promise<string | null> {
  const [row] = await db
    .select({ agentName: projectSessions.agentName })
    .from(projectSessions)
    .where(and(eq(projectSessions.projectId, projectId), eq(projectSessions.sessionId, sessionId)))
    .limit(1);
  return row ? row.agentName ?? 'default' : null;
}
