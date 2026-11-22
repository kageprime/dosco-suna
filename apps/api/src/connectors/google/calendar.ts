/**
 * Kortix Google Calendar MCP server tools. Names and arguments follow
 * Composio's Google Calendar toolkit (`events_list`, `create_event`,
 * `find_free_slots`, …); see ./tool.ts. Where Composio named an argument in
 * Google's camelCase (`calendarId`), the snake_case name works too, and the
 * other way round. Every paginated tool takes `pageToken` and `page_token`.
 *
 * Scope: `calendar` (every calendar, event, sharing rule and setting the
 * account can reach). `list_buildings` and `list_calendar_resources` call the
 * Admin SDK Directory API, which needs a Workspace admin scope this connector
 * does not ask for: Google answers them with 403.
 *
 * Times: a date-time with `Z` or an offset is an exact instant. One without
 * is read in the tool's time zone argument, else in the calendar's own time
 * zone; a time filter read that way says so in `composio_execution_message`.
 * A date alone (`2026-01-19`) is an all-day value.
 */
import { GoogleApiError } from './client';
import {
  DESTRUCTIVE,
  READ,
  ToolInputError,
  WRITE,
  anyObj,
  arr,
  b,
  i,
  mapLimit,
  optBool,
  optInt,
  optObj,
  optStr,
  pick,
  reqStr,
  s,
  schema,
  strList,
  strs,
  type GoogleTool,
  type ToolContext,
} from './tool';

const CAL = 'https://www.googleapis.com/calendar/v3';
const CALENDAR_LIST = `${CAL}/users/me/calendarList`;
const SETTINGS = `${CAL}/users/me/settings`;
const ADMIN = 'https://admin.googleapis.com/admin/directory/v1/customer';
const WEB = 'https://calendar.google.com/calendar/r';
const SETTINGS_URL = `${WEB}/settings`;

const CALENDAR_CONCURRENCY = 5;
const BATCH_CONCURRENCY = 5;
const BATCH_GROUP = 50;
const MAX_BATCH_OPERATIONS = 1000;
const MAX_EVENTS_PER_CALENDAR = 1000;
const MAX_LISTED_CALENDARS = 1000;
const MAX_FREEBUSY_DAYS = 90;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const FIND_EVENT_TYPES = ['birthday', 'default', 'focusTime', 'outOfOffice', 'workingLocation'];
const SEND_UPDATES = ['all', 'externalOnly', 'none'];

type Json = Record<string, unknown>;

interface EventTime {
  date?: string | null;
  dateTime?: string | null;
  timeZone?: string | null;
}

interface CalendarEvent {
  id?: string;
  htmlLink?: string;
  summary?: string;
  iCalUID?: string;
  eventType?: string;
  start?: EventTime;
  end?: EventTime;
  originalStartTime?: EventTime;
  attendees?: Json[];
  conferenceData?: Json;
  [key: string]: unknown;
}

interface CalendarEntry {
  id: string;
  summary?: string;
  summaryOverride?: string;
  timeZone?: string;
  primary?: boolean;
  [key: string]: unknown;
}

interface CalendarMeta {
  id?: string;
  summary?: string;
  timeZone?: string;
}

interface EventPage {
  items?: CalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
  [key: string]: unknown;
}

// ─── Small helpers ──────────────────────────────────────────────────────────

const pad = (value: number) => String(value).padStart(2, '0');
const enc = encodeURIComponent;
const calendarPath = (id: string) => `${CAL}/calendars/${enc(id)}`;
const eventsPath = (calendar: string) => `${calendarPath(calendar)}/events`;
const eventPath = (calendar: string, id: string) => `${eventsPath(calendar)}/${enc(id)}`;

/** The calendar in Google Calendar's web UI. */
const calendarUrl = (id: string | undefined) => (id ? `${WEB}?cid=${enc(id)}` : WEB);
const withEventUrl = (event: CalendarEvent | null): Json => ({ ...event, display_url: event?.htmlLink ?? '' });
const withCalendarUrl = (calendar: Json | null, id?: string): Json => ({
  ...calendar,
  display_url: calendarUrl(typeof calendar?.id === 'string' ? calendar.id : id),
});

function withNotes(result: Json, notes: readonly string[]): Json {
  return notes.length ? { ...result, composio_execution_message: notes.join(' ') } : result;
}

/** `work` runs on the first call only; later calls share its promise. */
function once<T>(work: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | undefined;
  return () => (promise ??= work());
}

// ─── Argument readers ───────────────────────────────────────────────────────

/** `calendar_id` or `calendarId`; `primary` when absent. */
function calendarArg(args: Json): string {
  const id = optStr(args, 'calendar_id', 'calendarId')?.trim();
  // A Composio connection id (`ca_…`) is not a calendar: Composio read it as primary.
  return !id || id.startsWith('ca_') ? 'primary' : id;
}

const eventArg = (args: Json) => reqStr(args, 'event_id', 'eventId');
const pageToken = (args: Json) => optStr(args, 'pageToken', 'page_token');
const syncToken = (args: Json) => optStr(args, 'syncToken', 'sync_token');
const sendUpdates = (args: Json) => optStr(args, 'send_updates', 'sendUpdates');

function flag(args: Json, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return undefined;
}

function int(args: Json, keys: readonly string[], max?: number): number | undefined {
  for (const key of keys) {
    const value = optInt(args, key, undefined, max);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** A string or a list of strings, unsplit (extended-property filters may contain commas). */
function stringOrList(value: unknown): string[] | undefined {
  if (typeof value === 'string' && value.trim() !== '') return [value.trim()];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  return undefined;
}

// ─── Time zones and date-times ──────────────────────────────────────────────

function checkZone(zone: string, field: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    throw new ToolInputError(`${field} must be an IANA time zone such as Europe/Berlin or America/New_York, not ${zone}`);
  }
}

function zoneArg(args: Json, ...keys: string[]): string | undefined {
  const value = optStr(args, ...keys)?.trim();
  return value ? checkZone(value, keys[0] ?? 'timezone') : undefined;
}

interface Wall {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  /** Minutes east of UTC; `null` when the text had no offset. */
  offset: number | null;
  dateOnly: boolean;
}

/** The wall-clock reading of instant `ms` in `zone`. */
function wallClock(ms: number, zone: string): Omit<Wall, 'offset' | 'dateOnly'> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: part('year'), mo: part('month'), d: part('day'), h: part('hour') % 24, mi: part('minute'), s: part('second') };
}

function offsetMinutes(ms: number, zone: string): number {
  const w = wallClock(ms, zone);
  return Math.round((Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000) / MINUTE_MS);
}

function offsetText(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** RFC 3339 with the zone's offset at that instant: `2026-01-19T09:00:00-08:00`. */
function formatInZone(ms: number, zone: string): string {
  const w = wallClock(ms, zone);
  return `${w.y}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}${offsetText(offsetMinutes(ms, zone))}`;
}

const DATE_TIME = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?)?\s*(Z|[+-]\d{1,2}(?::?\d{2})?)?$/i;
const OFFSET = /^([+-])(\d{1,2}):?(\d{2})?$/;

function offsetOf(text: string): number | null {
  if (/^z$/i.test(text)) return 0;
  const match = OFFSET.exec(text);
  if (!match) return null;
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
  return minutes > 14 * 60 ? null : (match[1] === '-' ? -1 : 1) * minutes;
}

function validWall(w: Wall): boolean {
  const day = new Date(Date.UTC(w.y, w.mo - 1, w.d));
  return day.getUTCMonth() === w.mo - 1 && day.getUTCDate() === w.d && w.h < 24 && w.mi < 60 && w.s < 60;
}

/**
 * An ISO 8601 date-time (`2026-01-19T09:00:00`, `…Z`, `…-08:00`, a space for
 * `T`), a date (`2026-01-19`), or Composio's comma form (`2026,1,19,9,0,0`).
 */
function parseWall(value: string, field: string): Wall {
  const text = value.trim();
  let wall: Wall | null = null;
  if (/^\d{4}(?:\s*,\s*\d{1,2}){2,5}$/.test(text)) {
    const [y = 0, mo = 1, d = 1, h, mi = 0, sec = 0] = text.split(',').map((part) => Number(part.trim()));
    wall = { y, mo, d, h: h ?? 0, mi, s: sec, offset: null, dateOnly: h === undefined };
  } else {
    const m = DATE_TIME.exec(text);
    const offset = m?.[7] ? offsetOf(m[7]) : null;
    if (m && (!m[7] || offset !== null)) {
      wall = { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]), h: Number(m[4] ?? 0), mi: Number(m[5] ?? 0), s: Number(m[6] ?? 0), offset, dateOnly: m[4] === undefined };
    }
  }
  if (!wall || !validWall(wall)) {
    throw new ToolInputError(`${field} must be an ISO 8601 date-time such as 2026-01-19T09:00:00 or 2026-01-19T09:00:00-08:00, not ${value}`);
  }
  return wall;
}

function wallText(w: Wall): string {
  const date = `${w.y}-${pad(w.mo)}-${pad(w.d)}`;
  if (w.dateOnly) return date;
  const zone = w.offset === null ? '' : w.offset === 0 ? 'Z' : offsetText(w.offset);
  return `${date}T${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}${zone}`;
}

/** The instant of a wall reading: its own offset, else read in `zone`. */
function wallInstant(w: Wall, zone: string): number {
  const local = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  if (w.offset !== null) return local - w.offset * MINUTE_MS;
  const guess = local - offsetMinutes(local, zone) * MINUTE_MS;
  return local - offsetMinutes(guess, zone) * MINUTE_MS;
}

/** Wall-clock arithmetic: the offset text, if any, stays. */
function addMinutes(w: Wall, minutes: number): Wall {
  const t = new Date(Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) + minutes * MINUTE_MS);
  return { ...w, y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), s: t.getUTCSeconds(), dateOnly: false };
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function dateArg(value: string, field: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  if (!match?.[1] || Number.isNaN(Date.parse(`${match[1]}T00:00:00Z`))) throw new ToolInputError(`${field} must be a date such as 2026-01-19, not ${value}`);
  return match[1];
}

/** The start of an event as epoch ms; an all-day start is midnight in `zone`. */
function eventInstant(time: EventTime | undefined, zone: string): number {
  if (time?.dateTime) return Date.parse(time.dateTime);
  if (time?.date) return wallInstant(parseWall(time.date, 'date'), zone);
  return 0;
}

/** calendars.get; `null` when the account cannot read the calendar. */
const readCalendar = (ctx: ToolContext, id: string) => ctx.google.json<CalendarMeta>({ url: calendarPath(id) }).catch(() => null);

/** The zone naive times are read in: `explicit`, else the calendar's, else UTC. Looked up at most once. */
function zoneFor(ctx: ToolContext, explicit: string | undefined, calendar: string): () => Promise<string> {
  return once(async () => explicit ?? (await readCalendar(ctx, calendar))?.timeZone ?? 'UTC');
}

/** An RFC 3339 instant for a Google time filter. A value without an offset is read in `zone()`. */
async function filterTime(value: string | undefined, field: string, zone: () => Promise<string>, notes: string[]): Promise<string | undefined> {
  if (!value) return undefined;
  const wall = parseWall(value, field);
  if (wall.offset !== null && !wall.dateOnly) return wallText(wall);
  const tz = await zone();
  const instant = formatInZone(wallInstant(wall, tz), tz);
  notes.push(`${field} ${value} has no UTC offset, so it was read in ${tz} as ${instant}.`);
  return instant;
}

// ─── Event bodies ───────────────────────────────────────────────────────────

/** Google event field, then the argument names that set it (Composio's first). */
const EVENT_FIELDS: ReadonlyArray<readonly [string, ...string[]]> = [
  ['summary', 'summary'],
  ['description', 'description'],
  ['location', 'location'],
  ['status', 'status'],
  ['visibility', 'visibility'],
  ['transparency', 'transparency'],
  ['colorId', 'color_id', 'colorId'],
  ['sequence', 'sequence'],
  ['source', 'source'],
  ['reminders', 'reminders'],
  ['attachments', 'attachments'],
  ['guestsCanModify', 'guestsCanModify', 'guests_can_modify'],
  ['guestsCanInviteOthers', 'guestsCanInviteOthers', 'guests_can_invite_others'],
  ['guestsCanSeeOtherGuests', 'guestsCanSeeOtherGuests', 'guests_can_see_other_guests'],
  ['anyoneCanAddSelf', 'anyone_can_add_self', 'anyoneCanAddSelf'],
  ['attendeesOmitted', 'attendees_omitted', 'attendeesOmitted'],
  ['extendedProperties', 'extended_properties', 'extendedProperties'],
  ['birthdayProperties', 'birthdayProperties', 'birthday_properties'],
  ['focusTimeProperties', 'focusTimeProperties', 'focus_time_properties'],
  ['outOfOfficeProperties', 'outOfOfficeProperties', 'out_of_office_properties'],
  ['workingLocationProperties', 'workingLocationProperties', 'working_location_properties'],
  ['conferenceData', 'conference_data', 'conferenceData'],
];

