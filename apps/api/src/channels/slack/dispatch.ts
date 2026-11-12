import { eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import {
  loadSlackBotIdForProject,
  loadSlackBotUserIdForProject,
  loadSlackTokenForProject,
} from '../install-store';
import {
  postBlocks,
  postMessage,
  updateBlocks,
} from '../slack-api';
import { slackMessageLabels } from './labels';
import { handleSlashCommand } from './commands';
import {
  createOrJoinThreadSession,
  deliverSlackFollowUpToSession,
  slackFollowUpKey,
  renderFollowUpPrompt,
  slackFollowUpModel,
} from './session';
import { ensureSlackThreadParticipant } from './participants';
import { currentChannelSelection } from './selection';
import { postIdentityPrompt } from './identity';
import { QUESTION_EARLIER, answeredQuestionBlocks, buildQuestionBlocks, earlierQuestionBlocks } from './questions';
import type { QuestionPress } from '../core/questions';
import { chatUser } from '../core/identity';
import { resolveSlackActor } from './auto-link';
import { dropChatThread, findChatThreadSession, touchChatThread } from '../core/threads';
import { resolveProjectAutomationActor } from '../../projects/session-lifecycle';
import {
  deleteTurn,
  finalizeTurn,
  loadTurn,
  saveTurn,
  startTurn,
} from './turn';
import {
  claimInboundMessage,
  claimThreadErrorNotice,
  clearThreadErrorNotice,
  inboundMessageKey,
} from './dedup';
import { holdsSlackWorkspace, linkedSlackProject, recordSlackChannel } from './link';
import { closeWaitingTurn } from './waiting-turn';
import { escapeMrkdwn, mentionsUser, respondViaUrl, sessionWebUrl, stripMentions } from './util';
import { config } from '../../config';
import type {
  EventClass,
  LiveTurn,
  ProjectResolution,
  QuestionInfo,
  SlackEnvelope,
  SlackEvent,
  SlackQuestionPress,
  SlashResponse,
} from './types';
import { projectsView, accountKeyOfWorkspace } from '../../workspaces/rows';

type SlackTurnOpts = { ownThreadsOnly?: boolean; authorizedResume?: boolean; press?: SlackQuestionPress };


/**
 * The Kortix workspace a shared-app event runs in: the one this Slack
 * workspace is linked to (slack/link.ts). Every channel, DM and thread of the
 * Slack workspace runs there; a channel's settings choose only the agent and
 * the model. None when no active Kortix workspace holds the link.
 */
export async function resolveOauthProject(teamId: string): Promise<ProjectResolution> {
  const projectId = await linkedSlackProject(teamId);
  return projectId ? { kind: 'project', projectId } : { kind: 'none' };
}

// ── DM slash-command fallback ────────────────────────────────────────────────
// Slack does NOT run slash commands inside the AI-Assistant DM pane (or any
// message thread) — typing `/kortix switch` there is delivered to us as a plain
// `message.im` instead of a slash payload. So when a DM message IS a `/kortix …`
// command, run it through the EXACT same handler the real slash endpoint uses
// and post the reply right back into the DM. This makes the commands work in
// DMs even though Slack's native slash mechanism can't reach the assistant pane.
const DM_COMMAND_RE = /^\/(kortix(?:-dev)?)\b[ \t]*([\s\S]*)$/i;

async function postSlashResponseToChannel(
  token: string,
  channelId: string,
  threadTs: string | undefined,
  resp: SlashResponse,
): Promise<void> {
  if (resp.blocks && resp.blocks.length > 0) {
    await postBlocks(token, channelId, resp.text ?? 'Kortix', resp.blocks, threadTs);
  } else if (resp.text) {
    await postMessage(token, channelId, resp.text, threadTs);
  }
}

export async function maybeHandleDmCommand(
  teamId: string,
  event: SlackEvent,
  fallbackProjectId?: string,
): Promise<boolean> {
  if (event.type !== 'message' || event.channel_type !== 'im' || event.subtype || event.bot_id) {
    return false;
  }
  const channelId = event.channel;
  if (!channelId) return false;
  const match = (event.text ?? '').trim().match(DM_COMMAND_RE);
  if (!match) return false;

  const command = `/${match[1].toLowerCase()}`;
  const [subRaw, ...rest] = (match[2] ?? '').trim().split(/\s+/);
  const sub = (subRaw || 'help').toLowerCase();
  const arg = rest.join(' ').trim();
  const threadTs = event.thread_ts ?? event.ts;

  // A bot token to reply with. A per-project (BYO) webhook replies with its own
  // app: the DM is with that app's bot. The shared app replies with the linked
  // Kortix workspace's token.
  const tokenProjectId = fallbackProjectId ?? (await linkedSlackProject(teamId));
  if (!tokenProjectId) return true; // it WAS a command — just nothing to reply with
  const token = await loadSlackTokenForProject(tokenProjectId);
  if (!token) return true;

  // The Assistant pane has no 3s ACK window and no response_url, so a command
  // that normally defers (the agent list touches git) posts its result straight
  // into the DM instead.
  const deferredDeliver = (body: SlashResponse): Promise<void> =>
    postSlashResponseToChannel(token, channelId, threadTs, body);

  let resp: SlashResponse;
  try {
    resp = await handleSlashCommand(sub, arg, {
      teamId,
      channelId,
      slackUserId: event.user ?? '',
      command,
      deferredDeliver,
      projectScopedProjectId: fallbackProjectId,
    });
  } catch (err) {
    console.error('[slack-webhook] dm command failed', err);
    resp = { response_type: 'ephemeral', text: 'Something went wrong handling that command. Try again in a moment.' };
  }
  await postSlashResponseToChannel(token, channelId, threadTs, resp);
  return true;
}

export async function classifyEvent(
  teamId: string,
  event: SlackEvent,
  botUserId: string | null,
): Promise<EventClass> {
  // AN app_mention MUST ACTUALLY MENTION THIS PROJECT'S BOT.
  //
  // PROD 2026-08-20. A user typed `@Kortix hey man` in a channel that also has
  // the "Incident reporter" bot in it, and Incident reporter answered:
  //
  //   mentioned bot    <bot_user_id>        (Kortix)
  //   bot that replied <other_bot_user_id>  (Incident reporter)
  //   session created  inside the Incident reporter's project
  //
  // Two Kortix-platform apps in one workspace, each with its own BYO webhook at
  // /slack/events/{projectId}. Whichever project the callback lands on answers,
  // because this line accepted EVERY app_mention on the strength of its type
  // alone. `botUserId` was already loaded and already passed in — it was simply
  // never consulted, while the plain-`message` branch below has checked it all
  // along. The asymmetry is the whole bug: the same event, arriving as the other
  // Slack event type, was routed correctly.
  //
  // A cross-wired Events Request URL or a swapped signing-secret/token pair can
  // deliver the event here, and that may well also be true. It does not matter:
  // a project that is not the one addressed must decline, so a misconfiguration
  // is a bot that stays quiet rather than a bot that impersonates another.
  //
  // Fails OPEN when we do not know our own bot id, which is a real state for a
  // BYO app that has never run `link-bot`. Refusing those would take every such
  // workspace's mentions offline to fix a two-bot workspace's routing, so it is
  // logged instead — the degradation is visible, and link-bot closes it.
  if (event.type === 'app_mention') {
    if (!botUserId) {
      console.warn(
        '[slack] app_mention accepted without verifying the mentioned bot: this Kortix workspace has no ' +
          'recorded bot user id (run `link-bot`). In a workspace with more than one Kortix app ' +
          'installed, this is how the wrong bot answers.',
      );
      return 'mention';
    }
    if (mentionsUser(event.text ?? '', botUserId)) return 'mention';
    console.warn(
      `[slack] ignoring an app_mention that does not mention this Kortix workspace's bot (${botUserId}) — ` +
        'it is addressed to another app in this workspace',
    );
    return 'ignore';
  }
  if (event.type !== 'message') return 'ignore';
  if (event.subtype) {
    // Allow these user-generated subtypes through:
    //   file_share   — audio messages, images, documents, etc. (agent sees file info)
    //   me_message   — /me actions (e.g. "/me waves hello")
    //   bot_message  — messages from OTHER bots (our own bot is blocked by
    //                  isOwnBotEvent in dispatchSlackEvent)
    // All other subtypes (message_changed, message_deleted, thread_broadcast,
    // channel_join, etc.) remain ignored to avoid loops, redundancy, or system noise.
    if (event.subtype === 'file_share' && event.files?.length) {
      // pass through
    } else if (event.subtype === 'me_message') {
      // pass through — user-generated /me action
    } else if (event.subtype === 'bot_message') {
      // pass through — other bots' messages (isOwnBotEvent prevents self-loops)
    } else {
      return 'ignore';
    }
  }
  // A `message` that @-mentions the bot IS a mention. Slack does NOT reliably
  // deliver an `app_mention` for a mention made INSIDE an existing thread —
  // notably a thread that predates the bot joining the channel — there it arrives
  // ONLY as a `message` (with `thread_ts`) via our `message.channels` /
  // `message.groups` subscription. Treating it as a mention is what lets the bot
  // answer when it's re-tagged in an old thread instead of going silent until you
  // start a fresh one. When Slack DOES send both siblings (the common top-level
  // case), the exactly-once `inboundMessageKey` gate — keyed on the shared
  // (team, channel, ts) — collapses them into a single run, so this never
  // double-answers.
  if (botUserId && mentionsUser(event.text ?? '', botUserId)) return 'mention';
  if (event.channel_type === 'im') return 'dm';
  // In a channel thread a mention runs the agent. An untagged reply is people
  // talking to each other, except the thread starter's in the agent's own
  // thread (`isStarterReplyInOwnThread`, checked by the caller, which knows
  // the project). The agent reads the rest on its next turn, with `slack thread`.
  return 'ignore';
}

/**
 * A reply, with no @mention, from the person who started this thread with the
 * agent: they are talking to it, as in a DM. Anyone else in the thread is
 * talking to people and still tags the agent to reach it. Only the session's
 * own origin thread counts (`metadata.slack`, written when the session
 * started), not a thread the agent posted into later.
 */
export async function isStarterReplyInOwnThread(projectId: string, teamId: string, event: SlackEvent): Promise<boolean> {
  if (event.type !== 'message' || event.subtype || event.bot_id || !event.user || !event.channel) return false;
  if (!event.thread_ts || event.thread_ts === event.ts || event.channel_type === 'im') return false;
  const session = await findChatThreadSession({ platform: 'slack', workspaceId: teamId, threadId: event.thread_ts }, projectId);
  const origin = (session?.metadata as { slack?: { user?: unknown; channel?: unknown; thread_ts?: unknown } } | null)?.slack;
  return origin?.thread_ts === event.thread_ts && origin.channel === event.channel && origin.user === event.user;
}

const CHANNEL_INTRO_FALLBACK = "Kortix is now connected to this channel. Mention @Kortix with a task to get started.";

async function postChannelIntro(projectId: string, channelId: string): Promise<void> {
  const token = await loadSlackTokenForProject(projectId);
  if (!token) return;
  const [project] = await db
    .select({ name: projectsView.name })
    .from(projectsView)
    .where(eq(projectsView.projectId, projectId))
    .limit(1);
  const projectLine = project?.name
    ? `This channel is connected to *${escapeMrkdwn(project.name)}*.`
    : 'This channel is connected to a Kortix workspace.';
  const blocks: Array<Record<string, unknown>> = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Kortix is connected to this channel', emoji: false },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          '`@`-mention Kortix with a task and an agent gets on it — working across your connected tools and replying right here in the thread. Tag Kortix again in the thread to follow up — it reads the thread first.',
          projectLine,
          'Agent, model, and session policy settings are shared by this Slack channel.',
          '',
          'Try something like:',
          '• `@Kortix summarize this thread and draft a reply to the customer`',
          '• `@Kortix pull last week’s signups, group them by source, and drop a CSV here`',
          '• `@Kortix put together a one-pager on our Q2 numbers`',
          '',
          'Use the app slash command with `help` to see channel settings.',
        ].join('\n'),
      },
    },
  ];
  await postBlocks(token, channelId, CHANNEL_INTRO_FALLBACK, blocks);
}

