/**
 * `kortix calendar` — the workspace's shared calendar (flag `calendar`).
 *
 * Items with a title, notes, an optional date or date and time, an optional
 * owner (one person or one agent) and comments. Every person and agent of the
 * workspace reads and writes every item. Inside a session the API records the
 * session's agent as the author. Wire contract:
 * `packages/api-contract/src/calendar.ts`; the flagged `kortix-calendar` skill
 * teaches the workflow.
 */
import {
  addWorkspaceCalendarComment,
  createWorkspaceCalendarItem,
  deleteWorkspaceCalendarItem,
  getWorkspaceCalendarItem,
  listWorkspaceCalendarItems,
  listWorkspaceCalendarPeople,
  updateWorkspaceCalendarItem,
  type CalendarAssigneeInput,
  type CalendarItem,
  type CalendarPeople,
  type UpdateCalendarItemInput,
} from '@kortix/sdk';
import type { Auth } from '../api/auth.ts';
import { ApiError, withCliErrors } from '../api/client.ts';
import { splitHelp } from '../command-argv.ts';
import { emitJson, fail, missing, resolveProjectContext, surfaceApiError, takeFlagBool, takeFlagValue } from '../command-helpers.ts';
import { C, help, status } from '../style.ts';

const HELP = help`Usage: kortix calendar <subcommand> [options]

The workspace's shared calendar. An item has a title, notes, a date (or a date
and time, or none), an owner (one person or one agent) and comments. Everyone
in the workspace sees every item. Someone else who @mentions a person or
assigns them an item notifies that person. A person's comment on an item you
created in this session comes back to this session as a message.

Subcommands:
  ls [--week | --days <n> | --from <date> --to <date>] [--mine] [--assignee <who>] [--done]
                      Items in the window (default: today and the next 6 days)
                      and the open items with no date.
  add "<title>" [--at <when> | --date <YYYY-MM-DD>] [--assign <who>] [--notes "<text>"]
                      Create an item. Put @handle in the notes to notify a person.
  show <id>           One item with its notes and comments.
  edit <id> [--title "<t>"] [--at <when> | --date <YYYY-MM-DD> | --no-date]
            [--assign <who> | --unassign] [--notes "<text>"]
                      Change only the fields given.
  done <id>           Mark it done.
  reopen <id>         Mark it open again.
  comment <id> "<text>"
                      Add a comment. @handle notifies that person.
  rm <id>             Delete the item and its comments.
  people              Who can be assigned or mentioned, with each @handle.

<when>: an ISO time ("2026-11-16T15:00:00+01:00"; without an offset it is
this machine's time zone), "today 15:00", "tomorrow 09:30", or "in 2h" / "in 3d".
<who>: "me" (you, or this session's agent), an email, a person's @handle,
or "agent:<name>".

Options:
  --json              Machine-readable output.
  -h, --help          Show this help.
`;

const SUBCOMMANDS = ['ls', 'list', 'add', 'show', 'edit', 'done', 'reopen', 'comment', 'rm', 'delete', 'people'];
const DAY_MS = 86_400_000;

interface Ctx {
  auth: Auth;
  projectId: string;
}

// ── Pure parsing (unit-tested) ──────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');