/** Fields that take an object; a JSON string is parsed. */
const OBJECT_FIELDS = ['source', 'reminders', 'extendedProperties', 'birthdayProperties', 'focusTimeProperties', 'outOfOfficeProperties', 'workingLocationProperties', 'conferenceData'];

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/** Attendees from emails (`Ada <ada@example.com>` works) or attendee objects. */
function attendeeList(value: unknown): Json[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const items: unknown[] = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [value];
  return items.flatMap((item, index): Json[] => {
    if (item && typeof item === 'object' && !Array.isArray(item) && typeof (item as Json).email === 'string') return [{ ...(item as Json) }];
    if (typeof item !== 'string') throw new ToolInputError(`attendees[${index}] must be an email address or an object with email`);
    const text = item.trim();
    if (!text) return [];
    const named = /^(.*?)\s*<([^>]+)>$/.exec(text);
    const email = (named?.[2] ?? text).trim();
    if (!EMAIL.test(email)) throw new ToolInputError(`attendees[${index}] must be an email address, not "${text}"`);
    const name = named?.[1]?.replace(/^"|"$/g, '').trim();
    return [{ email, ...(name ? { displayName: name } : {}) }];
  });
}

/** RRULE/EXRULE/RDATE/EXDATE lines. A bare `FREQ=…` gets `RRULE:`; a timed UNTIL gets its missing `Z`, as Composio did. */
function recurrenceLines(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const lines: unknown[] | null = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\r?\n/) : null;
  if (!lines) throw new ToolInputError('recurrence must be a list of RRULE, EXRULE, RDATE or EXDATE lines');
  return lines
    .filter((line): line is string => typeof line === 'string' && line.trim() !== '')
    .map((line) => {
      const text = line.trim();
      const rule = /^FREQ=/i.test(text) ? `RRULE:${text}` : text;
      return rule.replace(/(UNTIL=\d{8}T\d{6})(?!Z)/i, '$1Z');
    });
}

/** The Google event fields the arguments set, except start and end. */
function eventFields(args: Json): Json {
  const body: Json = {};
  for (const [field, ...keys] of EVENT_FIELDS) {
    const key = keys.find((k) => args[k] !== undefined && args[k] !== null);
    if (key === undefined) continue;
    body[field] = OBJECT_FIELDS.includes(field) ? (optObj(args, key) ?? args[key]) : args[key];
  }
  const recurrence = recurrenceLines(args.recurrence);
  if (recurrence) body.recurrence = recurrence;
  const attendees = attendeeList(args.attendees);
  if (attendees) body.attendees = attendees;
  return body;
}

/** event_duration_hour + event_duration_minutes in minutes; `undefined` when neither is set. */
function durationArg(args: Json): number | undefined {
  const hours = optInt(args, 'event_duration_hour');
  const minutes = optInt(args, 'event_duration_minutes');
  if (hours === undefined && minutes === undefined) return undefined;
  const total = (hours ?? 0) * 60 + (minutes ?? (hours ? 0 : 30));
  if (total <= 0) throw new ToolInputError('event_duration_hour and event_duration_minutes must add up to more than 0');
  return total;
}

/** The length of a timed event in minutes. */
function eventMinutes(event: CalendarEvent | null): number | undefined {
  const start = event?.start?.dateTime;
  const end = event?.end?.dateTime;
  if (!start || !end) return undefined;
  const minutes = Math.round((Date.parse(end) - Date.parse(start)) / MINUTE_MS);
  return minutes > 0 ? minutes : undefined;
}

interface Window {
  start: EventTime;
  end: EventTime;
}

function allDayWindow(startText: string, endText: string | undefined): Window {
  const start = dateArg(startText, 'start_date');
  const end = endText ? dateArg(endText, 'end_date') : addDays(start, 1);
  if (end <= start) throw new ToolInputError(`end_date is exclusive, so it must be after start_date: a one-day event on ${start} ends ${addDays(start, 1)}`);
  return { start: { date: start }, end: { date: end } };
}

/** start/end for create_event and update_event: timed from start_datetime, all-day from start_date. */
async function eventWindow(args: Json, zone: () => Promise<string>, minutes: () => number): Promise<Window> {
  const startText = optStr(args, 'start_datetime');
  if (!startText) {
    const startDate = optStr(args, 'start_date');
    if (startDate) return allDayWindow(startDate, optStr(args, 'end_date'));
    const rawStart = optObj(args, 'start');
    const rawEnd = optObj(args, 'end');
    if (rawStart && rawEnd) return { start: rawStart as EventTime, end: rawEnd as EventTime };
    throw new ToolInputError('start_datetime (a timed event) or start_date (an all-day event) is required');
  }
  const start = parseWall(startText, 'start_datetime');
  if (start.dateOnly) return allDayWindow(startText, optStr(args, 'end_date', 'end_datetime'));
  const endText = optStr(args, 'end_datetime');
  const end = endText ? parseWall(endText, 'end_datetime') : addMinutes(start, minutes());
  if (end.dateOnly) throw new ToolInputError('end_datetime needs a time of day, such as 2026-01-19T10:00:00');
  const tz = await zone();
  if (wallInstant(end, tz) <= wallInstant(start, tz)) throw new ToolInputError('end_datetime must be after start_datetime');
  return { start: { dateTime: wallText(start), timeZone: tz }, end: { dateTime: wallText(end), timeZone: tz } };
}

const meetRequest = () => ({ createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } });

/** Send with a Meet request; when Google refuses conferencing for this account, send again without one, as Composio did. */
async function withMeetFallback(meet: boolean, send: (withMeet: boolean) => Promise<CalendarEvent>): Promise<{ event: CalendarEvent; note?: string }> {
  if (!meet) return { event: await send(false) };
  try {
    return { event: await send(true) };
  } catch (error) {
    if (!(error instanceof GoogleApiError) || error.status !== 400 || !/conference/i.test(error.message)) throw error;
    return { event: await send(false), note: `Google could not add a Meet link for this account (${error.message}), so the event has none.` };
  }
}

// ─── Shared schema pieces ───────────────────────────────────────────────────

const CALENDAR_ID = s('Calendar id: `primary` or an id from list_calendars.', { default: 'primary' });
const SEND_UPDATES_PROP = s('Who gets an email about the change: all, externalOnly or none.', { enum: SEND_UPDATES });
const TIMEZONE = s('IANA time zone, such as America/New_York, for date-times without an offset. Default: the calendar\'s time zone.');
const ATTENDEES = arr(
  { anyOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }] },
  'Guests: email addresses, or objects {email, optional, displayName, comment, additionalGuests, resource}.',
);
const RECURRENCE = strs('RRULE, EXRULE, RDATE or EXDATE lines, such as `RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10`. An empty list makes the event single.');
const STRING_OR_LIST = [{ type: 'string' }, { type: 'array', items: { type: 'string' } }];
const PAGE_TOKEN = s('nextPageToken of the previous page. `page_token` is an alias.');
const PAGE_TOKEN_SNAKE = s('nextPageToken of the previous page. `pageToken` is an alias.');
const EVENT_TYPE_PROPS = {
  birthdayProperties: anyObj('For eventType birthday: {type, contact, customTypeName}.'),
  focusTimeProperties: anyObj('For eventType focusTime: {autoDeclineMode, declineMessage, chatStatus}.'),
  outOfOfficeProperties: anyObj('For eventType outOfOffice: {autoDeclineMode, declineMessage}.'),
  workingLocationProperties: anyObj('For eventType workingLocation: {type, homeOffice | officeLocation | customLocation}.'),
};

// ─── Events: read ───────────────────────────────────────────────────────────

/** Filters Google refuses next to a syncToken: label, then the argument names. */
const SYNC_CONFLICTS: ReadonlyArray<readonly string[]> = [
  ['query', 'q'],
  ['timeMin', 'time_min'],
  ['timeMax', 'time_max'],
  ['updatedMin', 'updated_min'],
  ['orderBy', 'order_by'],
  ['iCalUID'],
  ['privateExtendedProperty'],
  ['sharedExtendedProperty'],
];

const eventsList: GoogleTool = {
  name: 'events_list',
  title: 'List events',
  description:
    'List the events of one calendar, `primary` by default. Filter with timeMin/timeMax, query and eventTypes. ' +
    'singleEvents expands recurring events into occurrences; orderBy startTime sets it for you. ' +
    'Page with pageToken. With syncToken you get only the changes since an earlier full list.',
  inputSchema: schema({
    calendarId: s('Calendar id: `primary` or an id from list_calendars. `calendar_id` is an alias.', { default: 'primary' }),
    timeMin: s('Only events that end after this time, RFC 3339, such as 2026-01-19T00:00:00-08:00.'),
    timeMax: s('Only events that start before this time, RFC 3339.'),
    query: s('Free-text search over title, description, location and attendees.'),
    singleEvents: b('Expand recurring events into their occurrences.', { default: false }),
    orderBy: s('startTime or updated. startTime needs singleEvents, which is then set for you.', { enum: ['startTime', 'updated'] }),
    maxResults: i('Events per page, up to 2500. Google defaults to 250.'),
    pageToken: PAGE_TOKEN,
    syncToken: s('nextSyncToken of a previous full list: only changes since then. Time, text and order filters are dropped with it.'),
    timeZone: s('IANA time zone of the times in the answer. It also reads timeMin/timeMax without an offset.'),
    eventTypes: strs('Event types: default, birthday, focusTime, fromGmail, outOfOffice, workingLocation. All when omitted.'),
    showDeleted: b('Include cancelled events.'),
    showHiddenInvitations: b('Include hidden invitations.'),
    updatedMin: s('Only events changed after this time, RFC 3339.'),
    iCalUID: s('Only the event with this iCalendar UID.'),
    maxAttendees: i('At most this many attendees per event in the answer.'),
    privateExtendedProperty: { anyOf: STRING_OR_LIST, description: '`name=value` filters on private extended properties.' },
    sharedExtendedProperty: { anyOf: STRING_OR_LIST, description: '`name=value` filters on shared extended properties.' },
    fields: s('Partial-response selector, such as `items(id,summary,start,end),nextPageToken`.'),
    alwaysIncludeEmail: b('Ignored: Google deprecated it.'),
  }),
  annotations: READ,
  async run(args, ctx) {
    const calendar = calendarArg(args);
    const responseZone = zoneArg(args, 'timeZone', 'time_zone', 'timezone');
    const zone = zoneFor(ctx, responseZone, calendar);
    const notes: string[] = [];
    const sync = syncToken(args);
    const query: Json = {
      pageToken: pageToken(args),
      syncToken: sync,
      maxResults: int(args, ['maxResults', 'max_results'], 2500),
      singleEvents: flag(args, 'singleEvents', 'single_events'),
      timeZone: responseZone,
      eventTypes: strList(args, 'eventTypes', 'event_types'),
      showDeleted: flag(args, 'showDeleted', 'show_deleted'),
      showHiddenInvitations: flag(args, 'showHiddenInvitations', 'show_hidden_invitations'),
      maxAttendees: int(args, ['maxAttendees', 'max_attendees']),
      fields: optStr(args, 'fields'),
    };
    if (sync) {
      const dropped = SYNC_CONFLICTS.filter((keys) => keys.some((key) => args[key] !== undefined && args[key] !== null && args[key] !== '')).map((keys) => keys[0]);
      if (dropped.length) notes.push(`syncToken cannot be combined with ${dropped.join(', ')}, so they were dropped.`);
    } else {
      Object.assign(query, {
        q: optStr(args, 'query', 'q'),
        iCalUID: optStr(args, 'iCalUID', 'ical_uid'),
        orderBy: optStr(args, 'orderBy', 'order_by'),
        timeMin: await filterTime(optStr(args, 'timeMin', 'time_min'), 'timeMin', zone, notes),
        timeMax: await filterTime(optStr(args, 'timeMax', 'time_max'), 'timeMax', zone, notes),
        updatedMin: await filterTime(optStr(args, 'updatedMin', 'updated_min'), 'updatedMin', zone, notes),
        privateExtendedProperty: stringOrList(args.privateExtendedProperty),
        sharedExtendedProperty: stringOrList(args.sharedExtendedProperty),
      });
      if (query.orderBy === 'startTime' && query.singleEvents !== true) {
        if (query.singleEvents === false) notes.push('orderBy startTime needs singleEvents, so singleEvents was set to true.');
        query.singleEvents = true;
      }
    }
    const list = await ctx.google.json<Json>({ url: eventsPath(calendar), query });
    return withNotes(list ?? {}, notes);
  },
};

/** Every entry of the calendar list (hidden and deleted ones excluded), primary first. */
async function calendarEntries(ctx: ToolContext): Promise<CalendarEntry[]> {
  const entries: CalendarEntry[] = [];
  let token: string | undefined;
  do {
    const page = await ctx.google.json<{ items?: CalendarEntry[]; nextPageToken?: string }>({ url: CALENDAR_LIST, query: { maxResults: 250, pageToken: token } });
    entries.push(...(page?.items ?? []));
    token = page?.nextPageToken;
  } while (token && entries.length < MAX_LISTED_CALENDARS);
  return entries.sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)));
}

/** Pages of one calendar's events until `limit` or the last page. */
async function calendarEvents(ctx: ToolContext, calendar: string, query: Json, limit: number): Promise<CalendarEvent[]> {
  const events: CalendarEvent[] = [];
  let token: string | undefined;
  do {
    const page = await ctx.google.json<EventPage>({ url: eventsPath(calendar), query: { ...query, maxResults: Math.min(2500, limit - events.length), pageToken: token } });
    events.push(...(page?.items ?? []));
    token = page?.nextPageToken;
  } while (token && events.length < limit);
  return events;
}

