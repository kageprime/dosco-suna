import { PROJECT_ACTIONS } from '../../iam/actions';
import { and, eq } from 'drizzle-orm';
import { projectSessions } from '@kortix/db';
import { db } from '../../shared/db';
import { config } from '../../config';
import { loadSlackTokenForProject } from '../install-store';
import { openModal, updateModal } from '../slack-api';
import { spawnAgentTurn } from './dispatch';
import { parseQuestionButton } from '../core/question-token';
import { QUESTION_EARLIER } from './questions';
import { notifyAdminsOfAccessRequest } from './identity';
import { chatUser, createChatAccessRequest } from '../core/identity';
import { resolveSlackActor } from './auto-link';
import { parseReviewActionId, reviewVerbToVerdict, type ReviewVerb } from './review-cards';
import {
  REVIEW_FEEDBACK_CALLBACK,
  buildReviewFeedbackView,
  decodeReviewMetadata,
  readReviewFeedback,
} from './review-modal';
import { applyVerdict, getReviewItemById } from '../../projects/review-items';
import {
  APPROVAL_REPLY_CALLBACK,
  handleApprovalCardAction,
  handleApprovalReplySubmission,
  parseApprovalActionId,
} from './approval-card';
import { SLACK_STOP_ACTION, stopSlackTurn } from './stop';
import { SLACK_SWITCH_AGENT_ACTION } from './stop-action';
import { isAdaptedId } from '../../projects/review-adapters';
import { decideSlackThreadJoin } from './participants';
import { attachPendingSlackAuthResponseUrl } from './auth-resume';
import { buildSlackLoginUrl, verifyLoginState } from './login';
import { escapeMrkdwn, respondViaUrl, sessionWebUrl, slackChannelIsDm } from './util';
import { handleSlashCommand } from './commands';
import { NO_LINK_TEXT, agentChangeText, currentChannelProjectId } from './settings-commands';
import { slackSettingsChannel, slackUserOf } from './settings-text';
import { applySlackModelChoice } from './model-choice';
import { changeChannelAgent } from '../core/settings';
import type { SlashCtx } from './types';
import { buildAgentPickerBlocks, loadScopedChannelAgents } from './agent-picker';
import { currentChannelSelection } from './selection';
import { holdsSlackWorkspace, linkedSlackProject } from './link';
import { logger } from '../../lib/logger';
import {
  CANONICAL_SLACK_INBOUND,
  findSlackThread,
  inboundAllowsProject,
  inboundAllowsTeam,
  inboundProjectId,
  type SlackInbound,
} from './inbound';
import type { SlackEnvelope, SlackEvent, SlackInteractionPayload } from './types';

const OTHER_PROJECT_NOTICE = 'This Slack app is tied to a different Kortix workspace.';

/** spawnAgentTurn options for a request from `inbound`. */
function turnScope(inbound: SlackInbound): { ownThreadsOnly: boolean } {
  return { ownThreadsOnly: inbound.kind === 'project' };
}

// Agent-emitted button click (carousel cards, actions blocks). Routes the
// click back into the thread as a synthesized follow-up so the agent's next
// turn picks up from the user's choice.
async function handleAgentClick(
  payload: SlackInteractionPayload,
  action: NonNullable<SlackInteractionPayload['actions']>[number],
  inbound: SlackInbound,
): Promise<void> {
  const teamId = payload.team?.id ?? '';
  const channelId = payload.channel?.id ?? '';
  const userId = payload.user?.id ?? '';
  const messageTs = payload.message?.ts ?? '';
  const threadTs = payload.message?.thread_ts ?? messageTs;
  if (!teamId || !channelId || !userId || !threadTs) return;

  const label = (action.text?.text ?? action.action_id ?? '').trim();
  const value = (action.value ?? '').trim();

  await respondViaUrl(payload.response_url, {
    response_type: 'ephemeral',
    text: `On it — picked *${label || action.action_id}*.`,
  });

  const thread = await findSlackThread(inbound, teamId, threadTs);
  if (!thread) {
    // The button lives on a message with no session thread behind it —
    // typically an actions block the agent posted top-level with
    // `slack send --channel` and no `--thread`. The user already saw "On it";
    // dropping silently here is how a click turned into nothing.
    console.warn('[slack-webhook] button click dropped — no session thread for message', {
      teamId,
      channelId,
      threadTs,
      actionId: action.action_id,
    });
    await respondViaUrl(payload.response_url, {
      response_type: 'ephemeral',
      text: "This button isn't attached to a Kortix thread, so nothing can pick it up. Reply in the session's thread instead.",
    });
    return;
  }

  // A click is a full turn. `spawnAgentTurn` wraps this text the way it wraps
  // a message: the header names the channel and the person beside their ids,
  // and the working instructions follow, so the agent streams progress with
  // `slack step` and closes the turn with `slack send`. The text is the click.
  const lines = [`[Button click] The user clicked *${label || action.action_id}*.`];
  if (action.action_id) lines.push(`action_id: \`${action.action_id}\``);
  if (value) lines.push(`value: \`${value}\``);
  lines.push('', 'Continue the turn based on this choice.');

  const event: SlackEvent = {
    type: 'message',
    user: userId,
    channel: channelId,
    text: lines.join('\n'),
    ts: messageTs,
    thread_ts: threadTs,
    team: teamId,
  };
  const envelope: SlackEnvelope = {
    type: 'event_callback',
    team_id: teamId,
    event,
  };
  await spawnAgentTurn(thread.projectId, envelope, event, turnScope(inbound));
}

