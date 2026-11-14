// Calendar (flag `calendar`): the rules. Routes build the actor and the
// project and call these functions with plain values.
//
// - Every person and agent that can open the workspace reads and writes
//   every item (`project.read`). There is no per-item access.
// - Someone else who @mentions a person (notes or comment) or assigns them
//   an item sends that person one `mention` notification. A person never
//   notifies themself; an agent may notify the person it works for.
// - A person's comment on an item an agent session created, and a person
//   marking that item done or open again, is delivered into that session
//   (`system:calendar`) when the person may prompt it. An agent's comment
//   wakes nobody, so two agents cannot keep each other running.
// - Nothing here runs unless a calendar route is called: no job, no hook.
import {
  CALENDAR_LIMITS,
  type CalendarAssigneeInput,
  type CalendarAuthor,
  type CalendarComment,
  type CalendarItem,
  type CalendarPerson,
  type CreateCalendarItemRequest,
  type UpdateCalendarItemRequest,
} from '@kortix/api-contract';
import { isMyKortixAgentName } from '@kortix/shared';
import { logger } from '../../lib/logger';
import { mayPromptSessions, filterProjectRecipients } from '../../notifications/access';
import { deliver } from '../../notifications/notifier';
import { errorMessage } from '../../shared/error-message';
import { isUuid } from '../../shared/validate';
import { loadProjectAgents } from '../agents';
import { mentionTokens } from '../lib/mentions';
import { projectMentionCandidates, resolveMentions, type MentionCandidate } from '../lib/space-posts';
import { resolveUserIdentities } from '../lib/user-identity';
import { deliverThroughQueue } from '../session-lifecycle/follow-up-delivery';
import * as store from './store';

export type CalendarActor =
  | { kind: 'person'; userId: string }
  /** `userId`: the person the session works for now, when it has one. */
  | { kind: 'agent'; agent: string; sessionId: string; userId: string | null };

/** The project row as the routes load it. */
export type CalendarProject = Parameters<typeof loadProjectAgents>[0] & { projectId: string; accountId: string };

export interface CalendarContext {
  project: CalendarProject;
  actor: CalendarActor;
}

export class CalendarError extends Error {
  constructor(
    readonly code: 'calendar_not_found' | 'calendar_invalid',
    message: string,
    readonly status: 404 | 422,
    readonly violations?: string[],
  ) {
    super(message);
  }
}

const notFound = () => new CalendarError('calendar_not_found', 'Calendar item not found.', 404);
const invalid = (message: string) => new CalendarError('calendar_invalid', message, 422, [message]);

// ─── Wire shapes ────────────────────────────────────────────────────────────

function authorOf(row: { userId: string | null; agent: string | null; sessionId: string | null }): CalendarAuthor {
  if (row.agent) return { kind: 'agent', agent: row.agent, session_id: row.sessionId };
  return { kind: 'person', user_id: row.userId ?? '' };
}

export function serializeCalendarItem(row: store.CalendarItemRow, commentCount: number): CalendarItem {
  return {
    item_id: row.itemId,
    project_id: row.projectId,
    title: row.title,
    notes: row.notes,
    starts_at: row.startsAt ? row.startsAt.toISOString() : null,
    all_day: row.allDay,
    status: row.status,
    assignee: row.assigneeUserId
      ? { kind: 'person', user_id: row.assigneeUserId }
      : row.assigneeAgent
        ? { kind: 'agent', agent: row.assigneeAgent }
        : null,
    created_by: authorOf({ userId: row.createdByUserId, agent: row.createdByAgent, sessionId: row.createdBySessionId }),
    comment_count: commentCount,
    completed_at: row.completedAt ? row.completedAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export function serializeCalendarComment(row: store.CalendarCommentRow): CalendarComment {
  return {
    comment_id: row.commentId,
    item_id: row.itemId,
    body: row.body,
    author: authorOf({ userId: row.authorUserId, agent: row.authorAgent, sessionId: row.authorSessionId }),
    created_at: row.createdAt.toISOString(),
  };
}

// ─── Inputs ─────────────────────────────────────────────────────────────────

/**
 * The stored instant. An all-day item keeps the calendar date as written
 * (`2026-11-16T00:00:00+09:00` is the 16th), stored as UTC midnight of it.
 */
export function normalizeStartsAt(startsAt: string | null | undefined, allDay: boolean): Date | null {
  if (!startsAt) return null;
  if (allDay) return new Date(`${startsAt.slice(0, 10)}T00:00:00.000Z`);
  return new Date(startsAt);
}

/** A name as one `@` token, the rule `resolveMentions` matches: `Ana Lima` → `ana-lima`. */
export function mentionHandle(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9._@+-]+/g, '-').replace(/^-+|-+$/g, '');
}