export async function maybePostChannelIntro(teamId: string, event: SlackEvent): Promise<void> {
  if (!event.channel) return;
  const projectId = await linkedSlackProject(teamId);
  if (!projectId) return;
  const botUserId = await loadSlackBotUserIdForProject(projectId);
  if (!botUserId || event.user !== botUserId) return;
  await postChannelIntro(projectId, event.channel);
}

/**
 * Is this event OUR OWN bot talking? The self-loop guard, and nothing wider.
 *
 * The gate here used to be `(botUserId && event.user === botUserId) || event.bot_id`,
 * which returns on ANY bot — so a message from another app could never reach
 * classifyEvent. That made classifyEvent's `bot_message` branch dead code: it is
 * written to pass other bots through, and says so ("our own bot is blocked by the
 * separate gate in dispatchSlackEvent"), but nothing ever arrived. Three tests in
 * unit-slack-classify-event.test.ts assert that branch works and pass today,
 * because they call classifyEvent directly and never cross this gate.
 *
 * Only OUR messages can loop. A plain post comes back with our bot user id as
 * `event.user`. A post under a Kortix agent's name (`username`, slack/persona.ts)
 * comes back with NO `user`, so the third clause matches it by our bot id
 * (`auth.test`, stored as SLACK_BOT_ID). persona.ts sends a name only once that
 * id is stored, so every agent-named post is recognizable here.
 *
 * The second clause covers the one hole. `botUserId` comes from a secret read on
 * every event, and if that read fails we cannot tell our own message from another
 * app's — so we stay conservative with BOT traffic specifically. Humans are
 * unaffected in that window, which a blanket fail-closed would not manage.
 *
 * The bot id is resolved on first agent-named post, not at install:
 * `oauth.v2.access` does not return one, and this way existing installs need no
 * backfill. botUserId stays the primary key: it is a REQUIRED field on both
 * install paths (install-store.ts saveSlackInstall + saveSlackOauthInstall).
 */