// A click on one of the agent's `question` options (rendered as buttons by
// buildQuestionBlocks, action_id `qa_<q>_<o>`). A `kq:` value names the stored
// question: the answer is the stored option, the message is edited to show who
// gave it (other questions keep their buttons), and only the question's own
// session hears it (dispatch.ts `answerSlackQuestion`). Any other value is a
// button posted before that: its label goes to the thread's session as a
// follow-up. Either way each click has its own follow-up key, so a second click
// is never dropped, and a click never starts or revives a session.
async function handleQuestionAnswer(
  payload: SlackInteractionPayload,
  action: NonNullable<SlackInteractionPayload['actions']>[number],
  inbound: SlackInbound,
): Promise<void> {
  const teamId = payload.team?.id ?? '';
  const channelId = payload.channel?.id ?? '';
  const userId = payload.user?.id ?? '';
  const messageTs = payload.message?.ts ?? '';
  const threadTs = payload.message?.thread_ts ?? messageTs;
  if (!teamId || !channelId || !userId || !threadTs) return;
  const ephemeral = (text: string) => respondViaUrl(payload.response_url, { response_type: 'ephemeral', text });
  // The click's own key: without it, this click could not be told from another.
  if (!payload.trigger_id) return ephemeral("Couldn't record that click. Click the option again.");
  const button = parseQuestionButton(action.value ?? '');

  const lines: string[] = [];
  if (!button) {
    let parsed: { q?: string; a?: string } = {};
    try {
      parsed = JSON.parse(action.value ?? '{}') as { q?: string; a?: string };
    } catch {
      parsed = {};
    }
    const label = (parsed.a ?? action.text?.text ?? '').trim();
    const question = (parsed.q ?? '').trim();
    // Ephemeral ack only: this message is never edited.
    await ephemeral(`On it — *${escapeMrkdwn(label)}*.`);
    if (question) lines.push(`Answering your question "${question}":`);
    lines.push(label || 'see the selection above');
    lines.push('', 'Continue the turn based on this answer.');
  }

  const thread = await findSlackThread(inbound, teamId, threadTs);
  if (!thread) {
    if (button) await ephemeral(QUESTION_EARLIER);
    return;
  }

  // A `kq:` click's text is the stored answer, set at delivery.
  const event: SlackEvent = {
    type: 'message',
    user: userId,
    channel: channelId,
    text: lines.join('\n'),
    ts: messageTs,
    thread_ts: threadTs,
    team: teamId,
  };
  const envelope: SlackEnvelope = { type: 'event_callback', team_id: teamId, event };
  await spawnAgentTurn(thread.projectId, envelope, event, {
    ...turnScope(inbound),
    press: {
      key: `slack:${button ? 'kq' : 'qa'}:${teamId}:${channelId}:${messageTs}:${payload.trigger_id}`,
      ...(button ? { button } : {}),
      responseUrl: payload.response_url,
      blocks: payload.message?.blocks,
    },
  });
}

