/**
 * Slack and Teams connector reads, confined to what the calling project may
 * see.
 *
 * SLACK. One Slack workspace runs in one Kortix workspace, so its reads are
 * gated by the link and by the person's own view of private conversations
 * (slack-visibility.ts). This module only classifies Slack's actions.
 *
 * TEAMS. The managed Teams app mints one Graph token per tenant, and every
 * project connected to the same tenant resolves that SAME credential
 * (`channelToken` in db-deps.ts). The token alone let an agent in one project
 * read every conversation the bot is in: other projects' channels and threads
 * included (found in the 2026-09-29 permissions audit). This module is the
 * rule the gateway applies on top of the token.
 *
 * THE TEAMS RULE. A read reaches a conversation only when it belongs to the
 * calling project:
 *   1. A conversation or thread that belongs to another project is refused.
 *   2. One that belongs to this project is allowed.
 *   3. One that belongs to no project is allowed only while no other project is
 *      connected to the same Teams tenant.
 *
 * Ownership comes from rows only the chat paths write: every channel post is
 * its own conversation (`19:…@thread.tacv2;messageid=…`), a Teams channel
 * belongs to every project that has a conversation in it, and a per-thread
 * binding decides a thread no session owns.
 *
 * Not confined here: directory reads (people, teams, team members, the bot's
 * own identity) and the metadata of standard Teams channels. Writes are not
 * confined here either.
 */
