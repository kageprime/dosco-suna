/**
 * Channel connector writes, kept in the conversations they belong to: Slack
 * writes by the Kortix workspace that holds the Slack workspace, Telegram
 * writes of a chat's session in that chat. Discord confines every call, reads too
 * (channel-discord-scope.ts).
 *
 * Every rule below reads the call's declared arguments. The gateway refuses a
 * channel call with any other argument before these gates run (`invalid_args`,
 * `undeclaredChannelArg` in channels.ts): `body`, for one, would replace the
 * whole request that was checked.
 *
 * SLACK. One Slack workspace runs in one Kortix workspace
 * (channels/slack/link.ts): only the Kortix workspace holding the link writes
 * with its bot token, so no other workspace's conversation is reachable. That
 * workspace's agent posts, edits, reacts, joins and binds threads anywhere its
 * bot may, under its own connector rules; Slack enforces the rest. The ids
 * are checked for Slack's own shape before the call: a channel NAME is
 * refused, since Slack does not document how chat.postMessage matches one.
 *
 * TEAMS. Teams writes do not go through the connector: every send resolves
 * through `resolveTeamsProjectConversation` (channels/teams/post.ts), which
 * already addresses only this project's own conversations.
 *
 * TELEGRAM. Each project has its own bot, so the risk is inside one project:
 * an agent in the session of chat A must not send to, edit or delete in chat
 * B, another person's private chat or another group of the same bot.
 *   1. A session a Telegram chat started (`metadata.source` and
 *      `metadata.telegram.chat_id`, both server-managed keys) or a Telegram
 *      chat is bound to (`chat_threads`, for example a reminder's successor)
 *      writes only into that chat: `chat_id`, and `reply_parameters.chat_id`
 *      when a reply quotes a message, must be its numeric id. Any forum topic
 *      of the chat is fine. Another chat, a `@channel` name and a malformed id
 *      are refused before the call. `inline_message_id` names no chat, so the
 *      catalog does not declare it and the gateway refuses it.
 *   2. Rule 1 follows the lineage: a session that such a session started
 *      (`spawned_by_session`), or a reminder successor that replaces it
 *      (`reminder_successor_of`), writes only into the chats of every session
 *      up its lineage (`sessionTelegramChats`).
 *   3. Any other session (web, triggers, automations) and a call without a
 *      session write to any chat of the bot: an automation that sends order
 *      notifications relies on it.
 *   4. Reads (`TELEGRAM_READS`) are not confined.
 * Kortix's own replies (notices, questions, menus) do not go through the
 * connector and are not checked here.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { chatThreads, projectSessions } from '@kortix/db';
import { isRecord } from '@kortix/shared/guards';
import { db } from '../shared/db';
// A cycle: each side reads the other's functions only at call time.
import { discordCallRefusal } from './channel-discord-scope';
import {
  CHANNEL_READ_SCOPES,
  CONVERSATION_NOT_IN_PROJECT,
  type ChannelReadInput,
  type ChannelReadRefusal,
  SLACK_TS,
  noInstall,
} from './channel-read-scope';
import { SLACK_NOT_LINKED, slackPrivateWrite, type SlackReadDeps } from './slack-visibility';
import { dbSlackReadDeps } from './slack-visibility-db';

/** Whether this project holds its Slack workspace's link (channels/slack/link.ts). */
export type SlackLinkState = 'linked' | 'not_linked' | 'no_install';

/** The project's link state, from the install rows. The channel modules load on first use. */
export async function slackLinkState(projectId: string): Promise<SlackLinkState> {
  const { slackProjectLink } = await import('../channels/slack/link');
  if (await slackProjectLink(projectId)) return 'linked';
  const { provenSlackWorkspaces } = await import('../channels/slack/inbound');
  return (await provenSlackWorkspaces(projectId)).length > 0 ? 'not_linked' : 'no_install';
}

/**
 * Where each Slack write names its conversation and its message or thread.
 * A unit test fails when a Slack catalog write has no entry, and a write
 * without one is refused at call time.
 */
export const SLACK_WRITE_TARGETS: Record<string, { channel: string; ts?: string; tsRequired?: boolean }> = {
  send_message: { channel: 'channel', ts: 'thread_ts' },
  update_message: { channel: 'channel', ts: 'ts', tsRequired: true },
  delete_message: { channel: 'channel', ts: 'ts', tsRequired: true },
  add_reaction: { channel: 'channel', ts: 'timestamp', tsRequired: true },
  remove_reaction: { channel: 'channel', ts: 'timestamp', tsRequired: true },
  join_channel: { channel: 'channel' },
};