// A click on a Review Center card button (rendered by buildReviewCardBlocks,
// action_id `review_<verb>_<id>`). Apply the human's verdict to the review item,
// ack ephemerally, then resume the waiting session with the decision as a
// follow-up turn — the SAME path a question answer takes (handleQuestionAnswer),
// so a Slack-submitted review behaves natively instead of dead-ending.
async function handleReviewAction(
  payload: SlackInteractionPayload,
  parsed: { verb: ReviewVerb; id: string },
  inbound: SlackInbound,
): Promise<void> {
  const teamId = payload.team?.id ?? '';
  const channelId = payload.channel?.id ?? '';
  const slackUserId = payload.user?.id ?? '';
  const messageTs = payload.message?.ts ?? '';
  const threadTs = payload.message?.thread_ts ?? messageTs;
  if (!teamId || !channelId || !slackUserId || !threadTs) return;

  // 'view' is a link button (opens Kortix) — Slack still fires its block_action,
  // but there's nothing to apply.
  const verdict = reviewVerbToVerdict(parsed.verb);
  if (!verdict) return;

  // Adapted items (change requests, connector approvals) keep their own act flow —
  // their verdict can't be applied through the native review path.
  if (isAdaptedId(parsed.id)) {
    await respondViaUrl(payload.response_url, {
      response_type: 'ephemeral',
      text: 'Open this item in Kortix to act on it.',
    });
    return;
  }

  // Resolve the thread → its project so we can scope the item + the actor.
  const thread = await findSlackThread(inbound, teamId, threadTs);
  if (!thread) return;
  // A Kortix workspace that no longer holds this Slack workspace decides nothing here.
  if (!(await holdsSlackWorkspace(thread.projectId, teamId))) return;

  // "Request changes" is useless without saying what to change, and Slack has
  // no way to put a box on the posted message — only a modal. Open it here and
  // apply the verdict on submit instead.
  //
  // ORDERING: `trigger_id` expires in ~3 seconds. Everything before
  // `views.open` spends that budget, so the item lookup and the authorization
  // check deliberately happen on SUBMIT, not here — a refusal the reviewer
  // reads after typing is far better than a button that silently does nothing
  // for everyone. The submit path re-resolves and re-authorizes from scratch.
  if (verdict === 'changes' && payload.trigger_id) {
    const token = await loadSlackTokenForProject(thread.projectId);
    if (token) {
      const opened = await openModal(
        token,
        payload.trigger_id,
        buildReviewFeedbackView({
          title: parsed.id,
          metadata: {
            reviewItemId: parsed.id,
            projectId: thread.projectId,
            teamId,
            threadTs,
            channelId,
            messageTs,
            responseUrl: payload.response_url,
          },
        }),
      );
      if (opened) return;
      // The modal could not open (expired trigger, missing scope). Fall through
      // and apply the verdict without feedback — the old behaviour — rather
      // than dropping the reviewer's decision on the floor.
    }
  }

  const item = await getReviewItemById(parsed.id, thread.projectId);
  if (!item) {
    await respondViaUrl(payload.response_url, {
      response_type: 'ephemeral',
      text: 'That review item is no longer available.',
    });
    return;
  }

  // The actor must be a linked Kortix user with write access to this project.
  // Self-approve is allowed (launcher or any manager) — there's no separation-of-
  // duties gate. No live mapping → nudge to connect / request access.
  const actor = await resolveSlackActor(chatUser('slack', teamId, slackUserId), { projectId: thread.projectId, accountId: item.accountId }, PROJECT_ACTIONS.PROJECT_REVIEW_ACT);
  if ('reason' in actor) {
    await respondViaUrl(payload.response_url, {
      response_type: 'ephemeral',
      text:
        actor.reason === 'unlinked'
          ? 'Connect your Kortix account first (`/kortix login`) to act on reviews.'
          : "You don't have access to act on this Kortix workspace's reviews.",
    });
    return;
  }

  const decided = await applyVerdict(parsed.id, thread.projectId, {
    verdict,
    feedback: null,
    actingUserId: actor.userId,
  });
  if (decided === null) {
    // Someone decided it first (another click, the web inbox): change nothing.
    await respondViaUrl(payload.response_url, {
      response_type: 'ephemeral',
      text: `*${escapeMrkdwn(item.title)}* was already decided.`,
    });
    return;
  }

  // Ephemeral ack only (NOT replace_original) — keep the card so a sibling button
  // or a re-click still works, mirroring handleQuestionAnswer.
  const title = escapeMrkdwn(item.title);
  await respondViaUrl(payload.response_url, {
    response_type: 'ephemeral',
    text:
      verdict === 'approve'
        ? `Approved *${title}* ✓ — resuming the agent.`
        : verdict === 'reject'
          ? `Rejected *${title}*.`
          : `Asked for changes on *${title}*.`,
  });

  // Resume the session with the decision as a follow-up turn (same path as a
  // question answer / an in-thread reply). spawnAgentTurn re-checks the clicker's
  // access from event.user, so this can't run as anyone but them.
  const decisionLine =
    verdict === 'approve'
      ? `The review "${item.title}" was approved.`
      : verdict === 'reject'
        ? `The review "${item.title}" was rejected — do not proceed with it.`
        : `Changes were requested on the review "${item.title}". Ask what to change, then revise.`;

  const event: SlackEvent = {
    type: 'message',
    user: slackUserId,
    channel: channelId,
    text: [decisionLine, '', 'Continue the turn based on this decision.'].join('\n'),
    ts: messageTs,
    thread_ts: threadTs,
    team: teamId,
  };
  const envelope: SlackEnvelope = { type: 'event_callback', team_id: teamId, event };
  await spawnAgentTurn(thread.projectId, envelope, event, { ...turnScope(inbound), authorizedResume: true });
}