const calendarName = (calendar: CalendarEntry) => calendar.summaryOverride ?? calendar.summary ?? calendar.id;

interface SourcedEvent {
  event: CalendarEvent;
  source_calendar_id: string;
  source_calendar_summary: string;
  all_calendar_ids: string[];
  at: number;
}

/** One entry per event (by iCalUID and start), sorted by start; `all_calendar_ids` names every calendar it is on. */
function mergeEvents(calendars: readonly CalendarEntry[], lists: readonly CalendarEvent[][], zone: string): SourcedEvent[] {
  const byKey = new Map<string, SourcedEvent>();
  calendars.forEach((calendar, index) => {
    for (const event of lists[index] ?? []) {
      const at = eventInstant(event.start, zone);
      const key = `${event.iCalUID ?? event.id}|${eventInstant(event.originalStartTime ?? event.start, zone)}`;
      const seen = byKey.get(key);
      if (seen) {
        if (!seen.all_calendar_ids.includes(calendar.id)) seen.all_calendar_ids.push(calendar.id);
        continue;
      }
      byKey.set(key, { event, source_calendar_id: calendar.id, source_calendar_summary: calendarName(calendar), all_calendar_ids: [calendar.id], at });
    }
  });
  return [...byKey.values()].sort((a, b) => a.at - b.at);
}

const eventsListAllCalendars: GoogleTool = {
  name: 'events_list_all_calendars',
  title: 'List events across calendars',
  description:
    'List the events of every calendar in the calendar list, or of calendar_ids, in one time window. ' +
    'An event on several calendars appears once; all are sorted by start. ' +
    'summary_view is the compact agenda; response_detail full adds the event objects. A calendar that fails is named in errors_by_calendar.',
  inputSchema: schema(
    {
      time_min: s('Only events that end after this time, RFC 3339. Without an offset it is read in the primary calendar\'s time zone.'),
      time_max: s('Only events that start before this time, RFC 3339.'),
      q: s('Free-text search over title, description, location and attendees.'),
      calendar_ids: strs('Calendar ids to read. Default: every calendar in the calendar list.'),
      event_types: strs('Event types: default, birthday, focusTime, fromGmail, outOfOffice, workingLocation. All when omitted.'),
      single_events: b('Expand recurring events into their occurrences.', { default: true }),
      show_deleted: b('Include cancelled events.', { default: false }),
      max_results_per_calendar: i(`Events per calendar, up to 2500. Default ${MAX_EVENTS_PER_CALENDAR}.`),
      response_detail: s('minimal: summary_view only. full: also the event objects.', { enum: ['minimal', 'full'], default: 'minimal' }),
    },
    ['time_min', 'time_max'],
  ),
  annotations: READ,
  async run(args, ctx) {
    const entries = await calendarEntries(ctx);
    const primary = entries.find((entry) => entry.primary);
    const tz = primary?.timeZone ?? 'UTC';
    const notes: string[] = [];
    const zone = async () => tz;
    const timeMin = await filterTime(reqStr(args, 'time_min', 'timeMin'), 'time_min', zone, notes);
    const timeMax = await filterTime(reqStr(args, 'time_max', 'timeMax'), 'time_max', zone, notes);
    const ids = strList(args, 'calendar_ids', 'calendarIds');
    const calendars = ids.length ? ids.map((id) => (id === 'primary' ? primary : entries.find((entry) => entry.id === id)) ?? { id }) : entries;
    const singleEvents = flag(args, 'single_events', 'singleEvents') ?? true;
    const query: Json = {
      timeMin,
      timeMax,
      q: optStr(args, 'q', 'query'),
      eventTypes: strList(args, 'event_types', 'eventTypes'),
      showDeleted: flag(args, 'show_deleted', 'showDeleted') ?? false,
      singleEvents,
      orderBy: singleEvents ? 'startTime' : undefined,
    };
    const limit = int(args, ['max_results_per_calendar'], 2500) ?? MAX_EVENTS_PER_CALENDAR;
    const errors: Record<string, string> = {};
    const lists = await mapLimit(calendars, CALENDAR_CONCURRENCY, async (calendar) => {
      try {
        return await calendarEvents(ctx, calendar.id, query, limit);
      } catch (error) {
        if (!(error instanceof GoogleApiError) || error.status === 401) throw error;
        errors[calendar.id] = error.message;
        return [];
      }
    });
    const merged = mergeEvents(calendars, lists, tz);
    const summaryView = merged.map(({ event, source_calendar_summary }) => ({
      event_id: event.id ?? '',
      title: event.summary ?? '(no title)',
      start: event.start?.dateTime ?? event.start?.date ?? '',
      end: event.end?.dateTime ?? event.end?.date ?? '',
      is_all_day: Boolean(event.start?.date && !event.start.dateTime),
      calendar: source_calendar_summary,
      display_url: event.htmlLink ?? '',
    }));
    const full = optStr(args, 'response_detail') === 'full';
    return withNotes(
      {
        summary_view: summaryView,
        ...(full ? { events: merged.map(({ at: _at, event, ...source }) => ({ event: withEventUrl(event), ...source })) } : {}),
        calendars_queried: calendars.map((calendar) => ({ id: calendar.id, summary: calendarName(calendar) })),
        errors_by_calendar: errors,
      },
      notes,
    );
  },
};

const eventsGet: GoogleTool = {
  name: 'events_get',
  title: 'Get event',
  description: 'Read one event by id: time, attendees and their responses, Meet link, recurrence. find_event or events_list give the id.',
  inputSchema: schema(
    {
      event_id: s('Event id (not its title). An occurrence of a recurring event has an id like `<id>_20260115T100000Z`.'),
      calendar_id: CALENDAR_ID,
      time_zone: s('IANA time zone of the times in the answer. Default: the calendar\'s.'),
      max_attendees: i('At most this many attendees in the answer.'),
    },
    ['event_id'],
  ),
  annotations: READ,
  async run(args, ctx) {
    const event = await ctx.google.json<CalendarEvent>({
      url: eventPath(calendarArg(args), eventArg(args)),
      query: { timeZone: zoneArg(args, 'time_zone', 'timeZone'), maxAttendees: int(args, ['max_attendees', 'maxAttendees']) },
    });
    return withEventUrl(event);
  },
};

const findEvent: GoogleTool = {
  name: 'find_event',
  title: 'Find events',
  description:
    'Search one calendar\'s events by text, time window and type. Recurring events are expanded by default. ' +
    'Matches are in event_data.event_data (and items). Follow nextPageToken with page_token until it is absent.',
  inputSchema: schema({
    query: s('Free-text search over title, description, location, attendees and organizer. Not an event id.'),
    calendar_id: CALENDAR_ID,
    time_min: s('Only events that end after this time: RFC 3339, `2026-01-19 09:00:00` or `2026,1,19,9,0,0`. Without an offset it is read in the calendar\'s time zone.'),
    time_max: s('Only events that start before this time, in the same formats.'),
    updated_min: s('Only events changed after this time, in the same formats.'),
    event_types: strs('Event types to include.', { default: FIND_EVENT_TYPES }),
    single_events: b('Expand recurring events into their occurrences.', { default: true }),
    order_by: s('startTime (needs single_events) or updated.', { enum: ['startTime', 'updated'] }),
    show_deleted: b('Include cancelled events.'),
    max_results: i('Events per page, 1–2500.', { default: 10 }),
    page_token: PAGE_TOKEN_SNAKE,
  }),
  annotations: READ,
  async run(args, ctx) {
    const calendar = calendarArg(args);
    const zone = zoneFor(ctx, undefined, calendar);
    const notes: string[] = [];
    const orderBy = optStr(args, 'order_by', 'orderBy');
    let singleEvents = flag(args, 'single_events', 'singleEvents') ?? true;
    if (orderBy === 'startTime' && !singleEvents) {
      singleEvents = true;
      notes.push('order_by startTime needs single_events, so single_events was set to true.');
    }
    const eventTypes = strList(args, 'event_types', 'eventTypes');
    const list = await ctx.google.json<EventPage>({
      url: eventsPath(calendar),
      query: {
        q: optStr(args, 'query', 'q'),
        timeMin: await filterTime(optStr(args, 'time_min', 'timeMin'), 'time_min', zone, notes),
        timeMax: await filterTime(optStr(args, 'time_max', 'timeMax'), 'time_max', zone, notes),
        updatedMin: await filterTime(optStr(args, 'updated_min', 'updatedMin'), 'updated_min', zone, notes),
        eventTypes: eventTypes.length ? eventTypes : FIND_EVENT_TYPES,
        singleEvents,
        orderBy,
        showDeleted: flag(args, 'show_deleted', 'showDeleted'),
        maxResults: int(args, ['max_results', 'maxResults'], 2500) ?? 10,
        pageToken: pageToken(args),
      },
    });
    const items = list?.items ?? [];
    return withNotes(
      { ...list, items, event_data: { event_data: items, nextPageToken: list?.nextPageToken ?? null, nextSyncToken: list?.nextSyncToken ?? null } },
      notes,
    );
  },
};

const eventsInstances: GoogleTool = {
  name: 'events_instances',
  title: 'List occurrences of a recurring event',
  description: 'List the occurrences of a recurring event, optionally only those between timeMin and timeMax. Each has its own id for patch_event or delete_event.',
  inputSchema: schema(
    {
      calendarId: s('Calendar id: `primary` or an id from list_calendars. `calendar_id` is an alias.', { default: 'primary' }),
      eventId: s('Id of the recurring event (the series). `event_id` is an alias.'),
      timeMin: s('Only occurrences that end after this time, RFC 3339. Without an offset it is read in timeZone, else in the calendar\'s time zone.'),
      timeMax: s('Only occurrences that start before this time, RFC 3339.'),
      timeZone: s('IANA time zone of the times in the answer.'),
      maxResults: i('Occurrences per page, up to 2500. Google defaults to 250.'),
      pageToken: PAGE_TOKEN,
      showDeleted: b('Include cancelled occurrences.'),
      maxAttendees: i('At most this many attendees per occurrence in the answer.'),
      originalStart: s('Only the occurrence that originally started at this time.'),
    },
    ['calendarId', 'eventId'],
  ),
  annotations: READ,
  async run(args, ctx) {
    const calendar = calendarArg(args);
    const responseZone = zoneArg(args, 'timeZone', 'time_zone');
    const zone = zoneFor(ctx, responseZone, calendar);
    const notes: string[] = [];
    const list = await ctx.google.json<Json>({
      url: `${eventPath(calendar, reqStr(args, 'eventId', 'event_id'))}/instances`,
      query: {
        timeMin: await filterTime(optStr(args, 'timeMin', 'time_min'), 'timeMin', zone, notes),
        timeMax: await filterTime(optStr(args, 'timeMax', 'time_max'), 'timeMax', zone, notes),
        timeZone: responseZone,
        maxResults: int(args, ['maxResults', 'max_results'], 2500),
        pageToken: pageToken(args),
        showDeleted: flag(args, 'showDeleted', 'show_deleted'),
        maxAttendees: int(args, ['maxAttendees', 'max_attendees']),
        originalStart: optStr(args, 'originalStart', 'original_start'),
      },
    });
    return withNotes(list ?? {}, notes);
  },
};

const syncEvents: GoogleTool = {
  name: 'sync_events',
  title: 'Sync events',
  description:
    'Deprecated: use events_list with syncToken. One page of a full sync of a calendar\'s events, or with sync_token only the changes since then. ' +
    'Google answers 410 when the token expired: start a full sync again.',
  inputSchema: schema({
    calendar_id: CALENDAR_ID,
    sync_token: s('nextSyncToken of the last page of an earlier sync.'),
    page_token: PAGE_TOKEN_SNAKE,
    max_results: i('Events per page, up to 2500.'),
    event_types: strs('Event types to include. All when omitted.'),
    single_events: b('Expand recurring events into their occurrences.'),
  }),
  annotations: READ,
  async run(args, ctx) {
    const list = await ctx.google.json<EventPage>({
      url: eventsPath(calendarArg(args)),
      query: {
        syncToken: syncToken(args),
        pageToken: pageToken(args),
        maxResults: int(args, ['max_results', 'maxResults'], 2500),
        eventTypes: strList(args, 'event_types', 'eventTypes'),
        singleEvents: flag(args, 'single_events', 'singleEvents'),
      },
    });
    const items = list?.items ?? [];
    return { ...list, items, event_data: { event_data: items, nextPageToken: list?.nextPageToken ?? null, nextSyncToken: list?.nextSyncToken ?? null } };
  },
};

// ─── Events: write ──────────────────────────────────────────────────────────