export function isOwnBotEvent(event: SlackEvent, botUserId: string | null, botId: string | null = null): boolean {
  if (botUserId && event.user === botUserId) return true;
  // A post under an agent's name (`username`) arrives with no `user`: our bot id marks it.
  if (botId && event.bot_id === botId) return true;
  if (event.bot_id && !botUserId) return true;
  return false;
}

// `ownThreadsOnly`: set by the per-project (BYO) webhook. Every BYO app in a
// workspace receives every channel message, so a mention inside a thread that
// another project's session owns is refused, not joined (`routeSlackThread`).
export async function dispatchSlackEvent(
  projectId: string,
  envelope: SlackEnvelope,
  opts: { ownThreadsOnly?: boolean } = {},
): Promise<void> {
  const event = envelope.event;
  if (!event) return;

  const teamId = envelope.team_id ?? event.team ?? '';
  if (teamId && event.channel) {
    await recordSlackChannel(projectId, teamId, event.channel);
  }
  const botUserId = await loadSlackBotUserIdForProject(projectId);
  const botId = await loadSlackBotIdForProject(projectId).catch(() => null);

  if (
    event.type === 'member_joined_channel' &&
    botUserId &&
    event.user === botUserId &&
    event.channel
  ) {
    await postChannelIntro(projectId, event.channel);
    return;
  }

  if (isOwnBotEvent(event, botUserId, botId)) return;

  let eventClass = await classifyEvent(teamId, event, botUserId);
  if (eventClass === 'ignore' && (await isStarterReplyInOwnThread(projectId, teamId, event))) eventClass = 'mention';
  if (eventClass === 'ignore') return;

  // Exactly-once gate. ONE user message can arrive as several events (Slack
  // delivers a channel @mention as both `app_mention` and `message`), be retried
  // with a fresh event_id, and fan across replicas — but every delivery shares the
  // message's (team, channel, ts) — per RECEIVING project, because every BYO app
  // of the workspace receives the same message. Claim that identity atomically;
  // if we lose, a sibling delivery of OUR project already owns this message, so
  // we must NOT run it again.
  // This gate must sit before every visible Slack response, including auth
  // prompts and empty-mention help, so one bare @mention never posts twice.
  // (Button clicks synthesize their own turns via spawnAgentTurn directly and are
  // intentionally NOT gated here, so re-clicking an option still works.)
  const msgKey = inboundMessageKey(projectId, teamId, event);
  if (msgKey && !(await claimInboundMessage(msgKey))) return;

  // A bare @mention with no text is a "what now?" prompt — post help text.
  // But if the user attached files (e.g. an audio message), the files are the
  // content, so don't stop here — send them to the agent.
  if (eventClass === 'mention' && !stripMentions(event.text ?? '') && !event.files?.length) {
    if (config.SLACK_REQUIRE_USER_IDENTITY) {
      const projectAccountId = await accountKeyOfWorkspace(projectId);
      if (!projectAccountId) return;
      const slackUserId = event.user ?? '';
      const actor = await resolveSlackActor(chatUser('slack', teamId, slackUserId), { projectId, accountId: projectAccountId });
      if ('reason' in actor) {
        // Same reason as the main path below: a bot cannot read a prompt
        // addressed to it. See `<cmd> link-bot`.
        if (!event.bot_id) {
          await postIdentityPrompt({
            projectId,
            teamId,
            channel: event.channel,
            threadTs: event.thread_ts,
            slackUserId,
            reason: actor.reason,
          });
        }
        return;
      }
    }
    const token = await loadSlackTokenForProject(projectId);
    if (token && event.channel) {
      await postMessage(
        token,
        event.channel,
        "Mention @Kortix with a task and I'll get on it.",
        event.thread_ts ?? event.ts,
      );
    }
    return;
  }

  await spawnAgentTurn(projectId, envelope, event, opts);
}