// Pick an agent/model from the `/kortix agents` or `/kortix models` picker.
// The value carries the channel + selection ('' = clear → project default).
async function handleSetSelection(
  payload: SlackInteractionPayload,
  rawValue: string,
  kind: 'agent' | 'model',
  inbound: SlackInbound,
): Promise<void> {
  let value: { c?: string; a?: string; m?: string };
  try {
    value = JSON.parse(rawValue || '{}') as { c?: string; a?: string; m?: string };
  } catch {
    return;
  }
  const teamId = payload.team?.id ?? '';
  // From the Switch agent modal: the answer replaces the modal's content.
  const modalId = payload.view?.id;
  // The conversation Slack vouches for: the one clicked in, or the one Kortix
  // opened the modal for (`private_metadata`; connectors cannot open views).
  // Never the button's `value`: whoever posted the button wrote that.
  const channelId = (modalId ? payload.view?.private_metadata : payload.channel?.id) ?? '';
  if (!teamId || !channelId || (value.c && value.c !== channelId)) return;
  const ctx = { teamId, channelId, projectScopedProjectId: inboundProjectId(inbound) ?? undefined };
  const reply = modalId
    ? async (text: string) => {
        const token = await clickToken(teamId, inbound);
        if (token) await updateModal(token, modalId, switchAgentModal(channelId, modalText(text)));
      }
    : (text: string) => respondViaUrl(payload.response_url, { response_type: 'ephemeral', replace_original: true, text });
  // A per-project app configures only channels bound to its own project.
  if (inbound.kind === 'project' && (await currentChannelProjectId(ctx)) !== inbound.projectId) {
    await reply(OTHER_PROJECT_NOTICE);
    return;
  }
  const slackUserId = payload.user?.id ?? '';
  if (kind === 'model') {
    // One path for `/kortix model <id>` and the picker: checked as the person
    // who clicked, with this conversation's keys (channels/slack/model-choice.ts).
    await reply(await applySlackModelChoice({ ...ctx, slackUserId, command: '/kortix' }, value.m ?? ''));
    return;
  }
  const requested = value.a || null;
  const result = await changeChannelAgent(slackUserOf({ teamId, slackUserId }), slackSettingsChannel(ctx), requested);
  const text = agentChangeText(result, requested ?? '', '/kortix', NO_LINK_TEXT);
  await reply(`${result.ok ? '✓' : '⚠️'} ${text}`);
}

// A `/kortix` panel "Change model/agent/project" button. Re-runs the matching
// slash subcommand for the channel and replaces the panel with that picker, so
// the whole config flow lives behind one command + inline buttons.
async function handleConfigOpen(
  payload: SlackInteractionPayload,
  actionId: 'cfg_open_models' | 'cfg_open_agents',
  inbound: SlackInbound,
): Promise<void> {
  const teamId = payload.team?.id ?? '';
  const channelId = payload.channel?.id ?? '';
  if (!teamId || !channelId || !payload.response_url) return;
  const sub = actionId === 'cfg_open_models' ? 'models' : 'agents';
  const ctx: SlashCtx = {
    teamId,
    channelId,
    slackUserId: payload.user?.id ?? '',
    command: '/kortix',
    responseUrl: payload.response_url,
    projectScopedProjectId: inboundProjectId(inbound),
  };
  // `agents` defers internally (git) and posts the real picker via responseUrl;
  // its sync return is a "Loading…" ack. `models` returns full blocks.
  const resp = await handleSlashCommand(sub, '', ctx);
  await respondViaUrl(payload.response_url, { ...resp, replace_original: true });
}

// "Switch agent" under an agent's answer: the channel's agent picker in a
// modal. The modal opens first, from the click's single-use `trigger_id`
// (Slack drops it after ~3 s), then shows the agents or why it cannot: a
// click always shows something. Its buttons are the `/kortix agents` picker's
// (`set_agent_*`), and their answer replaces the modal's content.
const SWITCH_AGENT_CALLBACK = 'switch_agent';

/** `channelId`: the conversation the modal configures, echoed back by Slack on every click in it. */
function switchAgentModal(channelId: string, blocks: unknown[]): Record<string, unknown> {
  return {
    type: 'modal',
    callback_id: SWITCH_AGENT_CALLBACK,
    private_metadata: channelId,
    title: { type: 'plain_text', text: 'Switch agent' },
    close: { type: 'plain_text', text: 'Done' },
    blocks,
  };
}

const modalText = (text: string) => [{ type: 'section', text: { type: 'mrkdwn', text } }];

/** The bot token of the Kortix workspace this click belongs to. */
async function clickToken(teamId: string, inbound: SlackInbound): Promise<string | null> {
  const projectId = inboundProjectId(inbound) ?? (await linkedSlackProject(teamId));
  return projectId ? loadSlackTokenForProject(projectId) : null;
}