async function projectAgentNames(project: CalendarProject): Promise<string[]> {
  try {
    return (await loadProjectAgents(project)).specs.map((spec) => spec.name);
  } catch (error) {
    logger.warn('[calendar] the agents of the workspace were not read', { projectId: project.projectId, error: errorMessage(error) });
    return [];
  }
}

async function resolveAssignee(
  ctx: CalendarContext,
  input: CalendarAssigneeInput | null,
): Promise<{ assigneeUserId: string | null; assigneeAgent: string | null }> {
  if (input === null) return { assigneeUserId: null, assigneeAgent: null };
  if ('me' in input) {
    return ctx.actor.kind === 'person'
      ? { assigneeUserId: ctx.actor.userId, assigneeAgent: null }
      : { assigneeUserId: null, assigneeAgent: ctx.actor.agent };
  }
  if ('agent' in input) {
    const names = await projectAgentNames(ctx.project);
    const agent = names.find((name) => name === input.agent) ?? names.find((name) => name.toLowerCase() === input.agent.toLowerCase());
    if (!agent) throw invalid(`assignee.agent: no agent named ${input.agent} in this workspace.`);
    return { assigneeUserId: null, assigneeAgent: agent };
  }
  const people = await projectMentionCandidates(ctx.project);
  const person = 'user_id' in input
    ? people.find((p) => p.userId === input.user_id)
    : people.find((p) => p.email?.toLowerCase() === input.email.toLowerCase());
  if (!person) throw invalid('assignee: that person is not in this workspace.');
  return { assigneeUserId: person.userId, assigneeAgent: null };
}

function createdByOf(actor: CalendarActor) {
  return actor.kind === 'person'
    ? { createdByUserId: actor.userId, createdByAgent: null, createdBySessionId: null }
    : { createdByUserId: null, createdByAgent: actor.agent, createdBySessionId: actor.sessionId };
}

// ─── Reads ──────────────────────────────────────────────────────────────────

export interface CalendarListQuery {
  from?: string;
  to?: string;
  undated?: boolean;
  status?: 'open' | 'done';
  /** `me`, `user:<uuid>` or `agent:<name>`. */
  assignee?: string;
}

const DAY_MS = 86_400_000;