import { and, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { chatChannelBindings, chatInstalls, chatThreads } from '@kortix/db';
import { db } from '../shared/db';
import { isRecord } from '@kortix/shared/guards';
import { SLACK_NOT_LINKED, SLACK_PRIVATE_CONVERSATION, gateSlackRead, type SlackReadDeps } from './slack-visibility';
import { dbSlackReadDeps } from './slack-visibility-db';

export const CONVERSATION_NOT_IN_PROJECT = 'conversation_not_in_project';

export interface ChannelReadRefusal {
  reason: typeof CONVERSATION_NOT_IN_PROJECT | typeof SLACK_NOT_LINKED | typeof SLACK_PRIVATE_CONVERSATION;
  /** What the agent reads: which conversation, why, and how to fix it. */
  message: string;
}

export interface ChannelReadInput {
  projectId: string;
  /** The calling session, from its token; null for a call no session makes. Telegram writes are confined by it (channel-write-scope.ts). */
  sessionId?: string | null;
  /** The Kortix user the call acts for. A Slack read reaches a private conversation only when this person is in it (slack-visibility.ts). */
  userId?: string | null;
  /** The channel connector's platform. Reads are confined for `slack` and `teams`. */
  platform: string | null;
  actionPath: string;
  args: Record<string, unknown>;
  risk: string;
}

/** The confinement of one call: checked before the provider call, then on its answer. */
export interface ChannelReadGate {
  /** Set when the read must not reach the provider at all. */
  refusal: ChannelReadRefusal | null;
  /** The provider's successful answer as this project may see it, or a refusal. */
  answer(data: unknown): Promise<Answer>;
}

type Platform = 'slack' | 'teams';

/**
 * How each catalog action touches conversations. A unit test fails when a
 * Slack or Teams catalog action has no entry, so a new action is classified
 * before it ships. A read action missing here is refused at call time.
 */
export type ChannelReadScope =
  /** The args name one channel; the channel decides. Checked before the call. */
  | 'channel'
  /** The args name one thread; its owner, else its channel, decides. Checked before the call. */
  | 'thread'
  /** One channel's metadata: public/standard passes, any other as `channel`. Checked on the answer. */
  | 'channel_meta'
  /** A list of channels: public/standard kept, any other kept only when readable. */
  | 'channel_list'
  /** A file: readable when one of the conversations it is shared in is readable. */
  | 'file'
  /** A search across every conversation: only while no other project shares the workspace. */
  | 'workspace'
  /** People, teams, the bot itself: no conversation. */
  | 'directory'
  /** Not a read. */
  | 'write';

export const CHANNEL_READ_SCOPES: Record<Platform, Record<string, ChannelReadScope>> = {
  slack: {
    get_history: 'channel',
    get_thread: 'thread',
    channel_info: 'channel_meta',
    list_channels: 'channel_list',
    file_info: 'file',
    search_messages: 'workspace',
    list_users: 'directory',
    user_info: 'directory',
    auth_test: 'directory',
    send_message: 'write',
    update_message: 'write',
    delete_message: 'write',
    add_reaction: 'write',
    remove_reaction: 'write',
    join_channel: 'write',
  },
  teams: {
    list_messages: 'channel',
    get_message: 'thread',
    list_replies: 'thread',
    get_channel: 'channel_meta',
    list_channels: 'channel_list',
    get_team: 'directory',
    list_members: 'directory',
    get_user: 'directory',
    list_teams: 'directory',
  },
};

/** What the database says about who owns what. Injected so the decisions test without a database. */
export interface ChannelOwnership {
  /** The workspaces (Slack teams, Teams tenants) this project's install proved, and whether another project is connected to one of them. */
  installs(projectId: string, platform: Platform): Promise<{ workspaceIds: string[]; shared: boolean }>;
  /** The projects each channel belongs to, keyed by normalized channel id. */
  channelProjects(platform: Platform, workspaceIds: string[], channelIds: string[]): Promise<Map<string, Set<string>>>;
  /** The project each owned thread belongs to, keyed by normalized thread id. Unowned threads are absent. */
  threadOwners(platform: Platform, workspaceIds: string[], threadIds: string[]): Promise<Map<string, string>>;
}

type Owner = 'mine' | 'other' | 'none';

interface Scope {
  projectId: string;
  workspaceIds: string[];
  shared: boolean;
  ownership: ChannelOwnership;
}

const PASS: ChannelReadGate = { refusal: null, answer: async (data) => ({ data }) };

/**
 * The gate for one channel connector call. Queries run only for the actions
 * that need them: a directory read or a write costs nothing.
 */
export async function gateChannelRead(
  input: ChannelReadInput,
  ownership: ChannelOwnership = dbChannelOwnership,
  slack: SlackReadDeps = dbSlackReadDeps,
): Promise<ChannelReadGate> {
  const platform = input.platform === 'slack' || input.platform === 'teams' ? input.platform : null;
  if (!platform) return PASS;
  const scopes = CHANNEL_READ_SCOPES[platform];
  const kind = Object.hasOwn(scopes, input.actionPath) ? scopes[input.actionPath] : undefined;
  if (!kind) {
    if (input.risk !== 'read') return PASS;
    return refuse(`The ${label(platform)} connector does not run read action "${input.actionPath}": it has no rule that keeps it to this workspace's conversations.`);
  }
  // Slack: one Slack workspace, one Kortix workspace. The link and the
  // person's own view of private conversations decide (slack-visibility.ts).
  if (platform === 'slack') return gateSlackRead(input, kind, slack);
  if (kind === 'directory' || kind === 'write' || kind === 'workspace') return PASS;

  const installs = await ownership.installs(input.projectId, 'teams');
  const scope: Scope = { projectId: input.projectId, ...installs, ownership };

  if (kind === 'channel' || kind === 'thread') return gateTarget(scope, kind, input);
  return { refusal: null, answer: (data) => scopeAnswer(scope, kind, input, data) };
}

async function gateTarget(scope: Scope, kind: 'channel' | 'thread', input: ChannelReadInput): Promise<ChannelReadGate> {
  const target = parseTarget(kind, input.args);
  if ('invalid' in target) return refuse(target.invalid);
  const threadOwner = target.thread
    ? ((await threadOwners(scope, [target.thread])).get(target.thread) ?? 'none')
    : 'none';
  if (threadOwner === 'other') return refuse(otherProject(target.subject));
  if (threadOwner === 'none') {
    const refusal = await channelRefusal(scope, target.channel, target.subject);
    if (refusal) return refuse(refusal);
  }
  return { refusal: null, answer: (data) => scopeMessages(scope, kind, target, data) };
}

/** Why this project may not read the channel, or null when it may. */
async function channelRefusal(scope: Scope, channel: string, subject: string): Promise<string | null> {
  const owner = (await channelOwners(scope, [channel])).get(channel) ?? 'none';
  return readable(scope, owner) ? null : refusalMessage(scope, owner, subject);
}

/**
 * The messages of a thread or a channel as this project may see them.
 *
 * A channel read drops every message of a thread another project owns. A
 * thread read is refused when Graph answered with a thread other than the one
 * checked.
 */
async function scopeMessages(scope: Scope, kind: 'channel' | 'thread', target: Target, data: unknown): Promise<Answer> {
  // Graph answers `get_message` with the message itself, not a list.
  const list = listOf(data, 'value') ?? (kind === 'thread' && isRecord(data) ? [data] : null);
  if (!list) return { data };
  const rootOf = (m: unknown) => messageThread(target.channel, m);
  const roots = [...new Set(list.map(rootOf).filter((r): r is string => !!r && r !== target.thread))];
  if (roots.length === 0) return { data };
  const owners = await threadOwners(scope, roots);
  if (kind === 'thread') {
    return [...owners.values()].includes('other') ? deny(otherProject(target.subject)) : { data };
  }
  const kept = list.filter((m) => owners.get(rootOf(m) ?? '') !== 'other');
  return { data: kept.length === list.length ? data : { ...(data as Record<string, unknown>), value: kept } };
}

/** Channel metadata and channel lists: decided on the provider's answer. */
async function scopeAnswer(scope: Scope, kind: ChannelReadScope, input: ChannelReadInput, data: unknown): Promise<Answer> {
  if (kind === 'channel_meta') {
    if (!isRecord(data) || isOpenChannel(data)) return { data };
    const id = normalizedId(data.id) ?? normalizedId(input.args['channel-id']) ?? '';
    const refusal = await channelRefusal(scope, id, `Teams channel ${id}`);
    return refusal ? deny(refusal) : { data };
  }
  if (kind === 'channel_list') {
    const list = listOf(data, 'value');
    if (!list) return { data };
    const closedIds = list
      .filter((c) => isRecord(c) && !isOpenChannel(c))
      .map((c) => normalizedId((c as Record<string, unknown>).id))
      .filter((id): id is string => !!id);
    const owners = await channelOwners(scope, closedIds);
    const kept = list.filter((c) => {
      if (!isRecord(c)) return false;
      if (isOpenChannel(c)) return true;
      const id = normalizedId(c.id);
      return !!id && readable(scope, owners.get(id) ?? 'none');
    });
    return { data: kept.length === list.length ? data : { ...(data as Record<string, unknown>), value: kept } };
  }
  return { data };
}

/* ─── ids ───────────────────────────────────────────────────────────────────── */

interface Target {
  /** Normalized channel id. */
  channel: string;
  /** Normalized thread id, for a thread read. */
  thread?: string;
  /** How the refusal names it. */
  subject: string;
}

export const SLACK_TS = /^\d{1,12}\.\d{1,9}$/;
const TEAMS_CHANNEL = /^19:[A-Za-z0-9._=-]{1,256}@thread\.[A-Za-z0-9]{1,16}$/;
const TEAMS_MESSAGE = /^\d{1,24}$/;

/**
 * A Teams channel id as the ownership rows store it, lowercase (compared
 * lowercase on both sides). Any other shape is refused, not looked up: a
 * padded or re-encoded id could match no row here and still name a real
 * conversation at the provider.
 */
function normalizedId(value: unknown): string | null {
  return typeof value === 'string' && TEAMS_CHANNEL.test(value) ? value.toLowerCase() : null;
}

function teamsThreadId(channel: string, messageId: string): string {
  return `${channel};messageid=${messageId}`.toLowerCase();
}

function parseTarget(kind: 'channel' | 'thread', args: Record<string, unknown>): Target | { invalid: string } {
  const channel = normalizedId(args['channel-id']);
  if (!channel) return { invalid: '`channel-id` must be one Teams channel id, for example 19:abc@thread.tacv2.' };
  if (kind === 'channel') return { channel, subject: `Teams channel ${channel}` };
  const message = args['message-id'];
  if (typeof message !== 'string' || !TEAMS_MESSAGE.test(message)) {
    return { invalid: '`message-id` must be one Teams message id (digits).' };
  }
  return { channel, thread: teamsThreadId(channel, message), subject: `Teams thread ${message} in ${channel}` };
}

/** The thread a Graph message belongs to, normalized. */
function messageThread(channel: string, message: unknown): string | null {
  if (!isRecord(message)) return null;
  const root = message.replyToId || message.id;
  return typeof root === 'string' && TEAMS_MESSAGE.test(root) ? teamsThreadId(channel, root) : null;
}

/** A standard Teams channel: its metadata is directory data. */
function isOpenChannel(channel: Record<string, unknown>): boolean {
  return channel.membershipType === 'standard';
}

/* ─── decisions ─────────────────────────────────────────────────────────────── */

function mayReadUnowned(scope: Scope): boolean {
  return scope.workspaceIds.length > 0 && !scope.shared;
}

function readable(scope: Scope, owner: Owner): boolean {
  return owner === 'mine' || (owner === 'none' && mayReadUnowned(scope));
}

async function channelOwners(scope: Scope, ids: string[]): Promise<Map<string, Owner>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0 || scope.workspaceIds.length === 0) return new Map();
  const projects = await scope.ownership.channelProjects('teams', scope.workspaceIds, unique);
  return new Map(
    unique.map((id) => {
      const owners = projects.get(id);
      return [id, owners?.has(scope.projectId) ? 'mine' : owners?.size ? 'other' : 'none'];
    }),
  );
}

