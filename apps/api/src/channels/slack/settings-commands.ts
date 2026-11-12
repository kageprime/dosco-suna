import { and, eq } from 'drizzle-orm';
import { chatChannelBindings } from '@kortix/db';
import { db } from '../../shared/db';
import { config } from '../../config';
import { lookupEmailsByUserIds } from '../../accounts/core/app';
import { labelForModelRef } from '../../llm-gateway/models/picker';
import { resolveEffectiveModel } from '../../llm-gateway/resolution/default-model';
import { chooseEffectiveAgent } from '../../llm-gateway/resolution/effective';
import { lookupChatIdentity } from '../core/identity';
import { changeChannelAgent, changeChannelPolicy } from '../core/settings';
import { applySlackModelChoice, buildSlackModelsResponse } from './model-choice';
import { linkedSlackProject } from './link';
import { settingsRefusalText, slackSettingsChannel, slackUserOf, slashChannel } from './settings-text';
import { buildAgentPickerBlocks, loadScopedChannelAgents } from './agent-picker';
import { channelModelContext } from './model-gate';
import { conversationPolicyLabel, normalizeConversationPolicy } from './participants';
import { currentChannelSelection } from './selection';
import { dashboardBase, escapeMrkdwn, respondViaUrl } from './util';
import { SLACK_PREVIEW_WAIT_MS, isKortixHostedRepo, repoDisplayLabel, repoPreviewImages } from '../repo-preview';
import type { SlashCtx, SlashResponse } from './types';
import { projectsView } from '../../workspaces/rows';

// The Slack rendering of channel settings: the `/kortix` panel, the project,
// agent and model pickers, and the setters behind `/kortix switch|unbind|agent|
// model|policy` and their buttons. What may change, and who may change it,
// lives in core/settings.ts.

const ephemeral = (text: string): SlashResponse => ({ response_type: 'ephemeral', text });

/** The answer when this Slack workspace runs in no Kortix workspace. */
export const NO_LINK_TEXT = 'No Kortix workspace is connected to this Slack workspace. Add Kortix to Slack from a Kortix workspace: Customize → Connectors → Slack.';

/** The reply for an agent change, shared by `/kortix agent` and the agent picker buttons. */
export function agentChangeText(
  result: Awaited<ReturnType<typeof changeChannelAgent>>,
  requested: string,
  command: string,
  noBinding: string,
): string {
  if (result.ok) {
    return result.agent
      ? `Agent for this channel set to *${escapeMrkdwn(result.agent)}*. New sessions will use it.`
      : 'Agent reset to the workspace default.';
  }
  if (result.reason === 'unknown_agent') {
    return `"${escapeMrkdwn(requested)}" is not a declared agent in this Kortix workspace's manifest. Run \`${command} agents\` to pick one.`;
  }
  return settingsRefusalText(result.reason, command, noBinding);
}

// ── Projects ─────────────────────────────────────────────────────────────────


/** The repository line: a link people can open, or "Hosted by Kortix" for a private Kortix-hosted repo. */
function repoLine(repoUrl: string): string {
  const label = escapeMrkdwn(repoDisplayLabel(repoUrl) ?? '');
  return isKortixHostedRepo(repoUrl) ? `_${label}_` : `_<${repoUrl}|${label}>_`;
}

/**
 * `/kortix workspaces`, `switch`, `use`, `unbind`: one Slack workspace runs in
 * one Kortix workspace (slack/link.ts), so there is nothing to pick per
 * channel. The answer names the Kortix workspace and how to move the link.
 */
export async function slashLinkInfo(ctx: SlashCtx): Promise<SlashResponse> {
  const projectId = await linkedSlackProject(ctx.teamId);
  const [p] = projectId
    ? await db.select({ name: projectsView.name }).from(projectsView).where(eq(projectsView.projectId, projectId)).limit(1)
    : [];
  const text = p
    ? `This Slack workspace runs in the Kortix workspace *${escapeMrkdwn(p.name)}*: every channel and DM here. ` +
      `Choose a channel's agent with \`${ctx.command} agents\`.\n` +
      'To move Slack to another Kortix workspace, add Kortix to Slack from that workspace (Customize → Connectors → Slack). The connection moves there.'
    : NO_LINK_TEXT;
  return { response_type: 'ephemeral', blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
}

// ── Panel ────────────────────────────────────────────────────────────────────

// A context line stating whether the caller has linked their own Kortix account.
async function buildIdentityContext(ctx: SlashCtx): Promise<Record<string, unknown>> {
  const identity = ctx.slackUserId ? await lookupChatIdentity(slackUserOf(ctx)) : null;
  if (!identity) {
    return {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `🔌  Not connected — run \`${ctx.command} login\` to run as your own Kortix account.` }],
    };
  }
  const email = (await lookupEmailsByUserIds([identity.userId])).get(identity.userId);
  return {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `🔗  Connected as *${email ? escapeMrkdwn(email) : 'your Kortix account'}*` }],
  };
}