export async function listItems(ctx: CalendarContext, query: CalendarListQuery): Promise<CalendarItem[]> {
  const from = query.from ? new Date(query.from) : null;
  const to = query.to ? new Date(query.to) : null;
  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) throw invalid('from, to: give ISO times.');
  if (from && to && to.getTime() <= from.getTime()) throw invalid('to: must be after from.');
  if (from && to && to.getTime() - from.getTime() > CALENDAR_LIMITS.range_days * DAY_MS) {
    throw invalid(`from, to: at most ${CALENDAR_LIMITS.range_days} days apart.`);
  }
  let assignee: store.CalendarListFilter['assignee'] = null;
  if (query.assignee === 'me') {
    assignee = ctx.actor.kind === 'person' ? { userId: ctx.actor.userId } : { agent: ctx.actor.agent };
  } else if (query.assignee?.startsWith('user:')) {
    if (!isUuid(query.assignee.slice(5))) throw invalid('assignee: user:<id> takes a user id.');
    assignee = { userId: query.assignee.slice(5) };
  } else if (query.assignee?.startsWith('agent:')) {
    assignee = { agent: query.assignee.slice(6) };
  } else if (query.assignee) {
    throw invalid('assignee: me, user:<id> or agent:<name>.');
  }
  const rows = await store.listCalendarItems(ctx.project.projectId, {
    from,
    to,
    undated: query.undated !== false,
    status: query.status ?? null,
    assignee,
  });
  const counts = await store.calendarCommentCounts(rows.map((row) => row.itemId));
  return rows.map((row) => serializeCalendarItem(row, counts.get(row.itemId) ?? 0));
}

export async function getItem(ctx: CalendarContext, itemId: string): Promise<{ item: CalendarItem; comments: CalendarComment[] }> {
  const row = await store.getCalendarItem(ctx.project.projectId, itemId);
  if (!row) throw notFound();
  const comments = await store.listCalendarComments(row.itemId);
  return { item: serializeCalendarItem(row, comments.length), comments: comments.map(serializeCalendarComment) };
}

/** The people who can be assigned or mentioned, with the handle `@` matches, and the agents. */
export async function listPeople(project: CalendarProject): Promise<{ people: CalendarPerson[]; agents: Array<{ name: string }> }> {
  const [candidates, agents] = await Promise.all([projectMentionCandidates(project), projectAgentNames(project)]);
  const identities = await resolveUserIdentities(candidates.map((c) => c.userId));
  const people = candidates
    .filter((c) => identities.get(c.userId)?.exists !== false)
    .map((c) => ({
      user_id: c.userId,
      name: c.displayName,
      email: c.email,
      avatar_url: identities.get(c.userId)?.avatarUrl ?? null,
      handle: handleFor(c, candidates),
    }))
    .sort((a, b) => (a.name ?? a.email ?? '').localeCompare(b.name ?? b.email ?? ''));
  return { people, agents: agents.map((name) => ({ name })) };
}

/** The shortest `@` token that names exactly this person: the name slug, the email's local part, or the email. */
function handleFor(person: MentionCandidate, everyone: readonly MentionCandidate[]): string {
  const options = [
    person.displayName ? mentionHandle(person.displayName) : '',
    person.email?.split('@')[0]?.toLowerCase() ?? '',
    person.email?.toLowerCase() ?? '',
  ].filter((token) => token.length >= 2 && /^[a-z0-9]/.test(token));
  for (const token of options) {
    const hits = resolveMentions(`@${token}`, everyone, []).filter((m) => m.kind === 'person');
    if (hits.length === 1 && hits[0]!.userId === person.userId) return token;
  }
  return person.email?.toLowerCase() ?? person.userId;
}

// ─── Writes ─────────────────────────────────────────────────────────────────

export async function createItem(ctx: CalendarContext, body: CreateCalendarItemRequest): Promise<CalendarItem> {
  const allDay = body.all_day === true && Boolean(body.starts_at);
  const assignee = await resolveAssignee(ctx, body.assignee ?? null);
  const status = body.status ?? 'open';
  const row = await store.insertCalendarItem({
    projectId: ctx.project.projectId,
    title: body.title.trim(),
    notes: body.notes ?? '',
    startsAt: normalizeStartsAt(body.starts_at, allDay),
    allDay,
    status,
    completedAt: status === 'done' ? new Date() : null,
    ...assignee,
    ...createdByOf(ctx.actor),
  });
  await notifyPeople(ctx, row, {
    assigned: row.assigneeUserId,
    mentioned: await mentionedPeople(ctx, row.notes, ''),
    key: `create`,
    excerpt: row.notes,
  });
  return serializeCalendarItem(row, 0);
}

