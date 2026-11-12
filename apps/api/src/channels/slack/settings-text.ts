import { config } from '../../config';
import { type ChatUser, chatUser } from '../core/identity';
import { slackChannelIsDm } from './util';
import type { SettingsChannel, SettingsRefusal } from '../core/settings';
import type { ChannelCtx } from './selection';

// The Slack side of channel settings that every setter shares: who is asking,
// which channel it is, and the wording of a refusal (core/settings.ts decides
// it). teams/settings-text.ts is the Teams twin.

export function slackUserOf(ctx: { teamId: string; slackUserId: string }): ChatUser {
  return chatUser('slack', ctx.teamId, ctx.slackUserId);
}

/** A Slack channel for settings. DM channel ids start with `D`. */
/**
 * A slash command's channel, as the settings read it: with the Kortix
 * workspace whose own Slack app received the command, so that workspace reads
 * its own settings, not the shared app's linked one.
 */
export function slashChannel(ctx: { teamId: string; channelId: string; projectScopedProjectId?: string }): ChannelCtx {
  return { teamId: ctx.teamId, channelId: ctx.channelId, ...(ctx.projectScopedProjectId ? { projectId: ctx.projectScopedProjectId } : {}) };
}

/** `projectScopedProjectId`: the Kortix workspace whose own Slack app received the request. */
export function slackSettingsChannel(ctx: { teamId: string; channelId: string; projectScopedProjectId?: string }): SettingsChannel {
  return {
    teamId: ctx.teamId,
    channelId: ctx.channelId,
    oneToOne: slackChannelIsDm(ctx.channelId),
    ...(ctx.projectScopedProjectId ? { projectId: ctx.projectScopedProjectId } : {}),
  };
}

/**
 * The reply for a refused settings change. `noBinding` is the surface's own
 * "bind a project first" text.
 */
export function settingsRefusalText(reason: SettingsRefusal, command: string, noBinding: string): string {
  switch (reason) {
    case 'unlinked':
      return config.SLACK_REQUIRE_USER_IDENTITY
        ? `Connect your Kortix account first: \`${command} login\`. Channel settings change only for a linked workspace manager.`
        : "Change this channel's settings in Kortix: Slack account linking is off on this server.";
    case 'forbidden':
      return "Only a workspace manager, or a workspace owner or admin, can change this channel's settings.";
    case 'no_binding':
      return noBinding;
    case 'other_workspace':
      return "This channel's settings belong to another Kortix workspace that runs its own Slack app here. Change them from that workspace's app.";
  }
}