const EVENT_WRITE_PROPS = {
  summary: s('Title.'),
  description: s('Description; HTML allowed. Leave it out for birthday events.'),
  location: s('Location, as free text.'),
  start_datetime: s('Start, such as 2026-01-19T09:00:00. Without an offset it is read in timezone.'),
  end_datetime: s('End, such as 2026-01-19T10:00:00. Wins over the duration.'),
  event_duration_hour: i('Length in hours, when end_datetime is not set.', { default: 0 }),
  event_duration_minutes: i('Length in minutes (0–59), added to event_duration_hour. Default 30, or 0 when event_duration_hour is set.'),
  timezone: TIMEZONE,
  start_date: s('All-day start, YYYY-MM-DD. Use instead of start_datetime.'),
  end_date: s('All-day end, YYYY-MM-DD, exclusive: a one-day event on 2026-01-19 ends 2026-01-20. Default: the day after start_date.'),
  attendees: ATTENDEES,
  send_updates: SEND_UPDATES_PROP,
  create_meeting_room: b('Add a Google Meet link. If the account cannot have one, the event is created without it.', { default: true }),
  recurrence: RECURRENCE,
  visibility: s('default, public, private or confidential.', { enum: ['default', 'public', 'private', 'confidential'], default: 'default' }),
  transparency: s('opaque (busy) or transparent (free).', { enum: ['opaque', 'transparent'], default: 'opaque' }),
  eventType: s('default, birthday, focusTime, outOfOffice or workingLocation. Fixed once created.', {
    enum: ['birthday', 'default', 'focusTime', 'outOfOffice', 'workingLocation'],
    default: 'default',
  }),
  guestsCanModify: b('Guests can edit the event.'),
  guestsCanInviteOthers: b('Guests can invite others.'),
  guestsCanSeeOtherGuests: b('Guests can see the guest list.'),
  calendar_id: CALENDAR_ID,
  extended_properties: anyObj('Your own metadata: {private: {key: value}, shared: {key: value}}.'),
  ...EVENT_TYPE_PROPS,
};

const createEvent: GoogleTool = {
  name: 'create_event',
  title: 'Create event',
  description:
    'Create a timed event (start_datetime, then end_datetime or a duration; 30 minutes by default) or an all-day event (start_date, end_date exclusive). ' +
    'Guests get an invitation email unless send_updates is none. A regular event gets a Google Meet link unless create_meeting_room is false. ' +
    'It does not check for conflicts: find_free_slots does.',
  inputSchema: schema({ ...EVENT_WRITE_PROPS, exclude_organizer: b('Do not add yourself to the guest list.', { default: false }) }),
  annotations: WRITE,
  async run(args, ctx) {
    const calendar = calendarArg(args);
    const eventType = optStr(args, 'eventType', 'event_type') ?? 'default';
    const primary = once(() => readCalendar(ctx, 'primary'));
    const explicit = zoneArg(args, 'timezone', 'time_zone', 'timeZone');
    const zone = once(async () => explicit ?? (await (calendar === 'primary' ? primary() : readCalendar(ctx, calendar)))?.timeZone ?? 'UTC');
    const window = await eventWindow(args, zone, () => durationArg(args) ?? 30);
    const body: Json = { ...eventFields(args), ...window, eventType };
    if (eventType === 'workingLocation') {
      // Google requires these for a working location.
      body.transparency ??= 'transparent';
      body.visibility ??= 'public';
      delete body.description;
    }
    const regular = eventType === 'default';
    const attendees = body.attendees as Json[] | undefined;
    if (regular && attendees?.length && !optBool(args, 'exclude_organizer', false)) {
      const me = (await primary())?.id;
      if (me && !attendees.some((a) => typeof a.email === 'string' && a.email.toLowerCase() === me.toLowerCase())) {
        attendees.unshift({ email: me, responseStatus: 'accepted' });
      }
    }
    const meet = regular && optBool(args, 'create_meeting_room', true) && !body.conferenceData;
    const { event, note } = await withMeetFallback(meet, (withMeet) =>
      ctx.google.json<CalendarEvent>({
        method: 'POST',
        url: eventsPath(calendar),
        query: {
          sendUpdates: sendUpdates(args) ?? 'all',
          conferenceDataVersion: withMeet || body.conferenceData ? 1 : undefined,
          supportsAttachments: body.attachments ? true : undefined,
        },
        body: withMeet ? { ...body, conferenceData: meetRequest() } : body,
      }),
    );
    return { response_data: withEventUrl(event), display_url: event?.htmlLink ?? '', ...(note ? { composio_execution_message: note } : {}) };
  },
};

const updateEvent: GoogleTool = {
  name: 'update_event',
  title: 'Update event',
  description:
    'Set an event\'s time and, when given, its title, description, location, guests, recurrence and settings. Fields you leave out keep their values. ' +
    'Without end_datetime or a duration the event keeps its length. An existing Meet link stays; create_meeting_room adds one when there is none.',
  inputSchema: schema(
    {
      event_id: s('Event id (not its title), from find_event or events_list.'),
      ...EVENT_WRITE_PROPS,
      start_datetime: s('New start, such as 2026-01-19T09:00:00. Without an offset it is read in timezone, else in the event\'s time zone.'),
      create_meeting_room: b('Keep the Meet link, or add one when the event has none.', { default: true }),
    },
    ['start_datetime', 'event_id'],
  ),
  annotations: { ...WRITE, idempotentHint: true },
  async run(args, ctx) {
    const calendar = calendarArg(args);
    const eventId = eventArg(args);
    const existing = await ctx.google.json<CalendarEvent>({ url: eventPath(calendar, eventId) });
    const explicit = zoneArg(args, 'timezone', 'time_zone', 'timeZone');
    const zone = once(async () => explicit ?? existing?.start?.timeZone ?? (await readCalendar(ctx, calendar))?.timeZone ?? 'UTC');
    const window = await eventWindow(args, zone, () => durationArg(args) ?? eventMinutes(existing) ?? 30);
    const body: Json = { ...existing, ...eventFields(args), ...window };
    const keepConference = optBool(args, 'create_meeting_room', true);
    const meet = keepConference && (existing?.eventType ?? 'default') === 'default' && !body.conferenceData;
    const { event, note } = await withMeetFallback(meet, (withMeet) =>
      ctx.google.json<CalendarEvent>({
        method: 'PUT',
        url: eventPath(calendar, eventId),
        // Version 0 makes Google ignore conferenceData, which leaves the event's own untouched.
        query: { sendUpdates: sendUpdates(args), conferenceDataVersion: keepConference ? 1 : 0, supportsAttachments: body.attachments ? true : undefined },
        body: withMeet ? { ...body, conferenceData: meetRequest() } : body,
      }),
    );
    return { response_data: withEventUrl(event), ...(note ? { composio_execution_message: note } : {}) };
  },
};

/** A new end that keeps the event's length (all-day: its days; timed: its minutes, else 30). */
function keepLength(start: Wall, event: CalendarEvent | null): Wall {
  if (start.dateOnly) {
    const from = event?.start?.date;
    const to = event?.end?.date;
    const days = from && to ? Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS)) : 1;
    return parseWall(addDays(wallText(start), days), 'end_time');
  }
  return addMinutes(start, eventMinutes(event) ?? 30);
}

/**
 * A patch start/end. Google merges nested objects in a patch, so the other
 * form (`date` or `dateTime`) is cleared with null.
 */
async function patchTime(w: Wall, explicit: string | undefined, zone: () => Promise<string>): Promise<EventTime> {
  if (w.dateOnly) return { date: wallText(w), dateTime: null, timeZone: null };
  if (w.offset === null || explicit) return { dateTime: wallText(w), timeZone: await zone(), date: null };
  return { dateTime: wallText(w), date: null };
}

async function patchWindow(
  args: Json,
  explicit: string | undefined,
  existing: () => Promise<CalendarEvent | null>,
  zone: () => Promise<string>,
  notes: string[],
): Promise<Json> {
  const startText = optStr(args, 'start_time', 'start_datetime');
  const endText = optStr(args, 'end_time', 'end_datetime');
  if (!startText && !endText) {
    if (!explicit) return {};
    const event = await existing();
    if (!event?.start?.dateTime || !event.end?.dateTime) {
      notes.push('All-day events have no time zone, so timezone was not applied.');
      return {};
    }
    return { start: { dateTime: event.start.dateTime, timeZone: explicit }, end: { dateTime: event.end.dateTime, timeZone: explicit } };
  }
  const start = startText ? parseWall(startText, 'start_time') : undefined;
  const end = endText ? parseWall(endText, 'end_time') : start ? keepLength(start, await existing()) : undefined;
  const out: Json = {};
  if (start) out.start = await patchTime(start, explicit, zone);
  if (end) out.end = await patchTime(end, explicit, zone);
  return out;
}

/** The attendee list with the connected account's response set. */
async function withRsvp(ctx: ToolContext, attendees: readonly Json[], status: string): Promise<Json[]> {
  const list = attendees.map((a) => ({ ...a }));
  let index = list.findIndex((a) => a.self === true);
  if (index < 0) {
    const me = (await readCalendar(ctx, 'primary'))?.id?.toLowerCase();
    index = me ? list.findIndex((a) => typeof a.email === 'string' && a.email.toLowerCase() === me) : -1;
  }
  if (index < 0) throw new ToolInputError('The connected account is not a guest of this event, so it has no response to set.');
  list[index] = { ...list[index], responseStatus: status };
  return list;
}

const patchEvent: GoogleTool = {
  name: 'patch_event',
  title: 'Change event',
  description:
    'Change only the fields you pass; the rest stay. A new start_time without end_time keeps the event\'s length. ' +
    'attendees replaces the whole guest list. rsvp_response sets only your own response. ' +
    'Use the series id to change every occurrence, an occurrence id to change one.',
  inputSchema: schema(
    {
      calendar_id: s('Calendar id: `primary` or an id from list_calendars.'),
      event_id: s('Event id (not its title). An occurrence of a recurring event has an id like `<id>_20260115T100000Z`.'),
      summary: s('New title.'),
      description: s('New description; HTML allowed.'),
      location: s('New location.'),
      start_time: s('New start: RFC 3339 (2026-01-19T09:00:00-08:00), or YYYY-MM-DD for all-day. Without an offset it is read in timezone, else in the event\'s time zone.'),
      end_time: s('New end, in the same form as start_time. All-day ends are exclusive. Default: keeps the event\'s length.'),
      timezone: s('IANA time zone for start_time/end_time without an offset. Alone, it changes the time zone of a timed event and keeps its times.'),
      attendees: ATTENDEES,
      rsvp_response: s('Your own response: accepted, declined, tentative or needsAction. Regular events only.', {
        enum: ['needsAction', 'declined', 'tentative', 'accepted'],
      }),
      send_updates: SEND_UPDATES_PROP,
      recurrence: RECURRENCE,
      status: s('confirmed, tentative or cancelled.', { enum: ['confirmed', 'tentative', 'cancelled'] }),
      visibility: s('default, public, private or confidential.', { enum: ['default', 'public', 'private', 'confidential'] }),
      transparency: s('opaque (busy) or transparent (free).', { enum: ['opaque', 'transparent'] }),
      color_id: s('Event color id, 1–11 (colors_get).'),
      reminders: anyObj('{useDefault, overrides: [{method: email|popup, minutes}]}.'),
      attachments: arr({ type: 'object', additionalProperties: true }, 'Up to 25 attachments: {fileUrl, title, mimeType}. Sets supports_attachments.'),
      supports_attachments: b('Send attachments to Google.'),
      conference_data: anyObj('Conference data, such as {createRequest: {requestId, conferenceSolutionKey: {type: "hangoutsMeet"}}}.'),
      conference_data_version: i('1 to read and write conference data. Set for you with conference_data.', { minimum: 0, maximum: 1 }),
      guests_can_modify: b('Guests can edit the event.'),
      guests_can_invite_others: b('Guests can invite others.'),
      guests_can_see_other_guests: b('Guests can see the guest list.'),
      anyone_can_add_self: b('Anyone can add themselves.'),
      attendees_omitted: b('The guest list may be incomplete.'),
      extended_properties: anyObj('{private: {key: value}, shared: {key: value}}.'),
      source: anyObj('{url, title} of where the event came from.'),
      sequence: i('iCalendar sequence number.'),
      max_attendees: i('At most this many attendees in the answer.'),
      focus_time_properties: anyObj('For focusTime events.'),
      out_of_office_properties: anyObj('For outOfOffice events.'),
      working_location_properties: anyObj('For workingLocation events.'),
    },
    ['calendar_id', 'event_id'],
  ),
  annotations: { ...WRITE, idempotentHint: true },
  async run(args, ctx) {
    const calendar = calendarArg(args);
    const eventId = eventArg(args);
    const existing = once(() => ctx.google.json<CalendarEvent>({ url: eventPath(calendar, eventId) }));
    const explicit = zoneArg(args, 'timezone', 'time_zone', 'timeZone');
    const zone = once(async () => explicit ?? (await existing())?.start?.timeZone ?? (await readCalendar(ctx, calendar))?.timeZone ?? 'UTC');
    const notes: string[] = [];
    const body: Json = { ...eventFields(args), ...(await patchWindow(args, explicit, existing, zone, notes)) };
    const rsvp = optStr(args, 'rsvp_response');
    if (rsvp) body.attendees = await withRsvp(ctx, (body.attendees as Json[] | undefined) ?? (await existing())?.attendees ?? [], rsvp);
    if (!Object.keys(body).length) throw new ToolInputError('Nothing to change: pass at least one field, such as summary, start_time or attendees');
    const event = await ctx.google.json<CalendarEvent>({
      method: 'PATCH',
      url: eventPath(calendar, eventId),
      query: {
        sendUpdates: sendUpdates(args),
        maxAttendees: int(args, ['max_attendees', 'maxAttendees']),
        supportsAttachments: flag(args, 'supports_attachments', 'supportsAttachments') ?? (body.attachments ? true : undefined),
        conferenceDataVersion: int(args, ['conference_data_version', 'conferenceDataVersion'], 1) ?? (body.conferenceData ? 1 : undefined),
      },
      body,
    });
    return withNotes(withEventUrl(event), notes);
  },
};