async function threadOwners(scope: Scope, ids: string[]): Promise<Map<string, Owner>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0 || scope.workspaceIds.length === 0) return new Map();
  const owners = await scope.ownership.threadOwners('teams', scope.workspaceIds, unique);
  return new Map([...owners].map(([id, projectId]) => [id, projectId === scope.projectId ? 'mine' : 'other']));
}

/* ─── messages ──────────────────────────────────────────────────────────────── */

function label(platform: Platform): string {
  return platform === 'slack' ? 'Slack' : 'Microsoft Teams';
}

type Answer = { data: unknown } | { refusal: ChannelReadRefusal };

function deny(message: string): { refusal: ChannelReadRefusal } {
  return { refusal: { reason: CONVERSATION_NOT_IN_PROJECT, message } };
}

function refuse(message: string): ChannelReadGate {
  return { ...deny(message), answer: PASS.answer };
}

export function noInstall(platform: Platform): string {
  return `This project has no ${label(platform)} install on record, so the connector cannot tell which conversations are its own. Connect ${label(platform)} again in Customize → Connectors.`;
}

function otherProject(subject: string): string {
  return `${subject} belongs to another Kortix workspace. This workspace's Microsoft Teams connector reads only its own conversations.`;
}

function refusalMessage(scope: Scope, owner: Owner, subject: string): string {
  if (scope.workspaceIds.length === 0) return noInstall('teams');
  if (owner === 'other') return otherProject(subject);
  return `This Kortix workspace has no conversation in ${subject}, and this Microsoft 365 tenant is connected to more than one Kortix workspace. Mention the bot in that channel and pick this Kortix workspace first.`;
}