export async function updateItem(ctx: CalendarContext, itemId: string, body: UpdateCalendarItemRequest): Promise<CalendarItem> {
  const before = await store.getCalendarItem(ctx.project.projectId, itemId);
  if (!before) throw notFound();
  const patch: Parameters<typeof store.updateCalendarItem>[2] = {};
  if (body.title !== undefined) patch.title = body.title.trim();
  if (body.notes !== undefined) patch.notes = body.notes;
  if (body.starts_at !== undefined || body.all_day !== undefined) {
    const startsAt = body.starts_at !== undefined ? body.starts_at : before.startsAt?.toISOString() ?? null;
    const allDay = Boolean(startsAt) && (body.all_day ?? before.allDay);
    patch.startsAt = normalizeStartsAt(startsAt, allDay);
    patch.allDay = allDay;
  }
  if (body.assignee !== undefined) Object.assign(patch, await resolveAssignee(ctx, body.assignee));
  if (body.status !== undefined && body.status !== before.status) {
    patch.status = body.status;
    patch.completedAt = body.status === 'done' ? new Date() : null;
  }
  const row = await store.updateCalendarItem(ctx.project.projectId, itemId, patch);
  if (!row) throw notFound();

  const newlyAssigned = row.assigneeUserId && row.assigneeUserId !== before.assigneeUserId ? row.assigneeUserId : null;
  const mentioned = body.notes !== undefined ? await mentionedPeople(ctx, row.notes, before.notes) : [];
  await notifyPeople(ctx, row, {
    assigned: newlyAssigned,
    mentioned,
    key: `update:${row.updatedAt.getTime()}`,
    excerpt: row.notes,
  });
  if (patch.status) {
    await wakeCreatorSession(ctx, row, async () => `${await actorName(ctx)} marked “${row.title}” ${row.status === 'done' ? 'done' : 'open again'}.`, `status:${row.updatedAt.getTime()}`);
  }
  const counts = await store.calendarCommentCounts([row.itemId]);
  return serializeCalendarItem(row, counts.get(row.itemId) ?? 0);
}

export async function deleteItem(ctx: CalendarContext, itemId: string): Promise<void> {
  if (!(await store.deleteCalendarItem(ctx.project.projectId, itemId))) throw notFound();
}

export async function addComment(ctx: CalendarContext, itemId: string, body: string): Promise<CalendarComment> {
  const item = await store.getCalendarItem(ctx.project.projectId, itemId);
  if (!item) throw notFound();
  const actor = ctx.actor;
  const row = await store.insertCalendarComment({
    itemId: item.itemId,
    projectId: ctx.project.projectId,
    body: body.trim(),
    authorUserId: actor.kind === 'person' ? actor.userId : null,
    authorAgent: actor.kind === 'agent' ? actor.agent : null,
    authorSessionId: actor.kind === 'agent' ? actor.sessionId : null,
  });
  await notifyPeople(ctx, item, {
    assigned: null,
    mentioned: await mentionedPeople(ctx, row.body, ''),
    key: `comment:${row.commentId}`,
    excerpt: row.body,
    comment: true,
  });
  await wakeCreatorSession(ctx, item, async () => `${await actorName(ctx)} commented on “${item.title}”:\n\n${row.body}`, `comment:${row.commentId}`);
  return serializeCalendarComment(row);
}

// ─── Notifications and the agent loop ──────────────────────────────────────

/** People @mentioned in `text` and not already in `previous`. No roster read when the text has no @. */
async function mentionedPeople(ctx: CalendarContext, text: string, previous: string): Promise<string[]> {
  if (!text.includes('@')) return [];
  const before = mentionTokens(previous);
  const fresh = [...mentionTokens(text)].filter((token) => !before.has(token));
  if (fresh.length === 0) return [];
  try {
    const people = await projectMentionCandidates(ctx.project);
    const hits = resolveMentions(fresh.map((token) => `@${token}`).join(' '), people, []);
    return [...new Set(hits.flatMap((m) => (m.kind === 'person' && m.userId ? [m.userId] : [])))];
  } catch (error) {
    logger.warn('[calendar] mentions were not read; nobody is notified', { projectId: ctx.project.projectId, error: errorMessage(error) });
    return [];
  }
}

