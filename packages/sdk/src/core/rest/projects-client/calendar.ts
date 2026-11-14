/**
 * Calendar (project flag `calendar`): a workspace's shared calendar of dated
 * items with an owner and comments (`/v1/workspaces/:workspaceId/calendar/*`).
 *
 * Every person and agent that can open the workspace reads and writes every
 * item. The server derives the author from the credential: a session
 * credential is its agent, anything else a person.
 *
 * Someone else who `@mentions` a person (notes or comment) or assigns them an
 * item sends that person a `mention` notification. A person's comment on an
 * item an agent session created is delivered into that session.
 *
 * Scheduled triggers and Loops are not calendar items: read their fires from
 * {@link listUnifiedTriggers}.
 */

import { backendApi } from '../../http/api-client';
import { appendQuery } from '../../http/url';
import { unwrap } from './shared';

/** `open` waits on its owner; `done` is finished. */
export type CalendarItemStatus = 'open' | 'done';

/** Who wrote an item or a comment: a person, or an agent from one of its sessions. */
export type CalendarAuthor =
  | { kind: 'person'; user_id: string }
  | { kind: 'agent'; agent: string; session_id: string | null };

/** Who owns an item: one person or one agent of the workspace. */
export type CalendarAssignee = { kind: 'person'; user_id: string } | { kind: 'agent'; agent: string };

/** One calendar item. */
export interface CalendarItem {
  item_id: string;
  project_id: string;
  title: string;
  notes: string;
  /** ISO time, or null for no date. With `all_day`, UTC midnight of the date: read its UTC date. */
  starts_at: string | null;
  all_day: boolean;
  status: CalendarItemStatus;
  assignee: CalendarAssignee | null;
  created_by: CalendarAuthor;
  comment_count: number;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** One comment on a calendar item. */
export interface CalendarComment {
  comment_id: string;
  item_id: string;
  body: string;
  author: CalendarAuthor;
  created_at: string;
}

/**
 * Who to assign. `me`: the caller (a person, or the calling session's agent).
 * `email`: a person of the workspace by email.
 */
export type CalendarAssigneeInput = { user_id: string } | { email: string } | { agent: string } | { me: true };

/** A person who can be assigned or mentioned. `@handle` names exactly this person. */
export interface CalendarPerson {
  user_id: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
  handle: string;
}

export interface CalendarPeople {
  people: CalendarPerson[];
  /** The workspace's agents by kortix.yaml name. */
  agents: Array<{ name: string }>;
}

export interface CalendarListQuery {
  /** ISO time: the first instant of the window. */
  from?: string;
  /** ISO time: the end of the window (exclusive). At most 93 days after `from`. */
  to?: string;
  /** `me`, `user:<id>` or `agent:<name>`. */
  assignee?: string;
  status?: CalendarItemStatus;
  /** False leaves out the open items with no date. Default true. */
  undated?: boolean;
}

export interface CreateCalendarItemInput {
  title: string;
  notes?: string;
  /** ISO time with an offset. Omitted or null: no date. */
  starts_at?: string | null;
  /** The date only: the server keeps the calendar date of `starts_at` as written. */
  all_day?: boolean;
  assignee?: CalendarAssigneeInput | null;
  status?: CalendarItemStatus;
}

/** Only the fields given change. `starts_at: null` removes the date; `assignee: null` the owner. */
export type UpdateCalendarItemInput = Partial<CreateCalendarItemInput>;

const calendarPath = (projectId: string) => `/workspaces/${projectId}/calendar`;
const itemPath = (projectId: string, itemId: string) => `${calendarPath(projectId)}/${encodeURIComponent(itemId)}`;

/** Items dated in the window (time order), then open items with no date (newest first). */
export async function listWorkspaceCalendarItems(projectId: string, query: CalendarListQuery = {}): Promise<CalendarItem[]> {
  const suffix = appendQuery({
    from: query.from,
    to: query.to,
    assignee: query.assignee,
    status: query.status,
    undated: query.undated === false ? 'false' : undefined,
  });
  return unwrap(await backendApi.get<{ items: CalendarItem[] }>(`${calendarPath(projectId)}${suffix}`)).items;
}

/** One item and its comments, oldest first. */
export async function getWorkspaceCalendarItem(projectId: string, itemId: string): Promise<{ item: CalendarItem; comments: CalendarComment[] }> {
  return unwrap(await backendApi.get<{ item: CalendarItem; comments: CalendarComment[] }>(itemPath(projectId, itemId)));
}

export async function createWorkspaceCalendarItem(projectId: string, input: CreateCalendarItemInput): Promise<CalendarItem> {
  return unwrap(await backendApi.post<{ item: CalendarItem }>(calendarPath(projectId), input)).item;
}

export async function updateWorkspaceCalendarItem(projectId: string, itemId: string, input: UpdateCalendarItemInput): Promise<CalendarItem> {
  return unwrap(await backendApi.patch<{ item: CalendarItem }>(itemPath(projectId, itemId), input)).item;
}

/** Deletes the item and its comments. */
export async function deleteWorkspaceCalendarItem(projectId: string, itemId: string): Promise<void> {
  unwrap(await backendApi.delete<{ deleted: true }>(itemPath(projectId, itemId)));
}

export async function addWorkspaceCalendarComment(projectId: string, itemId: string, body: string): Promise<CalendarComment> {
  return unwrap(await backendApi.post<{ comment: CalendarComment }>(`${itemPath(projectId, itemId)}/comments`, { body })).comment;
}

/** The people who can be assigned or mentioned, and the agents. */
export async function listWorkspaceCalendarPeople(projectId: string): Promise<CalendarPeople> {
  return unwrap(await backendApi.get<CalendarPeople>(`${calendarPath(projectId)}/people`));
}
