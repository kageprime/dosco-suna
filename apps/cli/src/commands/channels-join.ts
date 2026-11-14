/**
 * `kortix channels join <channel...>` — the workspace's Slack bot joins
 * public channels itself; a private channel needs a person to `/invite` it.
 * Mirrors apps/api `POST /workspaces/:id/channels/slack/join`.
 */
import { type ApiClient, ApiError } from '../api/client.ts';
import { emitJson, resolveProjectContext, surfaceApiError } from '../command-helpers.ts';
import { C, status } from '../style.ts';

export type SlackJoinStatus = 'joined' | 'already_member' | 'needs_invite' | 'not_found' | 'error';

export interface SlackJoinResponse {
  connected: boolean;
  team: string | null;
  bot_user_id: string | null;
  results: Array<{ channel: string; id: string | null; status: SlackJoinStatus; error?: string }>;
}

/** `#a,#b c` → [`a`, `b`, `c`]: a leading `#` is optional (quote it in a shell). */
export function channelList(values: string[]): string[] {
  return values.flatMap((value) => value.split(',')).map((name) => name.trim().replace(/^#/, '')).filter(Boolean);
}

/** Null when this host has no join route (an API older than this CLI). */
export async function joinSlackChannels(client: ApiClient, projectId: string, channels: string[]): Promise<SlackJoinResponse | null> {
  try {
    return await client.post<SlackJoinResponse>(`/workspaces/${projectId}/channels/slack/join`, { channels });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/** The one thing a person does for a channel the bot could not join. */
export function inviteLine(result: SlackJoinResponse['results'][number]): string {
  return result.status === 'not_found'
    ? `#${result.channel.replace(/^#/, '')} is private or does not exist: in Slack, open it and run /invite @Kortix`
    : `#${result.channel.replace(/^#/, '')} is private: in Slack, open it and run /invite @Kortix`;
}

export async function channelsJoin(ctxOpts: { projectArg?: string; hostArg?: string }, positional: string[], json: boolean): Promise<number> {
  const channels = channelList(positional);
  if (channels.length === 0) {
    process.stderr.write(`${status.err('Name at least one channel: kortix channels join general "#eng"')}\n`);
    return 2;
  }
  const ctx = await resolveProjectContext(ctxOpts);
  if (!ctx) return 1;
  let resp: SlackJoinResponse | null;
  try {
    resp = await joinSlackChannels(ctx.client, ctx.projectId, channels);
  } catch (err) {
    return surfaceApiError(err);
  }
  if (!resp) {
    process.stderr.write(`${status.err('No such workspace, or this Kortix host has no channel join route yet. Invite the bot by hand: /invite @Kortix')}\n`);
    return 1;
  }
  if (json) {
    emitJson(resp);
  } else if (!resp.connected) {
    process.stderr.write(`${status.err('Slack is not connected to this workspace.')} Run ${C.cyan}kortix channels connect${C.reset} first.\n`);
  } else {
    for (const r of resp.results) {
      if (r.status === 'joined') process.stdout.write(`${status.ok(`joined #${r.channel}`)}\n`);
      else if (r.status === 'already_member') process.stdout.write(`${status.ok(`already in #${r.channel}`)}\n`);
      else if (r.status === 'error') process.stdout.write(`${status.err(`#${r.channel}: ${r.error ?? 'Slack refused the join'}`)}\n`);
      else process.stdout.write(`${status.warn(inviteLine(r))}\n`);
    }
  }
  if (!resp.connected) return 1;
  return resp.results.every((r) => r.status === 'joined' || r.status === 'already_member') ? 0 : 4;
}