const deleteEvent: GoogleTool = {
  name: 'delete_event',
  title: 'Delete event',
  description:
    'Delete an event. The series id deletes every occurrence; an occurrence id (`<id>_20260115T100000Z`) deletes one. ' +
    'send_updates sets who gets a cancellation email. A 404 can mean the event is on another calendar.',
  inputSchema: schema(
    {
      event_id: s('Event id (not its title).'),
      calendar_id: CALENDAR_ID,
      send_updates: SEND_UPDATES_PROP,
      send_notifications: b('Deprecated: use send_updates.'),
    },
    ['event_id'],
  ),
  annotations: DESTRUCTIVE,
  async run(args, ctx) {
    const calendar = calendarArg(args);
    const eventId = eventArg(args);
    const updates = sendUpdates(args);
    await ctx.google.json({
      method: 'DELETE',
      url: eventPath(calendar, eventId),
      query: { sendUpdates: updates, sendNotifications: updates ? undefined : flag(args, 'send_notifications', 'sendNotifications') },
    });
    return { response_data: { status: 'success' }, event_id: eventId, calendar_id: calendar };
  },
};

const removeAttendee: GoogleTool = {
  name: 'remove_attendee',
  title: 'Remove guest',
  description: 'Remove one guest from an event; the other guests stay. Change one event at a time: parallel calls can overwrite each other.',
  inputSchema: schema(
    {
      event_id: s('Event id. An occurrence id changes only that occurrence.'),
      attendee_email: s('Email of the guest to remove.'),
      calendar_id: CALENDAR_ID,
      send_updates: SEND_UPDATES_PROP,
    },
    ['event_id', 'attendee_email'],
  ),
  annotations: DESTRUCTIVE,
  async run(args, ctx) {
    const calendar = calendarArg(args);
    const eventId = eventArg(args);
    const email = reqStr(args, 'attendee_email', 'email').trim().toLowerCase();
    const event = await ctx.google.json<CalendarEvent>({ url: eventPath(calendar, eventId) });
    const attendees = event?.attendees ?? [];
    const kept = attendees.filter((a) => typeof a.email !== 'string' || a.email.toLowerCase() !== email);
    if (kept.length === attendees.length) return { event: withEventUrl(event), display_url: event?.htmlLink ?? '', removed: false };
    const updated = await ctx.google.json<CalendarEvent>({ method: 'PATCH', url: eventPath(calendar, eventId), query: { sendUpdates: sendUpdates(args) }, body: { attendees: kept } });
    return { event: withEventUrl(updated), display_url: updated?.htmlLink ?? '', removed: true };
  },
};

const quickAdd: GoogleTool = {
  name: 'quick_add',
  title: 'Quick add event',
  description: 'Create a simple event from a sentence, such as `Lunch with Ada tomorrow 1pm at Luigi\'s`. Google reads the title, date and time. No guests, no recurrence.',
  inputSchema: schema(
    { text: s('The event in plain words.'), calendar_id: CALENDAR_ID, send_updates: s('Who gets an email: all, externalOnly or none.', { enum: SEND_UPDATES, default: 'none' }) },
    ['text'],
  ),
  annotations: WRITE,
  async run(args, ctx) {
    const event = await ctx.google.json<CalendarEvent>({
      method: 'POST',
      url: `${eventsPath(calendarArg(args))}/quickAdd`,
      query: { text: reqStr(args, 'text'), sendUpdates: sendUpdates(args) ?? 'none' },
    });
    return { event: withEventUrl(event), display_url: event?.htmlLink ?? '' };
  },
};

const eventsMove: GoogleTool = {
  name: 'events_move',
  title: 'Move event',
  description: 'Move a regular event to another calendar; that calendar becomes its organizer. Other event types cannot move.',
  inputSchema: schema(
    {
      calendar_id: s('Calendar the event is on now, or `primary`.'),
      event_id: s('Event id.'),
      destination: s('Calendar id to move it to.'),
      send_updates: SEND_UPDATES_PROP,
    },
    ['calendar_id', 'event_id', 'destination'],
  ),
  annotations: { ...WRITE, idempotentHint: true },
  async run(args, ctx) {
    const event = await ctx.google.json<CalendarEvent>({
      method: 'POST',
      url: `${eventPath(calendarArg(args), eventArg(args))}/move`,
      query: { destination: reqStr(args, 'destination'), sendUpdates: sendUpdates(args) },
    });
    return { response_data: withEventUrl(event) };
  },
};

const IMPORT_FIELDS = [
  'iCalUID',
  'summary',
  'description',
  'location',
  'status',
  'colorId',
  'sequence',
  'source',
  'reminders',
  'visibility',
  'transparency',
  'attachments',
  'guestsCanModify',
  'guestsCanInviteOthers',
  'guestsCanSeeOtherGuests',
  'extendedProperties',
];

/** An import start/end: Google's {date} / {dateTime, timeZone} object, or a date or date-time string. */
function importTime(args: Json, key: string): EventTime {
  const object = optObj(args, key);
  if (object) return object as EventTime;
  const wall = parseWall(reqStr(args, key), key);
  return wall.dateOnly ? { date: wallText(wall) } : { dateTime: wallText(wall), ...(wall.offset === null ? { timeZone: 'UTC' } : {}) };
}

const eventsImport: GoogleTool = {
  name: 'events_import',
  title: 'Import event',
  description: 'Add a private copy of an existing event, keyed by its iCalendar UID, such as one from another calendar system. Importing the same UID again updates it.',
  inputSchema: schema(
    {
      calendar_id: CALENDAR_ID,
      iCalUID: s('The event\'s iCalendar UID.'),
      start: anyObj('{dateTime, timeZone} for a timed event, {date} for all-day.'),
      end: anyObj('{dateTime, timeZone} or {date} (exclusive).'),
      summary: s('Title.'),
      description: s('Description; HTML allowed.'),
      location: s('Location.'),
      status: s('confirmed, tentative or cancelled.'),
      attendees: ATTENDEES,
      recurrence: RECURRENCE,
      reminders: anyObj('{useDefault, overrides}.'),
      visibility: s('default, public, private or confidential.'),
      transparency: s('opaque or transparent.'),
      colorId: s('Event color id.'),
      sequence: i('iCalendar sequence number.'),
      source: anyObj('{url, title}.'),
      attachments: arr({ type: 'object', additionalProperties: true }, 'Attachments: {fileUrl, title, mimeType}.'),
      guestsCanModify: b('Guests can edit the event.'),
      guestsCanInviteOthers: b('Guests can invite others.'),
      guestsCanSeeOtherGuests: b('Guests can see the guest list.'),
      extendedProperties: anyObj('{private: {…}, shared: {…}}.'),
      conferenceDataVersion: i('1 to import conference data.'),
      supportsAttachments: b('Send attachments to Google.'),
    },
    ['iCalUID', 'start', 'end'],
  ),
  annotations: WRITE,
  async run(args, ctx) {
    const attendees = attendeeList(args.attendees);
    const recurrence = recurrenceLines(args.recurrence);
    const event = await ctx.google.json<CalendarEvent>({
      method: 'POST',
      url: `${eventsPath(calendarArg(args))}/import`,
      query: {
        conferenceDataVersion: int(args, ['conferenceDataVersion', 'conference_data_version'], 1),
        supportsAttachments: flag(args, 'supportsAttachments', 'supports_attachments') ?? (args.attachments ? true : undefined),
      },
      body: {
        ...pick(args, IMPORT_FIELDS),
        start: importTime(args, 'start'),
        end: importTime(args, 'end'),
        ...(attendees ? { attendees } : {}),
        ...(recurrence ? { recurrence } : {}),
      },
    });
    return { response_data: withEventUrl(event) };
  },
};

// ─── Batch ──────────────────────────────────────────────────────────────────

type BatchMethod = 'POST' | 'PATCH' | 'DELETE';

interface BatchOperation {
  op_id: string;
  method: BatchMethod;
  calendar_id: string;
  event_id?: string;
  body?: Json;
  query_params?: Json;
}

interface BatchResult {
  op_id: string;
  http_status: number;
  event?: Json;
  display_url?: string;
  error?: Json;
}