async function handleAnswerSwitchAgent(payload: SlackInteractionPayload, inbound: SlackInbound): Promise<void> {
  const teamId = payload.team?.id ?? '';
  const action = payload.actions?.[0];
  // The conversation clicked in, as Slack signed it; the button's value only has to agree.
  const channelId = payload.channel?.id ?? '';
  const slackUserId = payload.user?.id ?? '';
  if (!teamId || !channelId || !payload.trigger_id || (action?.value && action.value !== channelId)) return;
  const token = await clickToken(teamId, inbound);
  if (!token) return;
  const viewId = (await openModal(token, payload.trigger_id, switchAgentModal(channelId, modalText('Loading agents…'))))?.viewId;
  if (!viewId) return;
  try {
    const selection = await currentChannelSelection({ teamId, channelId, projectId: inboundProjectId(inbound) ?? undefined });
    if (!selection) {
      await updateModal(token, viewId, switchAgentModal(channelId, modalText(NO_LINK_TEXT)));
      return;
    }
    const agents = await loadScopedChannelAgents({ teamId, projectId: selection.projectId, slackUserId });
    const where = slackChannelIsDm(channelId) ? 'this DM' : `<#${channelId}>`;
    const lead = modalText(
      `New threads in ${where} start with the agent you pick. A thread that already runs keeps its agent.`,
    );
    await updateModal(token, viewId, switchAgentModal(channelId, buildAgentPickerBlocks(channelId, selection.agentName, agents, lead)));
  } catch (err) {
    logger.warn('[slack] the agent picker did not load', { err: (err as Error)?.message });
    await updateModal(token, viewId, switchAgentModal(channelId, modalText("⚠️ This channel's agents did not load. Try again, or run `/kortix agents`.")));
  }
}

// Message shortcut ("Open in Kortix", callback_id `open_session`). Resolves the
// thread the message lives in to its Kortix session and replies (ephemerally)
// with a link. Unlike a slash command, a message shortcut DOES carry the
// message's thread_ts, so this can answer "which session is THIS thread".
export async function handleMessageShortcut(
  payload: SlackInteractionPayload,
  inbound: SlackInbound = CANONICAL_SLACK_INBOUND,
): Promise<void> {
  if (payload.callback_id !== 'open_session') return;
  const teamId = payload.team?.id ?? '';
  const messageTs = payload.message?.ts ?? '';
  const threadTs = payload.message?.thread_ts ?? messageTs;
  if (!teamId || !threadTs) {
    await respondViaUrl(payload.response_url, {
      response_type: 'ephemeral',
      text: "Couldn't read that message's thread.",
    });
    return;
  }

  const thread = await findSlackThread(inbound, teamId, threadTs);
  if (!thread) {
    await respondViaUrl(payload.response_url, {
      response_type: 'ephemeral',
      text: 'No Kortix session is attached to this thread yet. `@`-mention me to start one.',
    });
    return;
  }

  const url = sessionWebUrl(config.FRONTEND_URL, thread.projectId, thread.sessionId);
  await respondViaUrl(payload.response_url, {
    response_type: 'ephemeral',
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: '*This thread\'s Kortix session*' } },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Open session ↗', emoji: true },
            style: 'primary',
            url,
            action_id: 'session_open',
          },
        ],
      },
    ],
  });
}

// "Request access" (the ephemeral nudge for a connected-but-no-access user) →
// file a project access request and ping the account's admins. Replaces the
// ephemeral in place via the interaction's response_url so the user gets an
// immediate, only-visible-to-them confirmation.
async function handleRequestAccess(
  payload: SlackInteractionPayload,
  value: string,
  inbound: SlackInbound,
): Promise<void> {
  const teamId = payload.team?.id ?? '';
  const slackUserId = payload.user?.id ?? '';
  let projectId = '';
  try {
    projectId = (JSON.parse(value || '{}') as { projectId?: string }).projectId ?? '';
  } catch {
    projectId = '';
  }
  if (!teamId || !slackUserId || !projectId) return;
  if (!inboundAllowsProject(inbound, projectId)) {
    await respondViaUrl(payload.response_url, { replace_original: true, text: OTHER_PROJECT_NOTICE });
    return;
  }

  const result = await createChatAccessRequest(chatUser('slack', teamId, slackUserId), projectId);
  const message =
    result.status === 'created'
      ? "Access requested ✓ — an admin will review it. Once you're approved, mention me again and I'll get on it."
      : result.status === 'pending'
        ? "You've already requested access — it's pending an admin's review."
        : result.status === 'already-member'
          ? 'You already have access — mention me again and I’ll get on it.'
          : result.status === 'no-project'
            ? 'That Kortix workspace isn’t connected to this Slack workspace.'
            : 'I couldn’t request access — connect your Kortix account first, then try again.';
  await respondViaUrl(payload.response_url, { replace_original: true, text: message });

  if (result.status === 'created') {
    await notifyAdminsOfAccessRequest({
      teamId,
      projectId,
      accountId: result.accountId,
      requesterUserId: result.requesterUserId,
      requesterSlackUserId: slackUserId,
    });
  }
}

