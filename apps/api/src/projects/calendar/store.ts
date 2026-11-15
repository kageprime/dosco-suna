// Calendar rows (flag `calendar`): `kortix.calendar_items`, the people on
// each (`kortix.calendar_item_people`) and `kortix.calendar_comments`. Reads
// and writes only; the rules live in service.ts.
import { calendarComments, calendarItemPeople, calendarItems, projectSessions } from '@kortix/db';
import { CALENDAR_LIMITS } from '@kortix/api-contract';
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { db } from '../../shared/db';

export type CalendarItemRow = typeof calendarItems.$inferSelect;
export type CalendarCommentRow = typeof calendarComments.$inferSelect;
export type CalendarItemInsert = typeof calendarItems.$inferInsert;
/** One of the people on an item, as stored. */
export type CalendarPersonRef = { userId: string } | { agent: string };

export interface CalendarListFilter {
  from: Date | null;
  to: Date | null;
  /** Also list open items with no date. */
  undated: boolean;
  status: 'open' | 'done' | null;
  /** Only items this person or agent is on. */
  with: CalendarPersonRef | null;
}

function withWhere(projectId: string, who: CalendarListFilter['with']): SQL | undefined {
  if (!who) return undefined;
  const match = 'userId' in who ? eq(calendarItemPeople.userId, who.userId) : eq(calendarItemPeople.agent, who.agent);
  return inArray(
    calendarItems.itemId,
    db.select({ itemId: calendarItemPeople.itemId }).from(calendarItemPeople).where(and(eq(calendarItemPeople.projectId, projectId), match)),
  );
}

/** Dated items in `[from, to)` (time order), then open undated items (newest first). */
export async function listCalendarItems(projectId: string, filter: CalendarListFilter): Promise<CalendarItemRow[]> {
  const common = [eq(calendarItems.projectId, projectId), withWhere(projectId, filter.with), filter.status ? eq(calendarItems.status, filter.status) : undefined];
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

/** The people on each item, in the order they were added. One query for every item. */
export async function calendarPeople(itemIds: readonly string[]): Promise<Map<string, CalendarPersonRef[]>> {
  const out = new Map<string, CalendarPersonRef[]>();
  if (itemIds.length === 0) return out;
  const rows = await db
    .select({ itemId: calendarItemPeople.itemId, userId: calendarItemPeople.userId, agent: calendarItemPeople.agent })
    .from(calendarItemPeople)
    .where(inArray(calendarItemPeople.itemId, [...itemIds]))
    .orderBy(asc(calendarItemPeople.addedAt));
  for (const row of rows) {
    const ref: CalendarPersonRef = row.userId ? { userId: row.userId } : { agent: row.agent ?? '' };
    out.set(row.itemId, [...(out.get(row.itemId) ?? []), ref]);
  }
  return out;
}

const sameRef = (a: CalendarPersonRef, b: CalendarPersonRef) =>
  'userId' in a ? 'userId' in b && a.userId === b.userId : 'agent' in b && a.agent === b.agent;

/**
 * Set the people on an item: the ones not in `people` leave, new ones join
 * (each keeps the time it was added). Returns the persons who joined.
 */
export async function setCalendarPeople(projectId: string, itemId: string, people: readonly CalendarPersonRef[]): Promise<string[]> {
  return db.transaction(async (tx) => {
    const current = (await tx
      .select({ userId: calendarItemPeople.userId, agent: calendarItemPeople.agent })
      .from(calendarItemPeople)
      .where(eq(calendarItemPeople.itemId, itemId)))
      .map((row): CalendarPersonRef => (row.userId ? { userId: row.userId } : { agent: row.agent ?? '' }));
    const leaving = current.filter((ref) => !people.some((p) => sameRef(p, ref)));
    const joining = people.filter((ref, i) => !current.some((c) => sameRef(c, ref)) && people.findIndex((p) => sameRef(p, ref)) === i);
    for (const ref of leaving) {
      await tx.delete(calendarItemPeople).where(and(
        eq(calendarItemPeople.itemId, itemId),
        'userId' in ref ? eq(calendarItemPeople.userId, ref.userId) : eq(calendarItemPeople.agent, ref.agent),
      ));
    }
    if (joining.length > 0) {
      // One millisecond apart, so the list reads back in the order it was sent.
      const at = Date.now();
      await tx.insert(calendarItemPeople).values(joining.map((ref, i) => ({
        itemId,
        projectId,
        userId: 'userId' in ref ? ref.userId : null,
        agent: 'agent' in ref ? ref.agent : null,
        addedAt: new Date(at + i),
      }))).onConflictDoNothing();
    }
    return joining.flatMap((ref) => ('userId' in ref ? [ref.userId] : []));
  });
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