const FOREIGN_THREAD_NOTICE =
  'This thread belongs to a different Kortix workspace. Mention me in a new message to start here.';

// `ownThreadsOnly`: the per-project (BYO) webhook. Its requests may reach only
// its own project, so a thread another project owns is refused, not joined.
// `authorizedResume`: the decision this message reports (a review verdict, an
// approval) was already authorized for this project. The join policy governs
// who may TALK in a thread; it must not strand the agent after a manager who
// is not a participant decided. The sender is still resolved as a linked
// member below.
// `press`: a click on an agent question's button. It reaches only the thread's
// session, under its own key; it never starts or revives a session, and an
// unlinked sender's click is not kept for after login (they click again).
export async function spawnAgentTurn(
  projectId: string,
  envelope: SlackEnvelope,
  event: SlackEvent,
  opts: SlackTurnOpts = {},
): Promise<void> {
  const teamId = envelope.team_id ?? event.team ?? '';
  const threadId = event.thread_ts ?? event.ts ?? '';

  // Messages, button clicks, approvals and reviews all start turns here: only
  // a Kortix workspace that holds this Slack workspace runs one (link.ts).
  if (teamId && !(await holdsSlackWorkspace(projectId, teamId))) return;

  // Resolve who the agent runs AS. Gated by SLACK_REQUIRE_USER_IDENTITY:
  //  • ON  — every sender (first message OR follow-up, channel OR button click)
  //    must be linked to a Kortix account that is a member of this project's
  //    account. No live mapping → block and nudge to `/login`; never fall back
  //    to the owner (the impersonation this fixes).
  //  • OFF — legacy behavior: run as the account owner stand-in.
  const [project] = await db
    .select({ accountId: projectsView.accountId, metadata: projectsView.metadata })
    .from(projectsView)
    .where(eq(projectsView.projectId, projectId))
    .limit(1);
  if (!project) return;

  let actorUserId: string;
  if (config.SLACK_REQUIRE_USER_IDENTITY) {
    const slackUserId = event.user ?? '';
    const actor = await resolveSlackActor(chatUser('slack', teamId, slackUserId), { projectId, accountId: project.accountId });
    if ('reason' in actor) {
      // A BOT cannot act on this. postIdentityPrompt posts an ephemeral AND a DM
      // to slackUserId, so for a bot sender both land where no human will ever
      // see them, and the mention reads as "Kortix ignored it" — which is how
      // this went undiagnosed. Link it with `<cmd> link-bot @TheBot` instead.
      if (event.bot_id) return;
      await postIdentityPrompt({
        projectId,
        teamId,
        channel: event.channel,
        // Top-level ephemeral prompts should render beside the message. Passing
        // the message ts as thread_ts hides the auth prompt in a new thread.
        threadTs: event.thread_ts,
        slackUserId,
        reason: actor.reason,
        ...(opts.press ? {} : { envelope, event }),
      });
      return;
    }
    actorUserId = actor.userId;
  } else {
    const owner = await resolveProjectAutomationActor(project.accountId);
    if (!owner) {
      console.warn('[slack-webhook] no actor for project', projectId);
      return;
    }
    actorUserId = owner;
  }

  await routeSlackThread(projectId, envelope, event, opts, project, actorUserId, teamId, threadId);
}