/**
 * A conversation or user id in Slack's own shape: a type letter, then
 * uppercase letters and digits. A lowercase name or `#name` is refused before
 * the call; an uppercase name slips through only to be caught where it lands.
 */
const SLACK_WRITE_ID = /^[CDGUW][A-Z0-9]{1,20}$/;

/**
 * Why a write is refused: a malformed id, no Slack install on record, or a
 * Kortix workspace that does not hold its Slack workspace's link. Callers map
 * the kind to their own status; the connector refuses every kind alike.
 */
export interface SlackWriteRefusal {
  kind: 'invalid' | 'install' | 'not_linked';
  message: string;
}

/**
 * Why this project may not write to `channel` (and to the thread or message
 * `ts` in it), or null when it may. The one check behind the connector, the
 * file upload route, and the bind-thread route.
 *
 * One Slack workspace runs in one Kortix workspace (channels/slack/link.ts):
 * the Kortix workspace holding the link writes anywhere its bot may, under
 * the agent's own connector rules. Slack enforces the rest (the bot edits and
 * deletes only its own messages, posts only where it may).
 */
export async function slackWriteRefusal(
  projectId: string,
  target: { channel: unknown; ts?: unknown; tsArg?: string; tsRequired?: boolean },
  linkState: (projectId: string) => Promise<SlackLinkState> = slackLinkState,
): Promise<SlackWriteRefusal | null> {
  const channel = typeof target.channel === 'string' && SLACK_WRITE_ID.test(target.channel) ? target.channel : null;
  if (!channel) {
    return {
      kind: 'invalid',
      message:
        '`channel` must be one Slack conversation or user id as Slack issues it, for example C0123ABCD or U0123ABCD. A channel name is not accepted: find the id with list_channels.',
    };
  }
  const tsArg = target.tsArg ?? 'ts';
  const given = target.ts !== undefined && target.ts !== null && target.ts !== '';
  if (!given && target.tsRequired) return { kind: 'invalid', message: `\`${tsArg}\` is required.` };
  if (given && !(typeof target.ts === 'string' && SLACK_TS.test(target.ts))) {
    return { kind: 'invalid', message: `\`${tsArg}\` must be one Slack message timestamp, for example 1700000000.000100.` };
  }
  const state = await linkState(projectId);
  if (state === 'linked') return null;
  return state === 'no_install'
    ? { kind: 'install', message: noInstall('slack') }
    : {
        kind: 'not_linked',
        message:
          'This Kortix workspace does not hold its Slack workspace: another Kortix workspace is connected to it. Connect Slack here (Customize → Connectors → Slack) to move it.',
      };
}

/** A write that ran but landed somewhere it was not checked: the refusal, and the call that takes it back. */
export interface ChannelWriteMisfire {
  refusal: ChannelReadRefusal;
  /** The Slack method and args that remove the message; null when the answer does not name it. */
  undo: { path: string; args: Record<string, unknown> } | null;
}

/** The connector's write check: refused before the call, or checked on its answer. */
export interface ChannelWriteGate {
  refusal: ChannelReadRefusal | null;
  /** On a successful answer: null when the write landed where it was checked. */
  misfire(data: unknown): ChannelWriteMisfire | null;
}

const PASS: ChannelWriteGate = { refusal: null, misfire: () => null };

function refuse(message: string): ChannelWriteGate {
  return { refusal: { reason: CONVERSATION_NOT_IN_PROJECT, message }, misfire: () => null };
}

/**
 * The Telegram catalog actions that do not write into a chat. Every other
 * Telegram action is a write into the chat its `chat_id` names; a unit test
 * pins the list against the catalog.
 */
export const TELEGRAM_READS: ReadonlySet<string> = new Set(['get_chat', 'get_me']);

/** How many sessions up the lineage `sessionChannelChats` reads. */
const LINEAGE_HOPS = 8;