// Honest source label for an effective model/agent: how the value was decided,
// so the panel reads "Sonnet 4.6 · project default" instead of implying a pin.
function sourceLabel(source: string): string {
  switch (source) {
    case 'explicit':
      return 'channel override';
    case 'agent':
      return 'agent default';
    case 'project':
      return 'workspace default';
    case 'account':
      return 'account default';
    default:
      return 'platform default';
  }
}

// The single `/kortix` channel control panel. Consolidates project binding +
// agent + model + join policy + account + sessions into one interactive card,
// each row showing the EFFECTIVE value and where it came from. Inline buttons
// open the focused pickers (real-catalog models, live agents, projects). DB-only
// (no git) so it answers inside Slack's 3s window; the agent picker, opened on
// demand, is the only git-touching path.
export async function slashPanel(ctx: SlashCtx): Promise<SlashResponse> {
  const identityBlocks = config.SLACK_REQUIRE_USER_IDENTITY ? [await buildIdentityContext(ctx)] : [];
  const selection = await currentChannelSelection(slashChannel(ctx));
  const currentId = selection?.projectId ?? null;
  const [p] = currentId
    ? await db
        .select({ projectId: projectsView.projectId, name: projectsView.name, repoUrl: projectsView.repoUrl, metadata: projectsView.metadata })
        .from(projectsView)
        .where(eq(projectsView.projectId, currentId))
        .limit(1)
    : [];
  if (!p) {
    const info = await slashLinkInfo(ctx);
    return { ...info, blocks: [...identityBlocks, ...(info.blocks ?? [])] };
  }
  const og = (await repoPreviewImages([p.repoUrl], { waitMs: SLACK_PREVIEW_WAIT_MS })).get(p.repoUrl);

  // Effective AGENT (channel override → project default → 'default').
  const projectDefaultAgent =
    typeof (p.metadata as Record<string, unknown> | null)?.default_agent === 'string'
      ? ((p.metadata as Record<string, unknown>).default_agent as string)
      : null;
  const agent = chooseEffectiveAgent({ explicit: selection?.agentName ?? null, projectDefault: projectDefaultAgent });

  // Effective MODEL (channel override → project/account/platform), with source.
  const gate = await channelModelContext(slashChannel(ctx));
  let modelText = '`not configured` · platform default';
  if (gate) {
    const eff = await resolveEffectiveModel({
      userId: gate.ownerUserId,
      accountId: gate.accountId,
      projectId: gate.projectId,
      agentName: selection?.agentName ?? null,
      explicit: selection?.sessionModel ?? null,
      freeModelsOnly: gate.freeManagedOnly,
    });
    const label = eff.model ? labelForModelRef(eff.model) : 'No model configured';
    modelText = `*${escapeMrkdwn(label)}* · ${sourceLabel(eff.source)}`;
  }

  const policy = normalizeConversationPolicy(selection?.conversationPolicy);
  const section: Record<string, unknown> = {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `🟢  *${escapeMrkdwn(p.name)}*  ·  this Slack workspace runs here\n${repoLine(p.repoUrl)}`,
    },
  };
  if (og) section.accessory = { type: 'image', image_url: og, alt_text: `${p.name} repo` };
  return {
    response_type: 'ephemeral',
    blocks: [
      ...identityBlocks,
      section,
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `🤖  Agent: *${escapeMrkdwn(agent.agent)}* · ${sourceLabel(agent.source)}` },
          { type: 'mrkdwn', text: `🧠  Model: ${modelText}` },
          { type: 'mrkdwn', text: `🔒  Slack sessions: *${conversationPolicyLabel(policy)}*` },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Change model', emoji: true },
            action_id: 'cfg_open_models',
            value: JSON.stringify({ c: ctx.channelId }),
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Change agent', emoji: true },
            action_id: 'cfg_open_agents',
            value: JSON.stringify({ c: ctx.channelId }),
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Open in Kortix ↗', emoji: true },
            style: 'primary',
            url: `${dashboardBase(config.FRONTEND_URL)}/workspaces/${p.projectId}`,
            action_id: `panel_open_${p.projectId}`,
          },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Advanced: \`${ctx.command} model <id>\` · \`${ctx.command} policy\` · \`${ctx.command} sessions\` · \`${ctx.command} help\``,
          },
        ],
      },
    ],
  };
}