async function routeSlackThread(
  projectId: string,
  envelope: SlackEnvelope,
  event: SlackEvent,
  opts: SlackTurnOpts,
  project: { accountId: string; metadata: typeof projectsView.$inferSelect.metadata },
  actorUserId: string,
  teamId: string,
  threadId: string,
): Promise<void> {
  let revived = false;
  if (teamId && threadId) {
    const thread = { platform: 'slack', workspaceId: teamId, threadId };
    let existing = await findChatThreadSession(thread);
    // A thread another Kortix workspace's session owns. While that workspace
    // still holds a Slack link (its own Slack app, or the event came through
    // one), the thread stays its own and this one is refused. Once it lost the
    // link (slack/link.ts), the mapping is stale: the thread starts over here.
    if (existing?.projectId && existing.projectId !== projectId) {
      if (opts.ownThreadsOnly || (await holdsSlackWorkspace(existing.projectId, teamId))) {
        if (!event.bot_id && event.channel) {
          const token = await loadSlackTokenForProject(projectId);
          if (token) await postMessage(token, event.channel, FOREIGN_THREAD_NOTICE, threadId);
        }
        return;
      }
      await dropChatThread(thread);
      await clearThreadErrorNotice(teamId, threadId);
      existing = null;
      revived = true;
    }
    if (existing) {
      if (!(await mayJoinSlackThread(projectId, event, opts, actorUserId, teamId, threadId, existing))) return;
      const { press } = opts;
      const deliver = (e: SlackEvent, opened?: LiveTurn | null) =>
        deliverToExistingThread(projectId, envelope, e, project, actorUserId, teamId, threadId, thread, existing, press?.key, opened);
      if (press?.button) {
        await answerSlackQuestion(projectId, teamId, threadId, existing.sessionId, event, press, press.button, deliver);
        return;
      }
      const delivery = await deliver(event);
      if (delivery.handled) return;
      const { handle } = delivery;
      if (press) {
        await dropPressTurn(existing.sessionId, handle);
        await showQuestionEarlier(projectId, event, press, []);
        return;
      }

      // outcome === 'no-session': the durable projectSessions row itself is gone
      // (deleted; the chat_threads FK cascade should already have dropped this
      // mapping). With the 404-heal in the shared lifecycle delivery path a stale runtime
      // root no longer masquerades as 'no-session', so this is now ONLY a truly
      // deleted session. Drop the stale mapping and recreate — atomically, below,
      // so the recreate can never shadow a live session.
      console.warn('[slack-webhook] thread mapped to a deleted session — replacing', {
        teamId,
        threadId,
        sessionId: existing.sessionId,
      });
      if (handle) await deleteTurn(existing.sessionId);
      revived = true;
      await dropChatThread(thread);
      // Reviving onto a brand-new session — re-arm the failure notice so that
      // session's own first fault is reported, not swallowed by the dead one's claim.
      await clearThreadErrorNotice(teamId, threadId);
    }
  }

  if (opts.press) {
    await showQuestionEarlier(projectId, event, opts.press, []);
    return;
  }
  // No live mapping for this thread → create the session, or JOIN one that a
  // concurrent handler is creating this very moment. Single atomic create path.
  await createOrJoinThreadSession({ projectId, teamId, threadId, envelope, event, revived, actorUserId });
}