async function handleThreadJoinDecision(
  payload: SlackInteractionPayload,
  value: string,
  decision: 'approved' | 'denied',
  inbound: SlackInbound,
): Promise<void> {
  const teamId = payload.team?.id ?? '';
  const channelId = payload.channel?.id ?? '';
  const deciderSlackUserId = payload.user?.id ?? '';
  // Only the thread and the requester's Slack id are read from the value; the
  // session comes from the thread mapping and the requester's Kortix account
  // from the pending request (decideSlackThreadJoin).
  let parsed: { threadId?: string; requesterSlackUserId?: string } = {};
  try {
    parsed = JSON.parse(value || '{}') as typeof parsed;
  } catch {
    parsed = {};
  }
  if (!teamId || !channelId || !deciderSlackUserId || !parsed.threadId || !parsed.requesterSlackUserId) {
    await respondViaUrl(payload.response_url, {
      response_type: 'ephemeral',
      text: 'I could not read that approval request. Ask the person to request access again.',
    });
    return;
  }

  // A per-project app finds only its own project's threads.
  const thread = await findSlackThread(inbound, teamId, parsed.threadId);
  const result = thread
    ? await decideSlackThreadJoin({
        teamId,
        channelId,
        deciderSlackUserId,
        sessionId: thread.sessionId,
        threadId: parsed.threadId,
        requesterSlackUserId: parsed.requesterSlackUserId,
        decision,
      })
    : { ok: false as const, text: 'This request is no longer open.' };
  await respondViaUrl(payload.response_url, {
    response_type: 'ephemeral',
    replace_original: true,
    text: result.text,
  });
}