/** The platforms whose sessions write only into their own chats, and how a session names its chat. */
const SESSION_CHATS = {
  // A thread is the chat id, or `<chat id>:<topic id>` for a forum topic.
  telegram: { chat: (m: Record<string, unknown>) => telegramChatId(m.chat_id), ofThread: (id: string) => id.split(':')[0]! },
  // A thread is the Discord channel the conversation runs in: a thread or a DM.
  discord: { chat: (m: Record<string, unknown>) => discordChannelId(m.thread_id), ofThread: (id: string) => id },
} as const;

/**
 * The chats a session answers, as numeric chat ids: every chat that started or
 * is bound to the session or a session before it. The lineage runs up
 * `spawned_by_session` (a session another session started) and
 * `reminder_successor_of` (the session a failed reminder's successor
 * replaces), both server-managed keys. Null when no chat of `platform` started
 * and none is bound to any of them: that session writes to any chat.
 *
 * A session cannot shed its chat by starting another one: a lineage that is
 * longer than LINEAGE_HOPS, or that names a session that is not on record,
 * answers only the chats found so far (none: it writes to no chat).
 */
export async function sessionChannelChats(
  platform: keyof typeof SESSION_CHATS,
  projectId: string,
  sessionId: string | null,
): Promise<string[] | null> {
  if (!sessionId) return null;
  const { chat, ofThread } = SESSION_CHATS[platform];
  const chats = new Set<string>();
  const seen = new Set<string>();
  let confined = false;
  let frontier = [sessionId];
  for (let hop = 0; frontier.length > 0; hop++) {
    if (hop > LINEAGE_HOPS) {
      confined = true;
      break;
    }
    for (const id of frontier) seen.add(id);
    const [sessions, threads] = await Promise.all([
      db
        .select({ metadata: projectSessions.metadata })
        .from(projectSessions)
        .where(and(inArray(projectSessions.sessionId, frontier), eq(projectSessions.projectId, projectId))),
      db
        .select({ threadId: chatThreads.threadId })
        .from(chatThreads)
        .where(and(eq(chatThreads.projectId, projectId), inArray(chatThreads.sessionId, frontier), eq(chatThreads.platform, platform))),
    ]);
    for (const row of threads) chats.add(ofThread(row.threadId));
    if (hop > 0 && sessions.length < frontier.length) confined = true;
    const parents = new Set<string>();
    for (const row of sessions) {
      const metadata = isRecord(row.metadata) ? row.metadata : {};
      if (metadata.source === platform) {
        confined = true;
        const id = isRecord(metadata[platform]) ? chat(metadata[platform]) : null;
        if (id) chats.add(id);
      }
      for (const parent of [metadata.spawned_by_session, metadata.reminder_successor_of]) {
        if (typeof parent === 'string' && parent && !seen.has(parent)) parents.add(parent);
      }
    }
    frontier = [...parents];
  }
  return confined || chats.size ? [...chats] : null;
}

/** The Telegram chats a session answers (`sessionChannelChats`). */
export function sessionTelegramChats(projectId: string, sessionId: string | null): Promise<string[] | null> {
  return sessionChannelChats('telegram', projectId, sessionId);
}

/** A Discord snowflake as a string; null for anything else. */
export function discordChannelId(value: unknown): string | null {
  return typeof value === 'string' && /^\d{17,20}$/.test(value) ? value : null;
}

/** A chat id as Telegram issues it, normalized to its decimal string; null for anything else. */
function telegramChatId(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : null;
  return typeof value === 'string' && /^-?[1-9]\d{0,19}$/.test(value) ? value : null;
}

/**
 * Why a session that answers the chats `own` may not write into `chatId`, or
 * null when it may. `own` null: the session answers no Telegram chat.
 */
export function telegramWriteRefusal(chatId: unknown, own: string[] | null): string | null {
  if (!own) return null;
  const id = telegramChatId(chatId);
  if (id && own.includes(id)) return null;
  const answers = own.length
    ? `This session answers Telegram chat ${own.join(' or ')} only.`
    : "This session's Telegram chat is not on record, so it writes to no chat.";
  return `${answers} It does not send to, edit or delete messages in other chats.`;
}

/**
 * A reply can quote a message of another chat (`reply_parameters.chat_id`):
 * for a session that answers the chats `own`, that chat must be one of them.
 * Only an object is read; anything else would reach Telegram unchecked.
 */
export function telegramReplyRefusal(reply: unknown, own: string[] | null): string | null {
  if (!own || reply === undefined) return null;
  if (!isRecord(reply)) return '`reply_parameters` must be an object, for example {"message_id": 5}.';
  return Object.hasOwn(reply, 'chat_id') ? telegramWriteRefusal(reply.chat_id, own) : null;
}