function listOf(data: unknown, key: string): unknown[] | null {
  return isRecord(data) && Array.isArray(data[key]) ? (data[key] as unknown[]) : null;
}

/* ─── database ──────────────────────────────────────────────────────────────── */

export const dbChannelOwnership: ChannelOwnership = {
  async installs(projectId, platform) {
    const rows = await db
      .select({ workspaceId: chatInstalls.platformTeamId })
      .from(chatInstalls)
      .where(and(eq(chatInstalls.platform, platform), eq(chatInstalls.projectId, projectId)));
    const workspaceIds = [...new Set(rows.map((r) => r.workspaceId).filter(Boolean))];
    if (workspaceIds.length === 0) return { workspaceIds, shared: false };
    const [other] = await db
      .select({ projectId: chatInstalls.projectId })
      .from(chatInstalls)
      .where(
        and(
          eq(chatInstalls.platform, platform),
          inArray(chatInstalls.platformTeamId, workspaceIds),
          ne(chatInstalls.projectId, projectId),
        ),
      )
      .limit(1);
    return { workspaceIds, shared: Boolean(other) };
  },

  async channelProjects(platform, workspaceIds, channelIds) {
    const out = new Map<string, Set<string>>();
    const add = (id: string, projectId: string | null) => {
      if (!projectId) return;
      const set = out.get(id) ?? new Set<string>();
      set.add(projectId);
      out.set(id, set);
    };
    // A Teams conversation id is its channel id plus `;messageid=<root>` for a
    // channel thread, so the channel is the part before the first `;`.
    const bindingChannel = sql<string>`lower(split_part(${chatChannelBindings.channelId}, ';', 1))`;
    const threadChannel = sql<string>`lower(split_part(${chatThreads.threadId}, ';', 1))`;
    const [bindings, threads] = await Promise.all([
      db
        .select({ id: bindingChannel, projectId: chatChannelBindings.projectId })
        .from(chatChannelBindings)
        .where(
          and(
            eq(chatChannelBindings.platform, 'teams'),
            inArray(chatChannelBindings.platformTeamId, workspaceIds),
            inArray(bindingChannel, channelIds),
            isNotNull(chatChannelBindings.projectId),
          ),
        ),
      db
        .select({ id: threadChannel, projectId: chatThreads.projectId })
        .from(chatThreads)
        .where(
          and(
            eq(chatThreads.platform, 'teams'),
            inArray(chatThreads.platformTeamId, workspaceIds),
            inArray(threadChannel, channelIds),
          ),
        ),
    ]);
    for (const r of [...bindings, ...threads]) add(r.id, r.projectId);
    return out;
  },

  async threadOwners(platform, workspaceIds, threadIds) {
    const threadId =
      platform === 'teams' ? sql<string>`lower(${chatThreads.threadId})` : sql<string>`${chatThreads.threadId}`;
    const threads = await db
      .select({ id: threadId, projectId: chatThreads.projectId })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.platform, platform),
          inArray(chatThreads.platformTeamId, workspaceIds),
          inArray(threadId, threadIds),
        ),
      );
    const out = new Map(threads.map((r) => [r.id, r.projectId]));
    // A Teams channel thread can be bound to a project before any session
    // owns it. The session, when there is one, decides.
    const bindingId = sql<string>`lower(${chatChannelBindings.channelId})`;
    const bindings = await db
      .select({ id: bindingId, projectId: chatChannelBindings.projectId })
      .from(chatChannelBindings)
      .where(
        and(
          eq(chatChannelBindings.platform, 'teams'),
          inArray(chatChannelBindings.platformTeamId, workspaceIds),
          inArray(bindingId, threadIds),
          isNotNull(chatChannelBindings.projectId),
        ),
      );
    for (const r of bindings) if (r.projectId && !out.has(r.id)) out.set(r.id, r.projectId);
    return out;
  },
};