function loginActionValue(action: NonNullable<SlackInteractionPayload['actions']>[number]): {
  pendingId?: string;
  url?: string;
} {
  try {
    const parsed = JSON.parse(action.value || '{}') as { pendingId?: string; url?: string };
    return {
      ...(typeof parsed.pendingId === 'string' && parsed.pendingId ? { pendingId: parsed.pendingId } : {}),
      ...(typeof parsed.url === 'string' && parsed.url ? { url: parsed.url } : {}),
    };
  } catch {
    // Fall back to parsing the URL below for prompts generated before the
    // first-button action flow existed.
  }
  const token = action.url?.split('/identity/login/')[1]?.split(/[?#]/)[0]
    ?? action.url?.split('/slack/login/')[1]?.split(/[?#]/)[0];
  return {
    ...(token ? { pendingId: verifyLoginState(token)?.pendingId } : {}),
    ...(action.url ? { url: action.url } : {}),
  };
}

async function handleSlackLoginConnect(
  payload: SlackInteractionPayload,
  action: NonNullable<SlackInteractionPayload['actions']>[number],
): Promise<void> {
  const parsed = loginActionValue(action);
  const teamId = payload.team?.id ?? '';
  const slackUserId = payload.user?.id ?? '';
  // The link is built here, for the person who clicked. A button value is not
  // proof: an agent can post a look-alike "Connect" button through the same
  // bot, and Kortix would then present its URL as its own sign-in page.
  const login = {
    pendingId: parsed.pendingId,
    url: teamId && slackUserId
      ? buildSlackLoginUrl({ teamId, slackUserId, ...(parsed.pendingId ? { pendingId: parsed.pendingId } : {}) })
      : undefined,
  };
  await attachPendingSlackAuthResponseUrl({
    pendingId: login.pendingId,
    teamId,
    slackUserId,
    responseUrl: payload.response_url,
  });
  await respondViaUrl(payload.response_url, {
    response_type: 'ephemeral',
    replace_original: true,
    text: 'Opening Kortix to connect your account...',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: login.url
            ? `*Open Kortix to connect your account.*\n<${login.url}|Continue in Kortix>. This message will update when the connection is complete.`
            : '*Open Kortix to connect your account.*\nRun `/kortix login` if this button expired.',
        },
      },
      ...(login.url
        ? [{
          type: 'actions',
          elements: [{
            type: 'button',
            text: { type: 'plain_text', text: 'Open Kortix', emoji: true },
            style: 'primary',
            url: login.url,
            action_id: 'slack_login_open',
          }],
        }]
        : []),
    ],
  });
}

/** Does `sessionId` belong to a project `inbound` may act on? */
async function sessionInScope(inbound: SlackInbound, sessionId: string): Promise<boolean> {
  if (inbound.kind === 'canonical') return true;
  const [row] = await db
    .select({ projectId: projectSessions.projectId })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  return inboundAllowsProject(inbound, row?.projectId);
}

/**
 * Stop the run behind the live plan message.
 *
 * The button carries its session id in `value`; nothing about the payload
 * names a turn. `stopSlackTurn` decides whether this person may end it and
 * settles the message, so the reply here is only what the presser is told —
 * ephemeral, because a refusal is nobody else's business.
 */
async function handleStop(
  payload: SlackInteractionPayload,
  action: { value?: string },
  inbound: SlackInbound,
): Promise<void> {
  const sessionId = (action.value ?? '').trim();
  const responseUrl = payload.response_url;
  if (!responseUrl) return;
  if (!sessionId || !(await sessionInScope(inbound, sessionId))) {
    await respondViaUrl(responseUrl, { response_type: 'ephemeral', text: 'That run is no longer available.' });
    return;
  }
  const slackUserId = payload.user?.id ?? '';
  const outcome = await stopSlackTurn({
    sessionId,
    slackUserId,
    // `<@U…>` renders as the member's display name in the thread, and it is
    // the only identity the interaction payload carries here.
    byName: slackUserId ? `<@${slackUserId}>` : undefined,
  });
  await respondViaUrl(responseUrl, {
    response_type: 'ephemeral',
    text: outcome.stopped
      ? outcome.stoppedRuntime
        ? 'Stopped. The agent is no longer working on this.'
        : // The ledger is closed either way; do not claim a reach we did not
          // have. A parked or already-finished sandbox is the usual case.
          'Stopped. The run was already closing on its own.'
      : outcome.notice,
  });
}

/**
 * The "Request changes" modal came back.
 *
 * This is a SEPARATE signed request from the button press, so nothing is
 * carried over: the item is re-resolved and the actor re-authorized here, at
 * the same bar the button path applies. `private_metadata` is Slack echoing
 * back what we wrote — it names the item, it does not vouch for anyone.
 */
export async function handleViewSubmission(
  payload: SlackInteractionPayload,
  inbound: SlackInbound = CANONICAL_SLACK_INBOUND,
): Promise<void> {
  if (payload.view?.callback_id === APPROVAL_REPLY_CALLBACK) {
    await handleApprovalReplySubmission(payload, inbound);
    return;
  }
  if (payload.view?.callback_id !== REVIEW_FEEDBACK_CALLBACK) return;
  const meta = decodeReviewMetadata(payload.view?.private_metadata);
  const slackUserId = payload.user?.id ?? '';
  if (!meta || !slackUserId) return;
  // `private_metadata` is the request body too: a per-project app may name only
  // its own project and workspace in it.
  if (!inboundAllowsProject(inbound, meta.projectId) || !inboundAllowsTeam(inbound, meta.teamId)) return;

  const notify = async (text: string) => {
    if (meta.responseUrl) await respondViaUrl(meta.responseUrl, { response_type: 'ephemeral', text });
  };

  // A modal opened before the Slack link moved decides nothing afterwards.
  if (!(await holdsSlackWorkspace(meta.projectId, meta.teamId))) {
    await notify('That review belongs to a Kortix workspace that is no longer connected to this Slack workspace.');
    return;
  }
  const item = await getReviewItemById(meta.reviewItemId, meta.projectId);
  if (!item) {
    await notify('That review item is no longer available.');
    return;
  }

  const actor = await resolveSlackActor(chatUser('slack', meta.teamId, slackUserId), { projectId: meta.projectId, accountId: item.accountId }, PROJECT_ACTIONS.PROJECT_REVIEW_ACT);
  if ('reason' in actor) {
    await notify(
      actor.reason === 'unlinked'
        ? 'Connect your Kortix account first (`/kortix login`) to act on reviews.'
        : "You don't have access to act on this Kortix workspace's reviews.",
    );
    return;
  }

  const feedback = readReviewFeedback(payload.view ?? {});
  const decided = await applyVerdict(meta.reviewItemId, meta.projectId, {
    verdict: 'changes',
    feedback,
    actingUserId: actor.userId,
  });
  if (decided === null) {
    await notify(`*${escapeMrkdwn(item.title)}* was already decided.`);
    return;
  }

  await notify(
    feedback
      ? `Changes requested on *${escapeMrkdwn(item.title)}* — your note went to the agent.`
      : `Changes requested on *${escapeMrkdwn(item.title)}*.`,
  );

  // Only tell the agent to go asking when there is nothing to read.
  const decisionLine = feedback
    ? `Changes were requested on the review "${item.title}".\n\nReviewer's feedback:\n${feedback}`
    : `Changes were requested on the review "${item.title}". Ask what to change, then revise.`;
  // Resume the agent exactly as the button path does — same synthetic
  // in-thread message, same spawnAgentTurn, which re-checks the clicker's
  // access from event.user so this cannot run as anyone but them.
  const event: SlackEvent = {
    type: 'message',
    user: slackUserId,
    channel: meta.channelId,
    text: [decisionLine, '', 'Continue the turn based on this decision.'].join('\n'),
    ts: meta.messageTs,
    thread_ts: meta.threadTs,
    team: meta.teamId,
  };
  const envelope: SlackEnvelope = { type: 'event_callback', team_id: meta.teamId, event };
  await spawnAgentTurn(meta.projectId, envelope, event, { ...turnScope(inbound), authorizedResume: true });
}

export async function handleBlockAction(
  payload: SlackInteractionPayload,
  inbound: SlackInbound = CANONICAL_SLACK_INBOUND,
): Promise<void> {
  const action = payload.actions?.[0];
  if (!action?.action_id) return;

  if (action.action_id === SLACK_STOP_ACTION) {
    await handleStop(payload, action, inbound);
    return;
  }

  if (action.action_id.startsWith('qa_')) {
    await handleQuestionAnswer(payload, action, inbound);
    return;
  }

  // A gated connector call's card (`approval_<verb>_<executionId>`).
  if (action.action_id.startsWith('approval_')) {
    const parsed = parseApprovalActionId(action.action_id);
    if (parsed) await handleApprovalCardAction(payload, parsed, inbound);
    return;
  }

  // A Review Center card button (`review_<verb>_<id>`). Apply the verdict + resume.
  if (action.action_id.startsWith('review_')) {
    const parsed = parseReviewActionId(action.action_id);
    if (parsed) await handleReviewAction(payload, parsed, inbound);
    return;
  }

  if (action.action_id.startsWith('set_agent')) {
    await handleSetSelection(payload, action.value ?? '', 'agent', inbound);
    return;
  }

  if (action.action_id.startsWith('set_model')) {
    // A button carries its pick in `value`; the long list's select in `selected_option`.
    await handleSetSelection(payload, action.selected_option?.value ?? action.value ?? '', 'model', inbound);
    return;
  }

  // "Switch agent" under an answer: the channel's agent picker, for the clicker only.
  if (action.action_id === SLACK_SWITCH_AGENT_ACTION) {
    await handleAnswerSwitchAgent(payload, inbound);
    return;
  }

  // `/kortix` panel "Change …" buttons re-render the focused picker in place.
  if (
    action.action_id === 'cfg_open_models' ||
    action.action_id === 'cfg_open_agents'
  ) {
    await handleConfigOpen(payload, action.action_id, inbound);
    return;
  }

  // URL buttons (open a link) — swallow so they don't fall to the agent-click
  // catch-all and get echoed back into a thread.
  if (
    action.action_id.startsWith('panel_open_') ||
    action.action_id.startsWith('whoami_open_') ||
    action.action_id.startsWith('whoami_repo_')
  ) {
    return;
  }

  // A plain "Open session ↗" link button carries a `url` and needs no handling.
  if (action.action_id === 'session_open') return;

  // Identity / access nudges. "Connect" and "Review in Kortix" are URL buttons —
  // they open a link, so swallow their block_action so it doesn't fall through to
  // the agent-click catch-all below. "Request access" does real work.
  if (action.action_id === 'slack_login_connect') {
    await handleSlackLoginConnect(payload, action);
    return;
  }
  if (action.action_id === 'slack_open_access_review') {
    return;
  }
  if (action.action_id === 'slack_request_access') {
    await handleRequestAccess(payload, action.value ?? '', inbound);
    return;
  }

  if (action.action_id === 'slack_thread_join_approve') {
    await handleThreadJoinDecision(payload, action.value ?? '', 'approved', inbound);
    return;
  }
  if (action.action_id === 'slack_thread_join_deny') {
    await handleThreadJoinDecision(payload, action.value ?? '', 'denied', inbound);
    return;
  }

  // The workspace picker and "Switch workspace" of the per-channel model. Their
  // messages stay in Slack; a click on one answers instead of reaching the
  // agent: every channel now runs in the Slack workspace's linked one.
  if (action.action_id.startsWith('pick_project') || action.action_id.startsWith('switch_project_')) {
    await respondViaUrl(payload.response_url, {
      response_type: 'ephemeral',
      text: 'This Slack workspace now runs in one Kortix workspace, so there is nothing to pick. Mention me with a task.',
    });
    return;
  }

  // Anything else is an agent-emitted button (typically inside a carousel card
  // or actions block from `slack send --blocks-file ...`). Route the click back
  // into the thread as a synthesized follow-up so the agent can continue.
  await handleAgentClick(payload, action, inbound);
}