/** Reads are gated in channel-read-scope.ts; this gates the writes. */
export async function gateChannelWrite(
  input: Omit<ChannelReadInput, 'risk'>,
  linkState: (projectId: string) => Promise<SlackLinkState> = slackLinkState,
  slackReads: SlackReadDeps = dbSlackReadDeps,
): Promise<ChannelWriteGate> {
  // Every Discord action, read or write: one bot token serves every project (channel-discord-scope.ts).
  if (input.platform === 'discord') {
    const refusal = await discordCallRefusal(input);
    return refusal ? refuse(refusal) : PASS;
  }
  if (input.platform === 'telegram') {
    if (TELEGRAM_READS.has(input.actionPath)) return PASS;
    const own = await sessionTelegramChats(input.projectId, input.sessionId ?? null);
    const refusal = telegramWriteRefusal(input.args.chat_id, own) ?? telegramReplyRefusal(input.args.reply_parameters, own);
    return refusal ? refuse(refusal) : PASS;
  }
  if (input.platform !== 'slack' && input.platform !== 'teams') return PASS;
  const scopes = CHANNEL_READ_SCOPES[input.platform];
  if (!Object.hasOwn(scopes, input.actionPath) || scopes[input.actionPath] !== 'write') return PASS;
  const target = input.platform === 'slack' && Object.hasOwn(SLACK_WRITE_TARGETS, input.actionPath)
    ? SLACK_WRITE_TARGETS[input.actionPath]
    : null;
  if (!target) {
    return refuse(
      `The ${input.platform === 'slack' ? 'Slack' : 'Microsoft Teams'} connector does not run write action "${input.actionPath}": it has no rule that keeps it out of other projects' conversations.`,
    );
  }
  const channel = input.args[target.channel];
  const refusal = await slackWriteRefusal(
    input.projectId,
    { channel, ts: target.ts ? input.args[target.ts] : undefined, tsArg: target.ts, tsRequired: target.tsRequired },
    linkState,
  );
  if (refusal) {
    const reason = refusal.kind === 'not_linked' ? SLACK_NOT_LINKED : CONVERSATION_NOT_IN_PROJECT;
    return { refusal: { reason, message: refusal.message }, misfire: () => null };
  }
  const privateRefusal = await slackPrivateWriteRefusal(input.projectId, input.userId ?? null, channel, slackReads);
  if (privateRefusal) return { refusal: privateRefusal, misfire: () => null };
  // Slack documents names only for chat.postMessage; every other write takes an id.
  if (input.actionPath !== 'send_message') return PASS;
  return { refusal: null, misfire: (data) => postMisfire(channel as string, data) };
}

/**
 * Where chat.postMessage says it posted (`channel`, `ts` of the answer) must
 * be the conversation that was checked; for a user id, a DM. An uppercase
 * name passes the id shape, and Slack may resolve it to another conversation.
 */
function postMisfire(checked: string, data: unknown): ChannelWriteMisfire | null {
  const answer = data != null && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const landed = typeof answer.channel === 'string' ? answer.channel : null;
  const toPerson = checked.startsWith('U') || checked.startsWith('W');
  if (landed === checked || (toPerson && landed?.startsWith('D'))) return null;
  return {
    refusal: {
      reason: CONVERSATION_NOT_IN_PROJECT,
      message: `Slack posted the message to ${landed ?? 'a conversation it did not name'}, not to ${checked}, the conversation that was checked. Address a conversation by its id.`,
    },
    undo: landed && typeof answer.ts === 'string' ? { path: '/chat.delete', args: { channel: landed, ts: answer.ts } } : null,
  };
}

/**
 * Private content follows the person for writes too: a post, a file, an
 * edit, a reaction, a join or a thread bind in a private channel or group DM
 * needs the person the call is for in it (slack-visibility.ts
 * `slackPrivateWrite`). Null when the write may go ahead.
 */
export function slackPrivateWriteRefusal(
  projectId: string,
  userId: string | null,
  channel: unknown,
  slackReads: SlackReadDeps = dbSlackReadDeps,
): Promise<ChannelReadRefusal | null> {
  return slackPrivateWrite({ projectId, userId, channel }, slackReads);
}