// ── Policy ───────────────────────────────────────────────────────────────────

export async function slashPolicy(ctx: SlashCtx, arg: string): Promise<SlashResponse> {
  const selection = await currentChannelSelection(slashChannel(ctx));
  if (!selection) {
    return {
      response_type: 'ephemeral',
      blocks: (await slashLinkInfo(ctx)).blocks,
    };
  }

  const requested = arg.trim();
  const current = normalizeConversationPolicy(selection.conversationPolicy);
  if (!requested) {
    return {
      response_type: 'ephemeral',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Slack session policy: ${conversationPolicyLabel(current)}*\nNew Slack sessions in this channel use this policy.`,
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `Default is \`project_open\`: linked workspace members can join Slack-started sessions. Use \`owner_approval\` for private threads with owner approval, or \`owner_only\` to block everyone else.`,
            },
          ],
        },
      ],
    };
  }

  const next = normalizeConversationPolicy(requested);
  if (next !== requested) {
    return ephemeral(`Unknown policy \`${requested}\`. Use \`owner_approval\`, \`owner_only\`, or \`project_open\`.`);
  }
  const result = await changeChannelPolicy(slackUserOf(ctx), slackSettingsChannel(ctx), next);
  if (!result.ok) {
    return ephemeral(settingsRefusalText(result.reason, ctx.command, 'That channel is no longer bound to a Kortix workspace.'));
  }
  return ephemeral(
    `Slack session policy set to ${conversationPolicyLabel(next)} for this channel. Existing threads keep their original policy.`,
  );
}

// ── Agents ───────────────────────────────────────────────────────────────────

export async function slashAgents(ctx: SlashCtx, arg: string): Promise<SlashResponse> {
  // `/kortix agents <name>` is a convenient alias for setting the agent.
  if (arg.trim()) return slashSetAgent(ctx, arg);

  const selection = await currentChannelSelection(slashChannel(ctx));
  if (!selection) {
    return {
      response_type: 'ephemeral',
      blocks: (await slashLinkInfo(ctx)).blocks,
    };
  }
  // Listing agents touches git — too slow for the synchronous 3s window. Ack
  // immediately and post the real picker out-of-band: to the response_url for a
  // real slash command, or straight into the DM for the message-fallback path.
  void (async () => {
    const agents = await loadScopedChannelAgents({
      teamId: ctx.teamId,
      projectId: selection.projectId,
      slackUserId: ctx.slackUserId,
    });
    const blocks = buildAgentPickerBlocks(ctx.channelId, selection.agentName, agents);
    if (ctx.deferredDeliver) {
      await ctx.deferredDeliver({ response_type: 'ephemeral', blocks });
    } else {
      await respondViaUrl(ctx.responseUrl, { response_type: 'ephemeral', replace_original: true, blocks });
    }
  })();
  return ephemeral('Loading agents…');
}

export async function slashSetAgent(ctx: SlashCtx, arg: string): Promise<SlashResponse> {
  const name = arg.trim();
  if (!name) {
    return ephemeral(`Usage: \`${ctx.command} agent <name>\` (or \`${ctx.command} agents\` to pick).`);
  }
  const result = await changeChannelAgent(slackUserOf(ctx), slackSettingsChannel(ctx), name);
  return ephemeral(agentChangeText(result, name, ctx.command, NO_LINK_TEXT));
}

// ── Models ───────────────────────────────────────────────────────────────────

export function slashModels(ctx: SlashCtx): Promise<SlashResponse> {
  return buildSlackModelsResponse(ctx);
}

export async function slashSetModel(ctx: SlashCtx, arg: string): Promise<SlashResponse> {
  if (!arg.trim()) return slashModels(ctx);
  return ephemeral(await applySlackModelChoice(ctx, arg));
}

export async function currentChannelProjectId(ctx: { teamId: string; channelId: string }): Promise<string | null> {
  if (!ctx.channelId) return null;
  const [binding] = await db
    .select({ projectId: chatChannelBindings.projectId })
    .from(chatChannelBindings)
    .where(and(
      eq(chatChannelBindings.platform, 'slack'),
      eq(chatChannelBindings.platformTeamId, ctx.teamId),
      eq(chatChannelBindings.channelId, ctx.channelId),
    ))
    .limit(1);
  return binding?.projectId ?? null;
}