function batchOperations(args: Json): BatchOperation[] {
  let raw = args.operations;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      throw new ToolInputError('operations must be a list');
    }
  }
  if (!Array.isArray(raw) || !raw.length) throw new ToolInputError('operations must be a non-empty list');
  if (raw.length > MAX_BATCH_OPERATIONS) throw new ToolInputError(`operations holds ${raw.length} items; the limit is ${MAX_BATCH_OPERATIONS}`);
  return raw.map((item: unknown, index): BatchOperation => {
    const where = `operations[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ToolInputError(`${where} must be an object`);
    const op = item as Json;
    const method = String(op.method ?? '').toUpperCase();
    if (method !== 'POST' && method !== 'PATCH' && method !== 'DELETE') throw new ToolInputError(`${where}.method must be POST, PATCH or DELETE`);
    const eventId = optStr(op, 'event_id', 'eventId');
    if (method !== 'POST' && !eventId) throw new ToolInputError(`${where}.event_id is required for ${method}`);
    const body = optObj(op, 'body');
    if (method !== 'DELETE' && !body) throw new ToolInputError(`${where}.body is required for ${method}`);
    return { op_id: optStr(op, 'op_id', 'opId') ?? `op${index + 1}`, method, calendar_id: calendarArg(op), event_id: eventId, body, query_params: optObj(op, 'query_params') };
  });
}

async function runBatchOperation(ctx: ToolContext, op: BatchOperation): Promise<BatchResult> {
  const url = op.method === 'POST' ? eventsPath(op.calendar_id) : eventPath(op.calendar_id, op.event_id ?? '');
  try {
    const answer = await ctx.google.raw({ method: op.method, url, query: op.query_params, body: op.method === 'DELETE' ? undefined : op.body });
    const event = answer.body && typeof answer.body === 'object' ? (answer.body as CalendarEvent) : undefined;
    return { op_id: op.op_id, http_status: answer.status, ...(event ? { event, display_url: event.htmlLink ?? '' } : {}) };
  } catch (error) {
    // A rejected token fails every operation: let the server ask for a new sign-in.
    if (!(error instanceof GoogleApiError) || error.status === 401) throw error;
    return { op_id: op.op_id, http_status: error.status, error: { code: error.status, message: error.message, reason: error.reason } };
  }
}

const batchEvents: GoogleTool = {
  name: 'batch_events',
  title: 'Create, change and delete many events',
  description:
    'Run up to 1,000 event operations in one call: POST creates, PATCH changes, DELETE removes. ' +
    'Results keep the order of operations, each with op_id, http_status and the event or the error. ' +
    'fail_fast stops after the first group of 50 with a client error (a 404 on DELETE does not count).',
  inputSchema: schema(
    {
      operations: arr(
        {
          type: 'object',
          properties: {
            op_id: s('Your id for this operation, echoed in its result.'),
            method: s('POST (create), PATCH (change) or DELETE.', { enum: ['POST', 'PATCH', 'DELETE'] }),
            calendar_id: s('Calendar id, or `primary`.'),
            event_id: s('Event id, for PATCH and DELETE.'),
            body: anyObj('Google event fields, for POST and PATCH, such as {summary, start: {dateTime, timeZone}, end: {…}}.'),
            query_params: anyObj('Query parameters, such as {sendUpdates: "all", conferenceDataVersion: 1}.'),
          },
          required: ['op_id', 'method', 'calendar_id'],
        },
        'The operations, at most 1,000.',
      ),
      fail_fast: b('Stop after the first group of 50 operations that has a client error.', { default: false }),
    },
    ['operations'],
  ),
  annotations: DESTRUCTIVE,
  async run(args, ctx) {
    const operations = batchOperations(args);
    const failFast = optBool(args, 'fail_fast', false);
    const results: BatchResult[] = [];
    for (let start = 0; start < operations.length; start += BATCH_GROUP) {
      const group = operations.slice(start, start + BATCH_GROUP);
      const done = await mapLimit(group, BATCH_CONCURRENCY, (op) => runBatchOperation(ctx, op));
      results.push(...done);
      const clientError = done.some((r, index) => r.http_status >= 400 && r.http_status < 500 && !(group[index]?.method === 'DELETE' && r.http_status === 404));
      if (failFast && clientError) break;
    }
    const byStatus: Record<string, number> = {};
    for (const result of results) byStatus[String(result.http_status)] = (byStatus[String(result.http_status)] ?? 0) + 1;
    const succeeded = results.filter((r) => r.http_status < 300).length;
    return {
      results,
      succeeded,
      failed: results.length - succeeded,
      by_status: byStatus,
      ...(results.length < operations.length ? { skipped: operations.length - results.length } : {}),
    };
  },
};

// ─── Free/busy ──────────────────────────────────────────────────────────────

/** Calendar ids from strings, a comma-separated string, or {id} objects. */
function freeBusyItems(value: unknown): string[] {
  const raw: unknown[] = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : [];
  return raw
    .map((item) => (typeof item === 'string' ? item : item && typeof item === 'object' && typeof (item as Json).id === 'string' ? ((item as Json).id as string) : ''))
    .map((id) => id.trim())
    .filter(Boolean);
}

interface FreeBusyAnswer {
  kind?: string;
  timeMin?: string;
  timeMax?: string;
  calendars?: Record<string, { busy?: Array<{ start?: string; end?: string }>; errors?: Json[] }>;
  groups?: Json;
}

const freeBusyQuery: GoogleTool = {
  name: 'free_busy_query',
  title: 'Free/busy',
  description: 'The busy intervals of calendars, people or groups between timeMin and timeMax (up to about 90 days). A calendar Google cannot read is listed with errors.',
  inputSchema: schema(
    {
      items: arr({ anyOf: [{ type: 'string' }, { type: 'object', properties: { id: { type: 'string' } } }] }, 'Calendar ids, email addresses or group emails, such as ["primary", "ada@example.com"].'),
      timeMin: s('Start, RFC 3339. Without an offset it is read in timeZone, else in the primary calendar\'s time zone.'),
      timeMax: s('End (exclusive), RFC 3339.'),
      timeZone: s('IANA time zone of the answer. Default UTC.'),
      groupExpansionMax: i('At most this many members per group, up to 100.'),
      calendarExpansionMax: i('At most this many calendars, up to 50.'),
    },
    ['timeMin', 'timeMax', 'items'],
  ),
  annotations: READ,
  async run(args, ctx) {
    const items = freeBusyItems(args.items);
    if (!items.length) throw new ToolInputError('items must name at least one calendar, such as ["primary"]');
    const responseZone = zoneArg(args, 'timeZone', 'time_zone', 'timezone');
    const zone = zoneFor(ctx, responseZone, 'primary');
    const notes: string[] = [];
    const answer = await ctx.google.json<Json>({
      method: 'POST',
      url: `${CAL}/freeBusy`,
      body: {
        timeMin: await filterTime(reqStr(args, 'timeMin', 'time_min'), 'timeMin', zone, notes),
        timeMax: await filterTime(reqStr(args, 'timeMax', 'time_max'), 'timeMax', zone, notes),
        ...(responseZone ? { timeZone: responseZone } : {}),
        groupExpansionMax: int(args, ['groupExpansionMax', 'group_expansion_max'], 100),
        calendarExpansionMax: int(args, ['calendarExpansionMax', 'calendar_expansion_max'], 50),
        items: items.map((id) => ({ id })),
      },
    });
    return withNotes(answer ?? {}, notes);
  },
};

interface Span {
  start: number;
  end: number;
}

/** Busy spans clipped to [from, to), sorted and merged. */
function mergeBusy(busy: ReadonlyArray<{ start?: string; end?: string }>, from: number, to: number): Span[] {
  const spans = busy
    .map((b) => ({ start: Math.max(from, Date.parse(b.start ?? '')), end: Math.min(to, Date.parse(b.end ?? '')) }))
    .filter((span) => Number.isFinite(span.start) && Number.isFinite(span.end) && span.end > span.start)
    .sort((a, b) => a.start - b.start);
  const merged: Span[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

function freeSpans(busy: readonly Span[], from: number, to: number): Span[] {
  const free: Span[] = [];
  let cursor = from;
  for (const span of busy) {
    if (span.start > cursor) free.push({ start: cursor, end: span.start });
    cursor = Math.max(cursor, span.end);
  }
  if (cursor < to) free.push({ start: cursor, end: to });
  return free;
}

/** The [start, end) window of find_free_slots, with notes for the defaults it applied. */
function slotWindow(args: Json, tz: string, notes: string[]): Span {
  const minText = optStr(args, 'time_min', 'timeMin');
  const start = minText ? wallInstant(parseWall(minText, 'time_min'), tz) : Date.now();
  if (!minText) notes.push('time_min defaulted to now.');
  const maxText = optStr(args, 'time_max', 'timeMax');
  let end: number;
  if (maxText) {
    end = wallInstant(parseWall(maxText, 'time_max'), tz);
  } else {
    const day = wallClock(start, tz);
    end = wallInstant({ ...day, h: 23, mi: 59, s: 59, offset: null, dateOnly: false }, tz);
    notes.push(`time_max defaulted to 23:59:59 of that day in ${tz}.`);
  }
  if (end <= start) throw new ToolInputError('time_max must be after time_min');
  if (end - start > MAX_FREEBUSY_DAYS * DAY_MS) throw new ToolInputError(`time_min to time_max spans more than ${MAX_FREEBUSY_DAYS} days; Google's free/busy limit`);
  return { start, end };
}

const findFreeSlots: GoogleTool = {
  name: 'find_free_slots',
  title: 'Find free time',
  description:
    'The busy and free intervals of each calendar in items, in timezone. Free intervals are the gaps between busy ones, with no minimum length. ' +
    'time_min defaults to now and time_max to the end of that day. A calendar Google cannot read has no free intervals and is_reliable false.',
  inputSchema: schema({
    items: strs('Calendar ids or email addresses, such as ["primary", "ada@example.com"].', { default: ['primary'] }),
    time_min: s('Start: RFC 3339, `2026-01-19 09:00:00` or `2026,1,19,9,0,0`. Without an offset it is read in timezone. Default: now.'),
    time_max: s('End (exclusive), in the same formats. Default: 23:59:59 of time_min\'s day. At most 90 days after time_min.'),
    timezone: s('IANA time zone for naive times and for the answer. Default: the primary calendar\'s time zone.'),
    group_expansion_max: i('At most this many members per group, 1–100.', { default: 100 }),
    calendar_expansion_max: i('At most this many calendars, 1–50.', { default: 50 }),
  }),
  annotations: READ,
  async run(args, ctx) {
    const items = freeBusyItems(args.items);
    const ids = items.length ? items : ['primary'];
    const notes: string[] = [];
    let tz = zoneArg(args, 'timezone', 'time_zone', 'timeZone');
    if (!tz) {
      tz = (await readCalendar(ctx, 'primary'))?.timeZone ?? 'UTC';
      notes.push(`timezone defaulted to ${tz}, the primary calendar's time zone.`);
    }
    const window = slotWindow(args, tz, notes);
    const answer = await ctx.google.json<FreeBusyAnswer>({
      method: 'POST',
      url: `${CAL}/freeBusy`,
      body: {
        timeMin: new Date(window.start).toISOString(),
        timeMax: new Date(window.end).toISOString(),
        timeZone: tz,
        groupExpansionMax: int(args, ['group_expansion_max', 'groupExpansionMax'], 100) ?? 100,
        calendarExpansionMax: int(args, ['calendar_expansion_max', 'calendarExpansionMax'], 50) ?? 50,
        items: ids.map((id) => ({ id })),
      },
    });
    const zone = tz;
    const format = (spans: readonly Span[]) => spans.map((span) => ({ start: formatInZone(span.start, zone), end: formatInZone(span.end, zone) }));
    const calendars: Record<string, Json> = {};
    for (const [id, info] of Object.entries(answer?.calendars ?? {})) {
      const reliable = !info.errors?.length;
      const busy = mergeBusy(info.busy ?? [], window.start, window.end);
      calendars[id] = {
        busy: format(busy),
        free: reliable ? format(freeSpans(busy, window.start, window.end)) : [],
        is_reliable: reliable,
        ...(reliable ? {} : { errors: info.errors }),
      };
    }
    return withNotes(
      { kind: answer?.kind ?? 'calendar#freeBusy', timeMin: formatInZone(window.start, zone), timeMax: formatInZone(window.end, zone), calendars },
      notes,
    );
  },
};

// ─── Date, time and identity ────────────────────────────────────────────────

/** Abbreviations agents use, mapped to a zone that observes them. */
const ZONE_ABBREVIATIONS: Record<string, string> = {
  UTC: 'UTC',
  GMT: 'UTC',
  Z: 'UTC',
  PST: 'America/Los_Angeles',
  PDT: 'America/Los_Angeles',
  PT: 'America/Los_Angeles',
  MST: 'America/Denver',
  MDT: 'America/Denver',
  MT: 'America/Denver',
  CST: 'America/Chicago',
  CDT: 'America/Chicago',
  CT: 'America/Chicago',
  EST: 'America/New_York',
  EDT: 'America/New_York',
  ET: 'America/New_York',
  AKST: 'America/Anchorage',
  AKDT: 'America/Anchorage',
  HST: 'Pacific/Honolulu',
  BST: 'Europe/London',
  WET: 'Europe/Lisbon',
  CET: 'Europe/Paris',
  CEST: 'Europe/Paris',
  EET: 'Europe/Athens',
  EEST: 'Europe/Athens',
  MSK: 'Europe/Moscow',
  IST: 'Asia/Kolkata',
  PKT: 'Asia/Karachi',
  GST: 'Asia/Dubai',
  ICT: 'Asia/Bangkok',
  WIB: 'Asia/Jakarta',
  SGT: 'Asia/Singapore',
  HKT: 'Asia/Hong_Kong',
  PHT: 'Asia/Manila',
  JST: 'Asia/Tokyo',
  KST: 'Asia/Seoul',
  AWST: 'Australia/Perth',
  ACST: 'Australia/Adelaide',
  AEST: 'Australia/Sydney',
  AEDT: 'Australia/Sydney',
  NZST: 'Pacific/Auckland',
  NZDT: 'Pacific/Auckland',
  BRT: 'America/Sao_Paulo',
  ART: 'America/Argentina/Buenos_Aires',
  SAST: 'Africa/Johannesburg',
  WAT: 'Africa/Lagos',
  EAT: 'Africa/Nairobi',
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The zone label and its UTC offset in minutes at `now`. */
function zoneNow(value: unknown, now: number): { zone: string; offset: number } {
  const fixed = (hours: number) => {
    if (!Number.isFinite(hours) || Math.abs(hours) > 14) throw new ToolInputError(`timezone offset must be between -14 and 14 hours, not ${hours}`);
    const offset = Math.round(hours * 60);
    return { zone: offset ? `UTC${offsetText(offset)}` : 'UTC', offset };
  };
  if (value === undefined || value === null || value === '') return { zone: 'UTC', offset: 0 };
  if (typeof value === 'number') return fixed(value);
  const text = String(value).trim();
  if (/^[+-]?\d+(?:\.\d+)?$/.test(text)) return fixed(Number(text));
  const utc = /^(?:UTC|GMT)\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(text) ?? /^([+-])(\d{1,2}):(\d{2})$/.exec(text);
  if (utc) return fixed((utc[1] === '-' ? -1 : 1) * (Number(utc[2]) + Number(utc[3] ?? 0) / 60));
  const zone = checkZone(ZONE_ABBREVIATIONS[text.toUpperCase()] ?? text, 'timezone');
  return { zone, offset: offsetMinutes(now, zone) };
}

const getCurrentDateTime: GoogleTool = {
  name: 'get_current_date_time',
  title: 'Current date and time',
  description:
    'The current date, time and weekday in a time zone. Call it before you work out "tomorrow" or "next Monday". ' +
    'timezone is an IANA name (best), an abbreviation such as PST, or an hour offset such as -5 or 5.5. Default UTC.',
  inputSchema: schema({
    timezone: { anyOf: [{ type: 'string' }, { type: 'number' }], default: 0, description: 'IANA name (Europe/Berlin), abbreviation (PST, CET) or offset in hours (-5, 5.5).' },
  }),
  annotations: READ,
  async run(args) {
    const now = Date.now();
    const { zone, offset } = zoneNow(args.timezone ?? args.time_zone, now);
    const wall = new Date(now + offset * MINUTE_MS);
    const [y, mo, d, h, mi, sec] = [wall.getUTCFullYear(), wall.getUTCMonth() + 1, wall.getUTCDate(), wall.getUTCHours(), wall.getUTCMinutes(), wall.getUTCSeconds()];
    const micros = String(wall.getUTCMilliseconds() * 1000).padStart(6, '0');
    return {
      current_datetime: `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(sec)}.${micros}${offsetText(offset)}`,
      yyyymmdd_datetime: [y, mo, d, h, mi, sec].join(','),
      timezone: zone,
      day_of_week: WEEKDAYS[wall.getUTCDay()] ?? '',
    };
  },
};

const getCurrentUser: GoogleTool = {
  name: 'get_current_user',
  title: 'Current Calendar user',
  description: 'The connected account as Calendar sees it: email, primary calendar id, calendar name and time zone.',
  inputSchema: schema({}),
  annotations: READ,
  async run(_args, ctx) {
    const calendar = await ctx.google.json<CalendarMeta>({ url: calendarPath('primary') });
    const id = calendar?.id ?? '';
    return {
      account_id: id,
      primary_calendar_id: id,
      ...(id.includes('@') ? { email: id } : {}),
      display_name: calendar?.summary ?? '',
      time_zone: calendar?.timeZone ?? '',
    };
  },
};

// ─── Calendars and the calendar list ────────────────────────────────────────

const listCalendars: GoogleTool = {
  name: 'list_calendars',
  title: 'List calendars',
  description:
    'List the calendars in the account\'s calendar list: id, name, access role, color, time zone. Use the ids, not the names, with the event tools. ' +
    'Follow next_page_token with page_token until it is absent.',
  inputSchema: schema({
    max_results: i('Calendars per page, up to 250.', { default: 100 }),
    page_token: s('next_page_token of the previous page. `pageToken` is an alias.'),
    sync_token: s('next_sync_token of an earlier list: only changes since then. Google answers 410 when it expired.'),
    show_hidden: b('Include calendars hidden from the list.', { default: false }),
    show_deleted: b('Include removed calendars.', { default: false }),
    min_access_role: s('Only calendars where you have at least this role.', { enum: ['freeBusyReader', 'reader', 'writerWithoutPrivateAccess', 'writer', 'owner'] }),
  }),
  annotations: READ,
  async run(args, ctx) {
    const sync = syncToken(args);
    const list = await ctx.google.json<{ items?: CalendarEntry[]; nextPageToken?: string; nextSyncToken?: string }>({
      url: CALENDAR_LIST,
      query: {
        maxResults: int(args, ['max_results', 'maxResults'], 250) ?? 100,
        pageToken: pageToken(args),
        syncToken: sync,
        // Google refuses these next to a sync token (it shows hidden and deleted entries then).
        ...(sync
          ? {}
          : {
              showHidden: flag(args, 'show_hidden', 'showHidden'),
              showDeleted: flag(args, 'show_deleted', 'showDeleted'),
              minAccessRole: optStr(args, 'min_access_role', 'minAccessRole'),
            }),
      },
    });
    return {
      calendars: (list?.items ?? []).map((calendar) => withCalendarUrl(calendar)),
      ...(list?.nextPageToken ? { next_page_token: list.nextPageToken } : {}),
      ...(list?.nextSyncToken ? { next_sync_token: list.nextSyncToken } : {}),
    };
  },
};

const calendarListGet: GoogleTool = {
  name: 'calendar_list_get',
  title: 'Get calendar list entry',
  description: 'One calendar of the calendar list with the account\'s own view of it: access role, color, hidden, default reminders, notifications.',
  inputSchema: schema({ calendarId: s('Calendar id, or `primary`. `calendar_id` is an alias.') }, ['calendarId']),
  annotations: READ,
  async run(args, ctx) {
    const id = calendarArg(args);
    return withCalendarUrl(await ctx.google.json<Json>({ url: `${CALENDAR_LIST}/${enc(id)}` }), id);
  },
};

const getCalendarProfile: GoogleTool = {
  name: 'get_calendar_profile',
  title: 'Get primary calendar profile',
  description: 'Deprecated: use calendar_list_get. The primary calendar\'s list entry: id, name, time zone, access role, reminders.',
  inputSchema: schema({}),
  annotations: READ,
  run: async (_args, ctx) => withCalendarUrl(await ctx.google.json<Json>({ url: `${CALENDAR_LIST}/primary` })),
};

const getCalendar: GoogleTool = {
  name: 'get_calendar',
  title: 'Get calendar',
  description: 'One calendar\'s own metadata: title, description, location, time zone, conferencing. `primary` by default.',
  inputSchema: schema({ calendar_id: CALENDAR_ID }),
  annotations: READ,
  async run(args, ctx) {
    const calendar = await ctx.google.json<Json>({ url: calendarPath(calendarArg(args)) });
    return { calendar_data: calendar, display_url: withCalendarUrl(calendar).display_url };
  },
};

const CALENDAR_PROPS = {
  summary: s('Title.'),
  description: s('Description.'),
  location: s('Location, as free text.'),
  timezone: s('IANA time zone, such as Europe/Zurich. Default: the primary calendar\'s.'),
};

/** summary, description, location and timeZone from the arguments. */
function calendarBody(args: Json): Json {
  const timeZone = zoneArg(args, 'timezone', 'timeZone', 'time_zone');
  return { ...pick(args, ['summary', 'description', 'location']), ...(timeZone ? { timeZone } : {}) };
}

async function createCalendarWith(ctx: ToolContext, body: Json): Promise<Json> {
  const timeZone = body.timeZone ?? (await readCalendar(ctx, 'primary'))?.timeZone;
  const calendar = await ctx.google.json<Json>({ method: 'POST', url: `${CAL}/calendars`, body: { ...body, ...(timeZone ? { timeZone } : {}) } });
  return withCalendarUrl(calendar);
}

const createCalendar: GoogleTool = {
  name: 'create_calendar',
  title: 'Create calendar',
  description: 'Create a secondary calendar owned by the account. Its time zone defaults to the primary calendar\'s.',
  inputSchema: schema(CALENDAR_PROPS, ['summary']),
  annotations: WRITE,
  run: (args, ctx) => createCalendarWith(ctx, { ...calendarBody(args), summary: reqStr(args, 'summary') }),
};

const duplicateCalendar: GoogleTool = {
  name: 'duplicate_calendar',
  title: 'Create empty calendar',
  description: 'Create a new, empty calendar with this title, in the primary calendar\'s time zone. No events are copied.',
  inputSchema: schema({ summary: s('Title of the new calendar.') }, ['summary']),
  annotations: WRITE,
  run: (args, ctx) => createCalendarWith(ctx, { summary: reqStr(args, 'summary') }),
};

const patchCalendar: GoogleTool = {
  name: 'patch_calendar',
  title: 'Change calendar',
  description: 'Change a calendar\'s title, description, location or time zone. Fields you leave out stay.',
  inputSchema: schema({ calendar_id: s('Calendar id, or `primary`.'), ...CALENDAR_PROPS, timezone: s('IANA time zone, such as Europe/Zurich.') }, ['calendar_id']),
  annotations: { ...WRITE, idempotentHint: true },
  async run(args, ctx) {
    const body = calendarBody(args);
    if (!Object.keys(body).length) throw new ToolInputError('Pass at least one of summary, description, location or timezone');
    const calendar = await ctx.google.json<Json>({ method: 'PATCH', url: calendarPath(calendarArg(args)), body });
    return { response_data: calendar, display_url: withCalendarUrl(calendar).display_url };
  },
};

const calendarsUpdate: GoogleTool = {
  name: 'calendars_update',
  title: 'Update calendar',
  description: 'Set a calendar\'s title and, when given, its description, location and time zone. Fields you leave out keep their values.',
  inputSchema: schema(
    {
      calendarId: s('Calendar id, or `primary`. `calendar_id` is an alias.'),
      summary: s('Title. It cannot be empty.'),
      description: s('Description.'),
      location: s('Location.'),
      timeZone: s('IANA time zone, such as Europe/Zurich.'),
    },
    ['calendarId', 'summary'],
  ),
  annotations: { ...WRITE, idempotentHint: true },
  async run(args, ctx) {
    const id = calendarArg(args);
    const current = await ctx.google.json<Json>({ url: calendarPath(id) });
    const body = { ...pick(current ?? {}, ['summary', 'description', 'location', 'timeZone']), ...calendarBody(args), summary: reqStr(args, 'summary') };
    return withCalendarUrl(await ctx.google.json<Json>({ method: 'PUT', url: calendarPath(id), body }));
  },
};

const calendarsDelete: GoogleTool = {
  name: 'calendars_delete',
  title: 'Delete calendar',
  description: 'Delete a secondary calendar you own, with all its events. This cannot be undone. The primary calendar cannot be deleted: clear_calendar empties it.',
  inputSchema: schema({ calendar_id: s('Id of a secondary calendar you own (accessRole owner in list_calendars).') }, ['calendar_id']),
  annotations: DESTRUCTIVE,
  async run(args, ctx) {
    const id = reqStr(args, 'calendar_id', 'calendarId').trim();
    if (id === 'primary') throw new ToolInputError('The primary calendar cannot be deleted; clear_calendar deletes its events');
    await ctx.google.json({ method: 'DELETE', url: calendarPath(id) });
    return { message: 'Calendar deleted.', calendar_id: id };
  },
};

const clearCalendar: GoogleTool = {
  name: 'clear_calendar',
  title: 'Clear primary calendar',
  description: 'Delete every event of the primary calendar; the calendar stays. Google refuses this for secondary calendars.',
  inputSchema: schema({ calendar_id: s('`primary` or the account\'s own email address.') }, ['calendar_id']),
  annotations: DESTRUCTIVE,
  async run(args, ctx) {
    const id = reqStr(args, 'calendar_id', 'calendarId').trim();
    await ctx.google.json({ method: 'POST', url: `${calendarPath(id)}/clear` });
    return { message: 'Every event of the calendar was deleted.', display_url: calendarUrl(id === 'primary' ? undefined : id) };
  },
};

const LIST_FIELDS = ['hidden', 'colorId', 'selected', 'backgroundColor', 'foregroundColor', 'summaryOverride', 'defaultReminders', 'notificationSettings'];

const LIST_PROPS = {
  summaryOverride: s('Your own name for the calendar.'),
  colorId: s('Calendar color id (colors_get).'),
  backgroundColor: s('Background color, hex such as #0088aa. Sets the RGB color mode.'),
  foregroundColor: s('Text color, hex such as #ffffff.'),
  hidden: b('Hide it from the list.'),
  selected: b('Show its events in the calendar view.'),
  defaultReminders: arr({ type: 'object', additionalProperties: true }, 'Default reminders: [{method: email|popup, minutes}].'),
  notificationSettings: anyObj('{notifications: [{type, method}]}.'),
};

/** colorRgbFormat must be true whenever an RGB color is written. */
const colorRgbFormat = (args: Json, body: Json) => flag(args, 'color_rgb_format', 'colorRgbFormat') ?? (body.backgroundColor || body.foregroundColor ? true : undefined);

const calendarListInsert: GoogleTool = {
  name: 'calendar_list_insert',
  title: 'Add calendar to list',
  description: 'Add an existing calendar, such as a colleague\'s or a shared one, to the account\'s calendar list.',
  inputSchema: schema({ id: s('Calendar id, such as ada@example.com or …@group.calendar.google.com.'), ...LIST_PROPS, color_rgb_format: b('Write backgroundColor/foregroundColor as RGB.') }, ['id']),
  annotations: { ...WRITE, idempotentHint: true },
  async run(args, ctx) {
    const body = { id: reqStr(args, 'id', 'calendar_id'), ...pick(args, LIST_FIELDS) };
    return withCalendarUrl(await ctx.google.json<Json>({ method: 'POST', url: CALENDAR_LIST, query: { colorRgbFormat: colorRgbFormat(args, body) }, body }));
  },
};

function calendarListUpdate(name: string, method: 'PATCH' | 'PUT'): GoogleTool {
  return {
    name,
    title: method === 'PATCH' ? 'Change calendar list entry' : 'Update calendar list entry',
    description: 'Change how a calendar shows in the list: your name for it, color, hidden, selected, default reminders, notifications. Fields you leave out stay.',
    inputSchema: schema({ calendar_id: s('Calendar id, or `primary`.'), ...LIST_PROPS, colorRgbFormat: b('Write backgroundColor/foregroundColor as RGB.') }, ['calendar_id']),
    annotations: { ...WRITE, idempotentHint: true },
    async run(args, ctx) {
      const id = calendarArg(args);
      const url = `${CALENDAR_LIST}/${enc(id)}`;
      const changes = pick(args, LIST_FIELDS);
      // PUT replaces the entry: start from the current one so omitted fields stay.
      const body = method === 'PUT' ? { ...pick((await ctx.google.json<Json>({ url })) ?? {}, LIST_FIELDS), ...changes } : changes;
      return withCalendarUrl(await ctx.google.json<Json>({ method, url, query: { colorRgbFormat: colorRgbFormat(args, changes) }, body }), id);
    },
  };
}

const calendarListDelete: GoogleTool = {
  name: 'calendar_list_delete',
  title: 'Remove calendar from list',
  description: 'Remove a calendar from the account\'s calendar list (unsubscribe). The calendar and its events still exist.',
  inputSchema: schema({ calendar_id: s('Calendar id.') }, ['calendar_id']),
  annotations: DESTRUCTIVE,
  async run(args, ctx) {
    const id = reqStr(args, 'calendar_id', 'calendarId').trim();
    await ctx.google.json({ method: 'DELETE', url: `${CALENDAR_LIST}/${enc(id)}` });
    return { message: 'Calendar removed from the list. The calendar itself still exists.', calendar_id: id };
  },
};

// ─── Sharing (ACL) ──────────────────────────────────────────────────────────

const ROLE = s('none, freeBusyReader, reader, writer or owner.', { enum: ['none', 'freeBusyReader', 'reader', 'writer', 'owner'] });
const SCOPE = anyObj('Who: {type: user|group|domain|default, value: email or domain}. `"user:ada@example.com"` works too.');
const RULE_ID = s('Rule id, such as `user:ada@example.com`, `domain:example.com` or `default`.');
const aclPath = (calendar: string, rule?: string) => `${calendarPath(calendar)}/acl${rule ? `/${enc(rule)}` : ''}`;

/** A scope object from {type, value}, `type:value`, or `default`. */
function aclScope(args: Json, fallbackRule?: string): Json | undefined {
  const object = optObj(args, 'scope');
  if (object) return object;
  const text = optStr(args, 'scope')?.trim() ?? fallbackRule;
  if (!text) return undefined;
  if (text === 'default') return { type: 'default' };
  const colon = text.indexOf(':');
  if (colon < 1) throw new ToolInputError('scope must be {type, value} or "user:ada@example.com"');
  return { type: text.slice(0, colon), value: text.slice(colon + 1) };
}

const withAclUrl = (rule: Json | null, calendar: string): Json => ({ ...rule, display_url: calendarUrl(calendar === 'primary' ? undefined : calendar) });

const aclList: GoogleTool = {
  name: 'acl_list',
  title: 'List calendar sharing',
  description: 'List who a calendar is shared with and their roles.',
  inputSchema: schema(
    {
      calendarId: s('Calendar id, or `primary`. `calendar_id` is an alias.'),
      maxResults: i('Rules per page. Google defaults to 100.'),
      pageToken: PAGE_TOKEN,
      syncToken: s('nextSyncToken of an earlier list: only changes since then.'),
      showDeleted: b('Include removed rules (role none).'),
    },
    ['calendarId'],
  ),
  annotations: READ,
  async run(args, ctx) {
    const calendar = calendarArg(args);
    const list = await ctx.google.json<Json>({
      url: aclPath(calendar),
      query: { maxResults: int(args, ['maxResults', 'max_results']), pageToken: pageToken(args), syncToken: syncToken(args), showDeleted: flag(args, 'showDeleted', 'show_deleted') },
    });
    return withAclUrl(list, calendar);
  },
};

const aclGet: GoogleTool = {
  name: 'acl_get',
  title: 'Get sharing rule',
  description: 'One sharing rule of a calendar: who and which role.',
  inputSchema: schema({ calendar_id: s('Calendar id, or `primary`.'), rule_id: RULE_ID }, ['calendar_id', 'rule_id']),
  annotations: READ,
  async run(args, ctx) {
    const calendar = calendarArg(args);
    return withAclUrl(await ctx.google.json<Json>({ url: aclPath(calendar, reqStr(args, 'rule_id', 'ruleId')) }), calendar);
  },
};

const aclInsert: GoogleTool = {
  name: 'acl_insert',
  title: 'Share calendar',
  description: 'Share a calendar: give a user, group, domain or everyone (`default`) a role. The person gets an email unless send_notifications is false.',
  inputSchema: schema({ calendar_id: s('Calendar id, or `primary`.'), role: ROLE, scope: SCOPE, send_notifications: b('Email the person about it. Default true.') }, ['calendar_id', 'role', 'scope']),
  annotations: WRITE,
  async run(args, ctx) {
    const calendar = calendarArg(args);
    const scope = aclScope(args);
    if (!scope) throw new ToolInputError('scope is required');
    const rule = await ctx.google.json<Json>({
      method: 'POST',
      url: aclPath(calendar),
      query: { sendNotifications: flag(args, 'send_notifications', 'sendNotifications') },
      body: { role: reqStr(args, 'role'), scope },
    });
    return withAclUrl(rule, calendar);
  },
};

function aclChange(name: string, method: 'PATCH' | 'PUT'): GoogleTool {
  return {
    name,
    title: 'Change sharing rule',
    description: 'Change the role of an existing sharing rule. acl_insert creates a new one.',
    inputSchema: schema(
      { calendar_id: s('Calendar id, or `primary`.'), rule_id: RULE_ID, role: ROLE, scope: SCOPE, send_notifications: b('Email the person about it. Default true.') },
      method === 'PUT' ? ['calendar_id', 'rule_id', 'role'] : ['calendar_id', 'rule_id'],
    ),
    annotations: { ...WRITE, idempotentHint: true },
    async run(args, ctx) {
      const calendar = calendarArg(args);
      const ruleId = reqStr(args, 'rule_id', 'ruleId');
      const role = method === 'PUT' ? reqStr(args, 'role') : optStr(args, 'role');
      // PUT needs the scope; the rule id names it (`user:ada@example.com`).
      const scope = aclScope(args, method === 'PUT' ? ruleId : undefined);
      const rule = await ctx.google.json<Json>({
        method,
        url: aclPath(calendar, ruleId),
        query: { sendNotifications: flag(args, 'send_notifications', 'sendNotifications') },
        body: { ...(role ? { role } : {}), ...(scope ? { scope } : {}) },
      });
      return withAclUrl(rule, calendar);
    },
  };
}

const aclDelete: GoogleTool = {
  name: 'acl_delete',
  title: 'Stop sharing calendar',
  description: 'Delete a sharing rule: its user, group or domain loses access to the calendar.',
  inputSchema: schema({ calendar_id: s('Calendar id, or `primary`.'), rule_id: RULE_ID }, ['calendar_id', 'rule_id']),
  annotations: DESTRUCTIVE,
  async run(args, ctx) {
    await ctx.google.json({ method: 'DELETE', url: aclPath(calendarArg(args), reqStr(args, 'rule_id', 'ruleId')) });
    return { response_data: { status: 'success' } };
  },
};

// ─── Settings, colors, push notifications ───────────────────────────────────

const settingsGet: GoogleTool = {
  name: 'settings_get',
  title: 'Get Calendar setting',
  description: 'One Calendar setting of the account: timezone, locale, weekStart, defaultEventLength, format24HourTime, hideWeekends, …',
  inputSchema: schema({ setting: s('Setting id, such as timezone, locale, weekStart or defaultEventLength.') }, ['setting']),
  annotations: READ,
  run: async (args, ctx) => ({
    ...(await ctx.google.json<Json>({ url: `${SETTINGS}/${enc(reqStr(args, 'setting', 'setting_id', 'id'))}` })),
    display_url: SETTINGS_URL,
  }),
};

function settingsListTool(name: string, deprecated: boolean): GoogleTool {
  return {
    name,
    title: 'List Calendar settings',
    description: deprecated ? 'Deprecated: use settings_list. Every Calendar setting of the account.' : 'Every Calendar setting of the account, such as timezone, locale and weekStart.',
    inputSchema: schema({
      maxResults: i('Settings per page, up to 250.'),
      pageToken: PAGE_TOKEN,
      ...(deprecated ? {} : { syncToken: s('nextSyncToken of an earlier list: only changes since then.') }),
    }),
    annotations: READ,
    run: async (args, ctx) => ({
      ...(await ctx.google.json<Json>({
        url: SETTINGS,
        query: { maxResults: int(args, ['maxResults', 'max_results'], 250), pageToken: pageToken(args), syncToken: deprecated ? undefined : syncToken(args) },
      })),
      display_url: SETTINGS_URL,
    }),
  };
}

const colorsGet: GoogleTool = {
  name: 'colors_get',
  title: 'Get colors',
  description: 'The calendar and event color palettes: each colorId with its background and text colors.',
  inputSchema: schema({}),
  annotations: READ,
  run: (_args, ctx) => ctx.google.json({ url: `${CAL}/colors` }),
};

function watchTool(opts: { name: string; title: string; what: string; path: (args: Json) => string; calendar: boolean; extra?: Record<string, Record<string, unknown>> }): GoogleTool {
  return {
    name: opts.name,
    title: opts.title,
    description: `Ask Google to POST to an HTTPS address whenever ${opts.what} change. The channel expires; channels_stop ends it sooner.`,
    inputSchema: schema(
      {
        ...(opts.calendar ? { calendarId: s('Calendar id, or `primary`. `calendar_id` is an alias.') } : {}),
        id: s('Your unique channel id, such as a UUID (up to 64 characters).'),
        type: s('Delivery type: web_hook.', { default: 'web_hook' }),
        address: s('Public HTTPS URL that receives the notifications.'),
        token: s('Text Google sends back with each notification.'),
        params: anyObj('Channel parameters, such as {"ttl": "3600"}.'),
        ...opts.extra,
      },
      opts.calendar ? ['calendarId', 'id', 'address'] : ['id', 'type', 'address'],
    ),
    annotations: WRITE,
    run: (args, ctx) =>
      ctx.google.json({
        method: 'POST',
        url: opts.path(args),
        body: { id: reqStr(args, 'id'), type: 'web_hook', address: reqStr(args, 'address'), ...pick(args, ['token', 'params', 'expiration', 'payload']) },
      }),
  };
}

const EXPIRATION = { expiration: i('When the channel ends, epoch milliseconds.') };

const channelsStop: GoogleTool = {
  name: 'channels_stop',
  title: 'Stop push notifications',
  description: 'Stop a push-notification channel that a watch tool created.',
  inputSchema: schema({ id: s('The channel id.'), resourceId: s('resourceId from the watch answer.'), token: s('The channel token, if it had one.') }, ['id', 'resourceId']),
  annotations: DESTRUCTIVE,
  async run(args, ctx) {
    await ctx.google.json({
      method: 'POST',
      url: `${CAL}/channels/stop`,
      body: { id: reqStr(args, 'id'), resourceId: reqStr(args, 'resourceId', 'resource_id'), ...pick(args, ['token']) },
    });
    return { success: true };
  },
};

// ─── Workspace resources (Admin SDK) ────────────────────────────────────────

const ADMIN_NOTE = ' Needs a Workspace admin and an Admin SDK scope Kortix does not request, so Google answers 403.';

/** An Admin SDK read: Google's 403 becomes the reason, not a "reconnect" hint that cannot help. */
async function adminRead(ctx: ToolContext, url: string, query: Json): Promise<unknown> {
  try {
    return await ctx.google.json({ url, query });
  } catch (error) {
    if (error instanceof GoogleApiError && error.status === 403) {
      throw new ToolInputError('Google refused the Workspace directory read: it needs an admin account and an Admin SDK scope that Kortix does not request. Find rooms with free_busy_query or a guest list instead.');
    }
    throw error;
  }
}

const listBuildings: GoogleTool = {
  name: 'list_buildings',
  title: 'List buildings',
  description: `List the Workspace's buildings.${ADMIN_NOTE}`,
  inputSchema: schema({ customer: s('Customer id; my_customer is your own Workspace.', { default: 'my_customer' }), maxResults: i('Buildings per page.', { default: 25 }), pageToken: PAGE_TOKEN }),
  annotations: READ,
  run: (args, ctx) =>
    adminRead(ctx, `${ADMIN}/${enc(optStr(args, 'customer') ?? 'my_customer')}/resources/buildings`, {
      maxResults: int(args, ['maxResults', 'max_results']) ?? 25,
      pageToken: pageToken(args),
    }),
};

const listCalendarResources: GoogleTool = {
  name: 'list_calendar_resources',
  title: 'List rooms and resources',
  description: `List the Workspace's bookable rooms and equipment. Book one by adding its resourceEmail as a guest.${ADMIN_NOTE}`,
  inputSchema: schema({
    customer: s('Customer id; my_customer is your own Workspace.', { default: 'my_customer' }),
    query: s('Filter, such as `resourceCategory=CONFERENCE_ROOM AND capacity>=8`.'),
    orderBy: s('Sort, such as `capacity desc` or `resourceName`.'),
    maxResults: i('Resources per page.', { default: 25 }),
    pageToken: PAGE_TOKEN,
  }),
  annotations: READ,
  run: (args, ctx) =>
    adminRead(ctx, `${ADMIN}/${enc(optStr(args, 'customer') ?? 'my_customer')}/resources/calendars`, {
      query: optStr(args, 'query'),
      orderBy: optStr(args, 'orderBy', 'order_by'),
      maxResults: int(args, ['maxResults', 'max_results']) ?? 25,
      pageToken: pageToken(args),
    }),
};

export const CALENDAR_TOOLS: readonly GoogleTool[] = [
  eventsList,
  eventsListAllCalendars,
  eventsGet,
  findEvent,
  eventsInstances,
  syncEvents,
  createEvent,
  updateEvent,
  patchEvent,
  deleteEvent,
  removeAttendee,
  quickAdd,
  eventsMove,
  eventsImport,
  batchEvents,
  freeBusyQuery,
  findFreeSlots,
  getCurrentDateTime,
  getCurrentUser,
  listCalendars,
  calendarListGet,
  getCalendarProfile,
  getCalendar,
  createCalendar,
  duplicateCalendar,
  patchCalendar,
  calendarsUpdate,
  calendarsDelete,
  clearCalendar,
  calendarListInsert,
  calendarListUpdate('calendar_list_patch', 'PATCH'),
  calendarListUpdate('calendar_list_update', 'PUT'),
  calendarListDelete,
  aclList,
  aclGet,
  aclInsert,
  aclChange('acl_patch', 'PATCH'),
  aclChange('acl_update', 'PUT'),
  aclDelete,
  settingsGet,
  settingsListTool('settings_list', false),
  settingsListTool('list_settings', true),
  colorsGet,
  watchTool({ name: 'events_watch', title: 'Watch events', what: "a calendar's events", path: (args) => `${eventsPath(calendarArg(args))}/watch`, calendar: true, extra: { payload: b('Ask for a payload with each notification.') } }),
  watchTool({ name: 'acl_watch', title: 'Watch sharing', what: "a calendar's sharing rules", path: (args) => `${aclPath(calendarArg(args))}/watch`, calendar: true }),
  watchTool({ name: 'calendar_list_watch', title: 'Watch calendar list', what: 'the calendar list entries', path: () => `${CALENDAR_LIST}/watch`, calendar: false, extra: EXPIRATION }),
  watchTool({ name: 'settings_watch', title: 'Watch settings', what: 'the Calendar settings', path: () => `${SETTINGS}/watch`, calendar: false, extra: EXPIRATION }),
  channelsStop,
  listBuildings,
  listCalendarResources,
];
