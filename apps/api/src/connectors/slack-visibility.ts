/**
 * Slack connector reads: what an agent may see in the Slack workspace its
 * Kortix workspace is linked to.
 *
 * One Slack workspace runs in one Kortix workspace (channels/slack/link.ts),
 * so the bot token belongs to that Kortix workspace alone and the agent moves
 * through the Slack workspace under its own connector rules. Two checks stay:
 *
 *   1. THE LINK. A Kortix workspace that does not hold the link reads nothing,
 *      so two Kortix workspaces never read with one token, even before an
 *      extra install is detached.
 *   2. PRIVATE CONTENT FOLLOWS THE PERSON. Public channels are open, as they
 *      are to every member of the Slack workspace. A private channel, a group
 *      DM or a DM is readable only when the person the session works for is
 *      in it: the bot was invited there, but the person asking may not have
 *      been. The person is the session's acting Kortix user, as their Slack
 *      account (`slackPersonForKortixUser`). No Slack account: no private reads.
 *
 * Slack decides the rest: the bot reads only where it is a member, and a read
 * of a public channel it is not in joins it first (gateway.ts).
 */
import { isRecord } from '@kortix/shared/guards';
import type { ChannelReadGate, ChannelReadInput, ChannelReadRefusal, ChannelReadScope } from './channel-read-scope';

export const SLACK_NOT_LINKED = 'slack_not_linked';
export const SLACK_PRIVATE_CONVERSATION = 'slack_private_conversation';

/** The private conversations the bot is in, and the ones this read may reach. */
export interface SlackView {
  /** Private channels, group DMs and DMs the bot is in. */
  privateIds: ReadonlySet<string>;
  /** Those the person the session works for is in. */
  allowedIds: ReadonlySet<string>;
  /** Whether the session's person has a Slack account here. */
  hasPerson: boolean;
}

export interface SlackReadDeps {
  /** The Slack workspace this Kortix workspace holds the link to, or null. */
  link(projectId: string): Promise<{ teamId: string } | null>;
  /**
   * The private conversations of the linked Slack workspace as `userId` may
   * see them. Null when Slack did not answer; `no_slack` when the Kortix
   * workspace has no Slack token, so no conversation is reachable at all.
   */
  view(projectId: string, teamId: string, userId: string | null): Promise<SlackView | 'no_slack' | null>;
}

const SLACK_ID = /^[A-Za-z0-9]{2,64}$/;

function normalized(value: unknown): string | null {
  return typeof value === 'string' && SLACK_ID.test(value) ? value.toUpperCase() : null;
}

function refusal(reason: string, message: string): { refusal: ChannelReadRefusal } {
  return { refusal: { reason, message } as ChannelReadRefusal };
}

const NOT_LINKED_MESSAGE =
  'This Kortix workspace does not hold a Slack workspace: another Kortix workspace is connected to it, or Slack was disconnected. Connect Slack here (Customize → Connectors → Slack) to move it.';

const UNKNOWN_VIEW_MESSAGE =
  "Slack did not answer which conversations are private, so this read is refused rather than risk showing one. Try again in a moment.";

function privateMessage(id: string, view: SlackView): string {
  return view.hasPerson
    ? `Slack conversation ${id} is private, and the person this session works for is not in it. A private channel or DM is readable only by a session of someone in it.`
    : `Slack conversation ${id} is private. This session's person has no Slack account here with the same confirmed email, so it reads no private channel or DM. They link one with \`/kortix login\` in Slack.`;
}

/**
 * Why a write into conversation `channel` must not go ahead, or null. A DM
 * (`D…`) or a user id is to one person and stays open. Otherwise the
 * conversation must be public, or private with the person in it. When Slack
 * does not answer which conversations are private, the write is refused, as
 * a read is. Only a Kortix workspace with no Slack token writes unchecked:
 * no conversation is reachable without one.
 */
export async function slackPrivateWrite(
  input: { projectId: string; userId: string | null; channel: unknown },
  deps: SlackReadDeps,
): Promise<ChannelReadRefusal | null> {
  const id = normalized(input.channel);
  // Not a conversation id (a name Slack would resolve): refused, as a read is.
  if (!id) return refusal(SLACK_PRIVATE_CONVERSATION, '`channel` must be one Slack conversation id, for example C0123ABCD.').refusal;
  if (/^[DUW]/.test(id)) return null;
  const link = await deps.link(input.projectId);
  if (!link) return null;
  const view = await deps.view(input.projectId, link.teamId, input.userId);
  if (view === 'no_slack') return null;
  if (!view) return refusal(SLACK_PRIVATE_CONVERSATION, UNKNOWN_VIEW_MESSAGE).refusal;
  if (mayRead(view, id)) return null;
  return refusal(SLACK_PRIVATE_CONVERSATION, privateMessage(id, view)).refusal;
}

/** May this read reach conversation `id`? */
function mayRead(view: SlackView, id: string): boolean {
  return !view.privateIds.has(id) || view.allowedIds.has(id);
}

function isPrivateRecord(c: Record<string, unknown>): boolean {
  return c.is_private === true || c.is_im === true || c.is_mpim === true || c.is_group === true;
}

const PASS: ChannelReadGate = { refusal: null, answer: async (data) => ({ data }) };