/**
 * A click on a button that names its stored question (`kq:`, core/questions.ts).
 * The answer is the stored option, the message shows who gave it, and only the
 * question's own session hears it: in the turn the question still blocks, else
 * as a follow-up under the click's own key. A question of another session, or
 * a session that is gone, answers nothing, and the message says so.
 */
async function answerSlackQuestion(
  projectId: string,
  teamId: string,
  threadId: string,
  sessionId: string,
  event: SlackEvent,
  press: SlackQuestionPress,
  { pendingId, question, index }: NonNullable<SlackQuestionPress['button']>,
  deliver: (event: SlackEvent, opened: LiveTurn | null) => ReturnType<typeof deliverToExistingThread>,
): Promise<void> {
  const { decideQuestionPress, settleQuestionAnswer } = await import('../core/questions');
  const p: QuestionPress = {
    target: { platform: 'slack', workspaceId: teamId, threadId, projectId },
    ref: `${event.channel}:${event.ts}`,
    pendingId,
    picks: [{ question, options: [index] }],
  };
  const decision = await decideQuestionPress(p, async (sid) => (sid === sessionId ? threadId : null));
  if (decision.kind === 'earlier') return showQuestionEarlier(projectId, event, press, decision.questions);

  const { answer } = decision;
  const line = `✓ *${escapeMrkdwn(answer.label)}* — <@${event.user}>`;
  await editQuestionMessage(projectId, event, press, answer.questions, line, (blocks) => answeredQuestionBlocks(blocks, question, line));
  // Opened before the answer goes anywhere: a question still blocking the turn
  // resumes that turn, and its steps and reply need this turn to land in.
  const opened = await openThreadTurn(projectId, teamId, event, sessionId);
  const settled = await settleQuestionAnswer(
    p,
    answer,
    async (a) => {
      const delivery = await deliver({ ...event, text: a.prompt }, opened);
      if (delivery.handled) return 'handled';
      await dropPressTurn(sessionId, delivery.handle);
      return 'gone';
    },
    // Slack does not send a click again.
    { finalAttempt: true },
  ).catch(async (err: unknown) => {
    await dropPressTurn(sessionId, opened);
    throw err;
  });
  if (settled === 'gone') await showQuestionEarlier(projectId, event, press, answer.questions);
}