async function actorName(ctx: CalendarContext): Promise<string> {
  const actor = ctx.actor;
  if (actor.kind === 'agent') return isMyKortixAgentName(actor.agent) ? 'Kortix' : actor.agent;
  const who = (await resolveUserIdentities([actor.userId])).get(actor.userId);
  return who?.displayName?.trim() || who?.email?.split('@')[0] || 'Someone';
}

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

/**
 * One `mention` row per person: assigned or mentioned by someone else. The
 * dedupe key is per event, so a retry of the same write notifies nobody twice.
 */
async function notifyPeople(
  ctx: CalendarContext,
  item: store.CalendarItemRow,
  event: { assigned: string | null; mentioned: string[]; key: string; excerpt: string; comment?: boolean },
): Promise<void> {
  const self = ctx.actor.kind === 'person' ? ctx.actor.userId : null;
  const assigned = event.assigned && event.assigned !== self ? event.assigned : null;
  const mentioned = event.mentioned.filter((id) => id !== self && id !== assigned);
  if (!assigned && mentioned.length === 0) return;
  try {
    const name = await actorName(ctx);
    const allowed = new Set(await filterProjectRecipients(ctx.project.accountId, ctx.project.projectId, [...(assigned ? [assigned] : []), ...mentioned]));
    const send = (recipients: string[], body: string, kind: string) =>
      recipients.length === 0
        ? Promise.resolve()
        : deliver({
          kind: 'mention',
          accountId: ctx.project.accountId,
          projectId: ctx.project.projectId,
          calendarItemId: item.itemId,
          title: item.title,
          body,
          actorUserId: self,
          dedupeKey: `calendar:${item.itemId}:${event.key}:${kind}`,
          recipients,
        });
    await Promise.all([
      send(assigned && allowed.has(assigned) ? [assigned] : [], `${name} assigned this to you`, 'assigned'),
      send(
        mentioned.filter((id) => allowed.has(id)),
        event.comment ? `${name}: ${clip(event.excerpt, 240)}` : `${name} mentioned you: ${clip(event.excerpt, 200)}`,
        'mentioned',
      ),
    ]);
  } catch (error) {
    logger.warn('[calendar] notification failed', { itemId: item.itemId, error: errorMessage(error) });
  }
}

/**
 * Deliver a person's reply into the agent session that created the item, so
 * the agent continues. Only a person wakes it, and only one who may prompt
 * that session. Never throws.
 */
async function wakeCreatorSession(ctx: CalendarContext, item: store.CalendarItemRow, message: () => Promise<string>, key: string): Promise<void> {
  const actor = ctx.actor;
  const sessionId = item.createdBySessionId;
  if (actor.kind !== 'person' || !sessionId || !item.createdByAgent) return;
  try {
    const allowed = await mayPromptSessions(actor.userId, ctx.project.accountId, [sessionId]);
    if (!allowed.has(sessionId)) return;
    await deliverThroughQueue(
      {
        source: 'system:calendar',
        projectId: ctx.project.projectId,
        sessionId,
        userId: actor.userId,
        bindTurnIdentity: true,
        text: `[Calendar · ${item.itemId}] ${await message()}\n\nRead it with \`kortix calendar show ${item.itemId}\`; answer with \`kortix calendar comment ${item.itemId} "…"\`.`,
        idempotencyKey: `calendar:${item.itemId}:${key}`,
      },
      { wait: false },
    );
  } catch (error) {
    logger.warn('[calendar] the reply did not reach the agent session', { itemId: item.itemId, sessionId, error: errorMessage(error) });
  }
}