/** A file record without the private conversations (`groups`, `ims`, `shares.private`) `may` refuses. */
function withoutHiddenShares(file: Record<string, unknown>, may: (id: string) => boolean): Record<string, unknown> {
  const keep = (ids: unknown) => (Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && may(normalized(id) ?? '')) : ids);
  const shares = isRecord(file.shares) ? file.shares : null;
  const priv = shares && isRecord(shares.private) ? shares.private : null;
  return {
    ...file,
    groups: keep(file.groups),
    ims: keep(file.ims),
    ...(shares
      ? {
          shares: {
            ...shares,
            ...(priv ? { private: Object.fromEntries(Object.entries(priv).filter(([id]) => may(normalized(id) ?? ''))) } : {}),
          },
        }
      : {}),
  };
}

/**
 * The gate for one Slack read. `kind` is the action's entry in
 * `CHANNEL_READ_SCOPES.slack`; a write is gated in channel-write-scope.ts.
 */
export async function gateSlackRead(
  input: ChannelReadInput,
  kind: ChannelReadScope,
  deps: SlackReadDeps,
): Promise<ChannelReadGate> {
  if (kind === 'write') return PASS;
  const link = await deps.link(input.projectId);
  if (!link) return { ...refusal(SLACK_NOT_LINKED, NOT_LINKED_MESSAGE), answer: PASS.answer };
  if (kind === 'directory') return PASS;

  let viewed: SlackView | null | undefined;
  const view = async (): Promise<SlackView | null> => {
    if (viewed !== undefined) return viewed;
    const answer = await deps.view(input.projectId, link.teamId, input.userId ?? null);
    viewed = answer === 'no_slack' ? null : answer;
    return viewed;
  };

  if (kind === 'channel' || kind === 'thread') {
    const id = normalized(input.args.channel);
    if (!id) return { ...refusal(SLACK_PRIVATE_CONVERSATION, '`channel` must be one Slack conversation id, for example C0123ABCD.'), answer: PASS.answer };
    const v = await view();
    if (!v) return { ...refusal(SLACK_PRIVATE_CONVERSATION, UNKNOWN_VIEW_MESSAGE), answer: PASS.answer };
    if (!mayRead(v, id)) return { ...refusal(SLACK_PRIVATE_CONVERSATION, privateMessage(id, v)), answer: PASS.answer };
    return PASS;
  }

  return {
    refusal: null,
    answer: async (data) => {
      if (!isRecord(data)) return { data };
      if (kind === 'channel_meta') {
        const channel = isRecord(data.channel) ? data.channel : null;
        if (!channel || !isPrivateRecord(channel)) return { data };
        const id = normalized(channel.id) ?? normalized(input.args.channel) ?? '';
        const v = await view();
        if (!v) return refusal(SLACK_PRIVATE_CONVERSATION, UNKNOWN_VIEW_MESSAGE);
        return mayRead(v, id) ? { data } : refusal(SLACK_PRIVATE_CONVERSATION, privateMessage(id, v));
      }
      if (kind === 'channel_list') {
        const list = Array.isArray(data.channels) ? (data.channels as unknown[]) : null;
        if (!list) return { data };
        const v = await view();
        const kept = list.filter((c) => {
          if (!isRecord(c)) return false;
          if (!isPrivateRecord(c)) return true;
          const id = normalized(c.id);
          return Boolean(v && id && mayRead(v, id));
        });
        return { data: kept.length === list.length ? data : { ...data, channels: kept } };
      }
      if (kind === 'file') {
        const file = isRecord(data.file) ? data.file : null;
        if (!file) return { data };
        // Public channels in `channels`, private ones in `groups`, DMs in `ims`.
        const sharedPrivately = isRecord(file.shares) && isRecord(file.shares.private) ? Object.keys(file.shares.private) : [];
        const closed = [...new Set([file.groups, file.ims, sharedPrivately]
          .flatMap((v) => (Array.isArray(v) ? v : []))
          .map(normalized)
          .filter((id): id is string => !!id))];
        if (closed.length === 0) return { data };
        const v = await view();
        const open = Array.isArray(file.channels) && file.channels.length > 0;
        if (v && (open || closed.some((id) => mayRead(v, id)))) {
          // Readable, but the private conversations it is shared in that the
          // person is not in stay out of the answer.
          return { data: { ...data, file: withoutHiddenShares(file, (id) => mayRead(v, id)) } };
        }
        const id = typeof file.id === 'string' ? file.id : '';
        return refusal(
          SLACK_PRIVATE_CONVERSATION,
          `Slack file ${id} is shared only in private conversations the person this session works for is not in.`,
        );
      }
      if (kind === 'workspace') {
        // search.messages: drop matches from private conversations this read may not reach.
        const messages = isRecord(data.messages) ? data.messages : null;
        const matches = messages && Array.isArray(messages.matches) ? (messages.matches as unknown[]) : null;
        if (!messages || !matches) return { data };
        const v = await view();
        const kept = matches.filter((m) => {
          const channel = isRecord(m) && isRecord(m.channel) ? m.channel : null;
          const id = channel ? normalized(channel.id) : null;
          return Boolean(id && v && mayRead(v, id));
        });
        return { data: kept.length === matches.length ? data : { ...data, messages: { ...messages, matches: kept } } };
      }
      return { data };
    },
  };
}