/**
 * Edit the clicked question message: `edit` its blocks from the click, else
 * the ones rebuilt from the stored `questions`. A message that cannot be
 * edited (a `qa_` button, a failed update) tells the clicker `line` instead.
 */
async function editQuestionMessage(
  projectId: string,
  event: SlackEvent,
  press: SlackQuestionPress,
  questions: QuestionInfo[],
  line: string,
  edit: (blocks: unknown[]) => unknown[] | null,
): Promise<void> {
  const { channel, ts } = event;
  const blocks = press.button && (press.blocks ?? (questions.length ? buildQuestionBlocks(questions, press.button.pendingId) : null));
  const edited = blocks ? edit(blocks) : null;
  if (edited && channel && ts) {
    const token = await loadSlackTokenForProject(projectId);
    if (token && (await updateBlocks(token, channel, ts, line, edited))) return;
  }
  await respondViaUrl(press.responseUrl, { response_type: 'ephemeral', text: line });
}

const showQuestionEarlier = (projectId: string, event: SlackEvent, press: SlackQuestionPress, questions: QuestionInfo[]) =>
  editQuestionMessage(projectId, event, press, questions, QUESTION_EARLIER, earlierQuestionBlocks);

/** A turn on `event` for the session: ⏳ on it, steps and reply into it. Null when one is in flight: its answer covers `event` too. */
async function openThreadTurn(projectId: string, teamId: string, event: SlackEvent, sessionId: string): Promise<LiveTurn | null> {
  const inflight = await loadTurn(sessionId);
  if (inflight && !inflight.finalized) return null;
  const handle = await startTurn(projectId, teamId, event, 'On it');
  if (handle) {
    handle.sessionId = sessionId;
    await saveTurn(handle);
  }
  return handle;
}

