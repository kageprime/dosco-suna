/**
 * Calendar: `/v1/workspaces/:workspaceId/calendar/*` (project flag `calendar`).
 *
 * A workspace's shared calendar. An item has a title, notes, an optional date
 * (or a start time and an optional end time), the people on it (persons and
 * agents alike), a status (`open` or `done`) and a flat list of comments. Every person and agent that
 * can open the workspace reads and writes every item.
 *
 * The API derives who calls from the credential: a session credential is its
 * agent (`{ kind: 'agent', agent, session_id }`), anything else a person. A
 * body never names the author.
 *
 * Notifications: someone else who `@mentions` a person (in the notes or a
 * comment) or adds them to an item sends that person a `mention`
 * notification. A person's comment on an item an agent session created, and a
 * person marking it done or open again, is delivered into that session when
 * the person may prompt it.
 *
 * Scheduled triggers and Loops are not items: clients compute their fires
 * from `GET /triggers/all`.
 *
 * Errors: `403 feature_disabled` (flag off), `404 calendar_not_found`,
 * `422 calendar_invalid` (with `violations`).
 */
import { z } from 'zod';

export const CALENDAR_LIMITS = {
  title_chars: 200,
  notes_chars: 10_000,
  comment_chars: 4_000,
  /** Widest `from`..`to` window one list call reads. */
  range_days: 93,
  /** Most dated items one list call returns. */
  list_items: 500,
  /** Most undated (`No date`) items one list call returns. */
  undated_items: 200,
  /** Most comments one item read returns, oldest first. */
  comments: 500,
  /** Most people on one item. */
  people: 50,
} as const;

export const CalendarItemStatusSchema = z.enum(['open', 'done']);
export type CalendarItemStatus = z.infer<typeof CalendarItemStatusSchema>;

/** Who wrote an item or a comment: a person, or an agent from one of its sessions. */
export const CalendarAuthorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('person'), user_id: z.string() }),
  z.object({ kind: z.literal('agent'), agent: z.string(), session_id: z.string().nullable() }),
]);
export type CalendarAuthor = z.infer<typeof CalendarAuthorSchema>;

/** One of the people on an item: a person, or an agent of the workspace. */
export const CalendarParticipantSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('person'), user_id: z.string() }),
  z.object({ kind: z.literal('agent'), agent: z.string() }),
]);
export type CalendarParticipant = z.infer<typeof CalendarParticipantSchema>;

export const CalendarItemSchema = z.object({
  item_id: z.string(),
  project_id: z.string(),
  title: z.string(),
  notes: z.string(),
  /** ISO time. Null: no date. With `all_day`, UTC midnight of the date: read its UTC date. */
  starts_at: z.string().nullable(),
  /** ISO time: the end of a timed item. Null for an all-day item, an undated item or a point in time. */
  ends_at: z.string().nullable(),
  all_day: z.boolean(),
  status: CalendarItemStatusSchema,
  /** Persons and agents alike, in the order they were added. */
  people: z.array(CalendarParticipantSchema),
  created_by: CalendarAuthorSchema,
  comment_count: z.number().int(),
  completed_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type CalendarItem = z.infer<typeof CalendarItemSchema>;

export const CalendarCommentSchema = z.object({
  comment_id: z.string(),
  item_id: z.string(),
  body: z.string(),
  author: CalendarAuthorSchema,
  created_at: z.string(),
});
export type CalendarComment = z.infer<typeof CalendarCommentSchema>;

/**
 * One person or agent to put on an item. `me`: the caller (a person, or the
 * calling session's agent). `email`: a person of the workspace by email.
 */
export const CalendarParticipantInputSchema = z.union([
  z.object({ user_id: z.string().uuid() }).strict(),
  z.object({ email: z.string().email().max(320) }).strict(),
  z.object({ agent: z.string().min(1).max(128) }).strict(),
  z.object({ me: z.literal(true) }).strict(),
]);
export type CalendarParticipantInput = z.infer<typeof CalendarParticipantInputSchema>;

const startsAt = z.string().datetime({ offset: true }).nullable();
/** At most this many people on one item. */
const people = z.array(CalendarParticipantInputSchema).max(CALENDAR_LIMITS.people);

export const CreateCalendarItemRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(CALENDAR_LIMITS.title_chars),
    notes: z.string().max(CALENDAR_LIMITS.notes_chars).optional(),
    /** ISO time with an offset. Omitted or null: no date. */
    starts_at: startsAt.optional(),
    /** ISO time with an offset, after `starts_at`. Only for a timed item. */
    ends_at: startsAt.optional(),
    /** The date only: `starts_at` is cut to its UTC date. */
    all_day: z.boolean().optional(),
    people: people.optional(),
    status: CalendarItemStatusSchema.optional(),
  })
  .strict();
export type CreateCalendarItemRequest = z.infer<typeof CreateCalendarItemRequestSchema>;

export const UpdateCalendarItemRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(CALENDAR_LIMITS.title_chars).optional(),
    notes: z.string().max(CALENDAR_LIMITS.notes_chars).optional(),
    starts_at: startsAt.optional(),
    ends_at: startsAt.optional(),
    all_day: z.boolean().optional(),
    /** Replaces the whole list. Omitted: unchanged. `[]`: nobody. */
    people: people.optional(),
    status: CalendarItemStatusSchema.optional(),
  })
  .strict();
export type UpdateCalendarItemRequest = z.infer<typeof UpdateCalendarItemRequestSchema>;

export const CreateCalendarCommentRequestSchema = z
  .object({ body: z.string().trim().min(1).max(CALENDAR_LIMITS.comment_chars) })
  .strict();
export type CreateCalendarCommentRequest = z.infer<typeof CreateCalendarCommentRequestSchema>;

export const CalendarListResponseSchema = z.object({ items: z.array(CalendarItemSchema) });
export type CalendarListResponse = z.infer<typeof CalendarListResponseSchema>;

export const CalendarItemResponseSchema = z.object({ item: CalendarItemSchema });
export type CalendarItemResponse = z.infer<typeof CalendarItemResponseSchema>;

export const CalendarItemDetailResponseSchema = z.object({
  item: CalendarItemSchema,
  comments: z.array(CalendarCommentSchema),
});
export type CalendarItemDetailResponse = z.infer<typeof CalendarItemDetailResponseSchema>;

export const CalendarCommentResponseSchema = z.object({ comment: CalendarCommentSchema });
export type CalendarCommentResponse = z.infer<typeof CalendarCommentResponseSchema>;

/** A person who can be assigned or mentioned. `handle` is what `@handle` matches first. */
export const CalendarPersonSchema = z.object({
  user_id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  avatar_url: z.string().nullable(),
  handle: z.string(),
});
export type CalendarPerson = z.infer<typeof CalendarPersonSchema>;

export const CalendarPeopleResponseSchema = z.object({
  people: z.array(CalendarPersonSchema),
  /** The workspace's agents by kortix.yaml name. */
  agents: z.array(z.object({ name: z.string() })),
});
export type CalendarPeopleResponse = z.infer<typeof CalendarPeopleResponseSchema>;

export const CalendarErrorSchema = z.object({
  error: z.enum(['calendar_not_found', 'calendar_invalid', 'feature_disabled']),
  message: z.string(),
  violations: z.array(z.string()).optional(),
});
export type CalendarError = z.infer<typeof CalendarErrorSchema>;