/** Local midnight of `d`. */
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** A local date and time as ISO with this machine's offset: `2026-11-16T15:00:00+01:00`. */
export function isoWithOffset(d: Date): string {
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * `<when>` as an ISO time: an ISO time (an offset is kept; none means local
 * time), `today [HH:MM]`, `tomorrow [HH:MM]`, or `in <n>m|h|d`. Null when it
 * cannot be read.
 */
export function parseWhen(input: string, now: Date = new Date()): string | null {
  const text = input.trim().toLowerCase();
  const relative = /^(?:in\s+|\+)(\d+)\s*(m|min|h|d)$/.exec(text);
  if (relative) {
    const n = Number(relative[1]);
    const unit = relative[2]!.startsWith('m') ? 60_000 : relative[2] === 'h' ? 3_600_000 : DAY_MS;
    return new Date(now.getTime() + n * unit).toISOString();
  }
  const named = /^(today|tomorrow)(?:\s+(\d{1,2}):(\d{2}))?$/.exec(text);
  if (named) {
    if (named[2] && (Number(named[2]) > 23 || Number(named[3]) > 59)) return null;
    const day = startOfDay(now);
    if (named[1] === 'tomorrow') day.setDate(day.getDate() + 1);
    day.setHours(named[2] ? Number(named[2]) : 9, named[3] ? Number(named[3]) : 0, 0, 0);
    return isoWithOffset(day);
  }
  const iso = /^(\d{4}-\d{2}-\d{2})[t ](\d{1,2}):(\d{2})(?::(\d{2}))?(\.\d+)?(z|[+-]\d{2}:?\d{2})?$/.exec(text);
  if (iso) {
    const [, date, h, m, s, , zone] = iso;
    if (!parseDate(date!) || Number(h) > 23 || Number(m) > 59 || Number(s ?? 0) > 59) return null;
    const clock = `${pad(Number(h))}:${m}:${s ?? '00'}`;
    if (zone) {
      const parsed = new Date(`${date}T${clock}${zone === 'z' ? 'Z' : zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone}`);
      return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    }
    const [y, mo, d] = date!.split('-').map(Number);
    const local = new Date(y!, mo! - 1, d!, Number(h), Number(m), Number(s ?? 0));
    return Number.isNaN(local.getTime()) ? null : isoWithOffset(local);
  }
  return null;
}

/** `YYYY-MM-DD` as the all-day `starts_at` the API keeps (UTC midnight). Null when it is not a date. */
export function parseDate(input: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
  if (!match) return null;
  const date = new Date(`${input.trim()}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== input.trim() ? null : date.toISOString();
}

/**
 * `<who>` as an assignee: `me`, an email, `agent:<name>`, or a person's
 * @handle from the directory. A bare name that is no handle is an agent name.
 */
export function parseWho(input: string, directory: Pick<CalendarPeople, 'people'> | null): CalendarAssigneeInput {
  const who = input.trim().replace(/^@/, '');
  if (who.toLowerCase() === 'me') return { me: true };
  if (who.toLowerCase().startsWith('agent:')) return { agent: who.slice(6) };
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(who)) return { email: who };
  const person = directory?.people.find((p) => p.handle.toLowerCase() === who.toLowerCase());
  if (person) return { user_id: person.user_id };
  return { agent: who };
}

/** The list window: `--week` (Monday to Sunday), `--days n` from today, or `--from`/`--to` dates. */
export function listWindow(flags: { week: boolean; days?: string; from?: string; to?: string }, now: Date = new Date()): { from: string; to: string } | string {
  const today = startOfDay(now);
  if (flags.from || flags.to) {
    const from = flags.from ? parseWindowDate(flags.from) : today;
    const to = flags.to ? parseWindowDate(flags.to) : null;
    if (!from) return `--from "${flags.from}" is not a date (YYYY-MM-DD).`;
    if (flags.to && !to) return `--to "${flags.to}" is not a date (YYYY-MM-DD).`;
    const end = to ? new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1) : new Date(from.getFullYear(), from.getMonth(), from.getDate() + 7);
    return { from: from.toISOString(), to: end.toISOString() };
  }
  if (flags.week) {
    const monday = new Date(today);
    monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    const next = new Date(monday);
    next.setDate(monday.getDate() + 7);
    return { from: monday.toISOString(), to: next.toISOString() };
  }
  const days = flags.days ? Number(flags.days) : 7;
  if (!Number.isInteger(days) || days < 1 || days > 93) return '--days takes 1 to 93.';
  const end = new Date(today);
  end.setDate(today.getDate() + days);
  return { from: today.toISOString(), to: end.toISOString() };
}

function parseWindowDate(input: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

// ── Output ──────────────────────────────────────────────────────────────────

function whenLabel(item: CalendarItem): string {
  if (!item.starts_at) return 'no date';
  const at = new Date(item.starts_at);
  if (item.all_day) return item.starts_at.slice(0, 10);
  return isoWithOffset(at).slice(0, 16).replace('T', ' ');
}

function ownerLabel(item: CalendarItem, directory: CalendarPeople | null): string {
  if (!item.assignee) return '';
  if (item.assignee.kind === 'agent') return `agent:${item.assignee.agent}`;
  const userId = item.assignee.user_id;
  const person = directory?.people.find((p) => p.user_id === userId);
  return person ? `@${person.handle}` : userId;
}

function authorLabel(author: CalendarItem['created_by'], directory: CalendarPeople | null): string {
  if (author.kind === 'agent') return `agent:${author.agent}`;
  const person = directory?.people.find((p) => p.user_id === author.user_id);
  return person ? `@${person.handle}` : author.user_id;
}

function printItems(items: CalendarItem[], directory: CalendarPeople | null): void {
  if (items.length === 0) {
    process.stdout.write(`${C.dim}No items.${C.reset}\n`);
    return;
  }
  for (const item of items) {
    const owner = ownerLabel(item, directory);
    const meta = [whenLabel(item), item.status, owner, item.comment_count ? `${item.comment_count} comment${item.comment_count === 1 ? '' : 's'}` : '']
      .filter(Boolean)
      .join(' · ');
    process.stdout.write(`${item.item_id}  ${C.bold}${item.title}${C.reset}\n  ${C.dim}${meta}${C.reset}\n`);
  }
}

// ── Commands ────────────────────────────────────────────────────────────────

async function people(ctx: Ctx): Promise<CalendarPeople | null> {
  return withCliErrors(ctx.auth, () => listWorkspaceCalendarPeople(ctx.projectId)).catch(() => null);
}

/** `--at`, `--date` or `--no-date` as the date fields of a body; a string is a usage error. */
function dateFields(argv: string[]): Pick<UpdateCalendarItemInput, 'starts_at' | 'all_day'> | string | null {
  const at = takeFlagValue(argv, ['--at']);
  const date = takeFlagValue(argv, ['--date']);
  const none = takeFlagBool(argv, ['--no-date']);
  if ([at !== undefined, date !== undefined, none].filter(Boolean).length > 1) return 'Pass one of --at, --date and --no-date.';
  if (none) return { starts_at: null, all_day: false };
  if (date !== undefined) {
    const startsAt = parseDate(date);
    return startsAt ? { starts_at: startsAt, all_day: true } : `--date "${date}" is not a date (YYYY-MM-DD).`;
  }
  if (at !== undefined) {
    const startsAt = parseWhen(at);
    return startsAt ? { starts_at: startsAt, all_day: false } : `--at "${at}" is not a time. Use an ISO time, "today 15:00", "tomorrow 09:30" or "in 2h".`;
  }
  return null;
}

async function list(ctx: Ctx, argv: string[], json: boolean): Promise<number> {
  const week = takeFlagBool(argv, ['--week']);
  const done = takeFlagBool(argv, ['--done']);
  const mine = takeFlagBool(argv, ['--mine']);
  const days = takeFlagValue(argv, ['--days']);
  const from = takeFlagValue(argv, ['--from']);
  const to = takeFlagValue(argv, ['--to']);
  const who = takeFlagValue(argv, ['--assignee']);
  const window = listWindow({ week, days, from, to });
  if (typeof window === 'string') return fail(window);
  const directory = await people(ctx);
  let assignee: string | undefined = mine ? 'me' : undefined;
  if (who) {
    const parsed = parseWho(who, directory);
    if ('me' in parsed) assignee = 'me';
    else if ('agent' in parsed) assignee = `agent:${parsed.agent}`;
    else if ('user_id' in parsed) assignee = `user:${parsed.user_id}`;
    else {
      const person = directory?.people.find((p) => p.email?.toLowerCase() === parsed.email.toLowerCase());
      if (!person) return fail(`No person with the email ${parsed.email} in this workspace.`);
      assignee = `user:${person.user_id}`;
    }
  }
  const items = await withCliErrors(ctx.auth, () =>
    listWorkspaceCalendarItems(ctx.projectId, { ...window, assignee, status: done ? 'done' : undefined }));
  if (json) emitJson({ from: window.from, to: window.to, items });
  else printItems(items, directory);
  return 0;
}

async function add(ctx: Ctx, argv: string[], json: boolean): Promise<number> {
  const dates = dateFields(argv);
  if (typeof dates === 'string') return fail(dates);
  const who = takeFlagValue(argv, ['--assign', '--assignee']);
  const notes = takeFlagValue(argv, ['--notes']);
  const title = argv.join(' ').trim();
  if (!title) return missing('a title: kortix calendar add "<title>"');
  const assignee = who ? parseWho(who, await people(ctx)) : undefined;
  const item = await withCliErrors(ctx.auth, () =>
    createWorkspaceCalendarItem(ctx.projectId, { title, ...(notes !== undefined ? { notes } : {}), ...(dates ?? {}), ...(assignee ? { assignee } : {}) }));
  if (json) emitJson({ ok: true, item });
  else process.stdout.write(`${status.ok(`Added ${item.item_id}: ${item.title} (${whenLabel(item)})`)}\n`);
  return 0;
}

async function show(ctx: Ctx, itemId: string | undefined, json: boolean): Promise<number> {
  if (!itemId) return missing('an item id: kortix calendar show <id>');
  const [detail, directory] = await Promise.all([withCliErrors(ctx.auth, () => getWorkspaceCalendarItem(ctx.projectId, itemId)), people(ctx)]);
  if (json) {
    emitJson(detail);
    return 0;
  }
  const { item, comments } = detail;
  const lines = [
    `${C.bold}${item.title}${C.reset}`,
    `  ${C.dim}id${C.reset}        ${item.item_id}`,
    `  ${C.dim}when${C.reset}      ${whenLabel(item)}`,
    `  ${C.dim}status${C.reset}    ${item.status}`,
    `  ${C.dim}owner${C.reset}     ${ownerLabel(item, directory) || 'nobody'}`,
    `  ${C.dim}created${C.reset}   ${authorLabel(item.created_by, directory)}, ${item.created_at}`,
  ];
  if (item.notes) lines.push('', item.notes);
  if (comments.length) {
    lines.push('', `${C.bold}Comments${C.reset}`);
    for (const comment of comments) lines.push(`  ${C.dim}${authorLabel(comment.author, directory)} · ${comment.created_at}${C.reset}`, `  ${comment.body.replace(/\n/g, '\n  ')}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

async function edit(ctx: Ctx, itemId: string | undefined, argv: string[], json: boolean, fixed: UpdateCalendarItemInput = {}): Promise<number> {
  if (!itemId) return missing('an item id');
  const dates = dateFields(argv);
  if (typeof dates === 'string') return fail(dates);
  const title = takeFlagValue(argv, ['--title']);
  const notes = takeFlagValue(argv, ['--notes']);
  const who = takeFlagValue(argv, ['--assign', '--assignee']);
  const unassign = takeFlagBool(argv, ['--unassign']);
  if (who && unassign) return fail('Pass --assign or --unassign, not both.');
  const input: UpdateCalendarItemInput = {
    ...fixed,
    ...(title !== undefined ? { title } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(dates ?? {}),
    ...(unassign ? { assignee: null } : who ? { assignee: parseWho(who, await people(ctx)) } : {}),
  };
  if (Object.keys(input).length === 0) return fail('Nothing to change. Run `kortix calendar edit --help`.');
  const item = await withCliErrors(ctx.auth, () => updateWorkspaceCalendarItem(ctx.projectId, itemId, input));
  if (json) emitJson({ ok: true, item });
  else process.stdout.write(`${status.ok(`${item.title}: ${item.status}, ${whenLabel(item)}`)}\n`);
  return 0;
}

async function comment(ctx: Ctx, itemId: string | undefined, text: string, json: boolean): Promise<number> {
  if (!itemId) return missing('an item id');
  if (!text) return missing('the comment: kortix calendar comment <id> "<text>"');
  const created = await withCliErrors(ctx.auth, () => addWorkspaceCalendarComment(ctx.projectId, itemId, text));
  if (json) emitJson({ ok: true, comment: created });
  else process.stdout.write(`${status.ok('Comment added.')}\n`);
  return 0;
}

async function remove(ctx: Ctx, itemId: string | undefined, json: boolean): Promise<number> {
  if (!itemId) return missing('an item id');
  await withCliErrors(ctx.auth, () => deleteWorkspaceCalendarItem(ctx.projectId, itemId));
  if (json) emitJson({ ok: true, deleted: itemId });
  else process.stdout.write(`${status.ok(`Deleted ${itemId}.`)}\n`);
  return 0;
}

/** A calendar refusal (`calendar_invalid` with violations, `calendar_not_found`) in its own words. */
function failure(err: unknown, json: boolean): number {
  const body = err instanceof ApiError ? (err.body as { error?: string; message?: string; violations?: string[] } | undefined) : undefined;
  if (body?.error === 'calendar_invalid' || body?.error === 'calendar_not_found') {
    const violations = body.violations ?? [];
    if (json) emitJson({ ok: false, error: body.error, message: body.message, violations });
    else process.stderr.write(`${status.err(body.message ?? body.error)}\n${violations.map((v) => `  - ${v}`).join('\n')}${violations.length ? '\n' : ''}`);
    return 1;
  }
  return surfaceApiError(err);
}

export async function runCalendar(argv: string[]): Promise<number> {
  const helpExit = splitHelp(argv, HELP);
  if (helpExit !== null) return helpExit;
  const rest = [...argv];
  const sub = rest[0] && !rest[0].startsWith('-') ? rest.shift()! : 'ls';
  if (!SUBCOMMANDS.includes(sub)) return fail(`Unknown subcommand "${sub}". Run \`kortix calendar --help\`.`);
  const json = takeFlagBool(rest, ['--json']);
  const resolved = await resolveProjectContext({});
  if (!resolved) return 1;
  const ctx: Ctx = { auth: resolved.auth, projectId: resolved.projectId };
  try {
    switch (sub) {
      case 'add':
        return await add(ctx, rest, json);
      case 'show':
        return await show(ctx, rest[0], json);
      case 'edit':
        return await edit(ctx, rest.shift(), rest, json);
      case 'done':
        return await edit(ctx, rest.shift(), rest, json, { status: 'done' });
      case 'reopen':
        return await edit(ctx, rest.shift(), rest, json, { status: 'open' });
      case 'comment':
        return await comment(ctx, rest.shift(), rest.join(' ').trim(), json);
      case 'rm':
      case 'delete':
        return await remove(ctx, rest[0], json);
      case 'people': {
        const directory = await withCliErrors(ctx.auth, () => listWorkspaceCalendarPeople(ctx.projectId));
        if (json) emitJson(directory);
        else {
          for (const p of directory.people) process.stdout.write(`@${p.handle}  ${C.dim}${[p.name, p.email].filter(Boolean).join(' · ')}${C.reset}\n`);
          for (const a of directory.agents) process.stdout.write(`agent:${a.name}\n`);
        }
        return 0;
      }
      default:
        return await list(ctx, rest, json);
    }
  } catch (err) {
    return failure(err, json);
  }
}