/** The turn a click opened when nothing reached the session: clear its ⏳ and drop it. */
async function dropPressTurn(sessionId: string, handle: LiveTurn | null): Promise<void> {
  if (!handle) return;
  await finalizeTurn(handle, {});
  await deleteTurn(sessionId);
}

async function mayJoinSlackThread(
  projectId: string,
  event: SlackEvent,
  opts: { authorizedResume?: boolean },
  actorUserId: string,
  teamId: string,
  threadId: string,
  existing: NonNullable<Awaited<ReturnType<typeof findChatThreadSession>>>,
): Promise<boolean> {
  if (!config.SLACK_REQUIRE_USER_IDENTITY || opts.authorizedResume) return true;
  const selection = event.channel
    ? await currentChannelSelection({ teamId, channelId: event.channel, projectId })
    : null;
  return ensureSlackThreadParticipant({
    projectId,
    teamId,
    channel: event.channel,
    threadId,
    sessionId: existing.sessionId,
    sessionOwnerId: existing.createdBy,
    sessionMetadata: existing.metadata as Record<string, unknown> | null,
    channelPolicy: selection?.conversationPolicy,
    slackUserId: event.user ?? '',
    actorUserId,
  });
}

async function deliverToExistingThread(
  projectId: string,
  envelope: SlackEnvelope,
  event: SlackEvent,
  project: { accountId: string; metadata: typeof projectsView.$inferSelect.metadata },
  actorUserId: string,
  teamId: string,
  threadId: string,
  thread: Parameters<typeof touchChatThread>[0],
  existing: NonNullable<Awaited<ReturnType<typeof findChatThreadSession>>>,
  idempotencyKey = slackFollowUpKey(teamId, event),
  // The turn the caller already opened for `event` (openThreadTurn).
  opened?: LiveTurn | null,
) {
  const handle = opened === undefined ? await openThreadTurn(projectId, teamId, event, existing.sessionId) : opened;
  const plan = await slackFollowUpModel({
    project: { projectId, accountId: project.accountId, metadata: project.metadata },
    userId: actorUserId,
    sessionId: existing.sessionId,
    event,
    session: {
      createdBy: existing.createdBy ?? null,
      metadata: existing.metadata,
      agentName: existing.agentName ?? null,
    },
  });
  const outcome = await deliverSlackFollowUpToSession({
    sessionId: existing.sessionId,
    idempotencyKey,
    text: renderFollowUpPrompt(
      envelope,
      event,
      await slackMessageLabels({ projectId, teamId, event }),
      plan.imagesUnavailable,
    ),
    userId: actorUserId,
    model: plan.model,
  });

  // `queued`: the reply is durable and the queue delivers it once the box is
  // up; the turn handle stays open for that answer.
  if (outcome === 'delivered' || outcome === 'queued') {
    await touchChatThread(thread);
    return { handled: true as const, handle };
  }

  if (outcome === 'failed') {
    if (handle) {
      await deleteTurn(existing.sessionId);
      if (await claimThreadErrorNotice(teamId, threadId)) {
        const url = sessionWebUrl(config.FRONTEND_URL, projectId, existing.sessionId);
        await finalizeTurn(handle, {
          error: `This thread's session hit an error and couldn't start. <${url}|Open it in Kortix> to see what happened.`,
        });
      } else {
        await closeWaitingTurn(handle, "Couldn't start");
      }
    }
    return { handled: true as const, handle };
  }

  // Only a deleted session is replaced. Anything else revived the thread onto a
  // new session and orphaned a live one.
  return { handled: false as const, handle };
}
