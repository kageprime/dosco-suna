/**
 * Join the workspace's Slack bot to channels by name or id: `kortix channels
 * join #a #b` and `kortix onboard --channels`. Slack lets a bot join a public
 * channel itself; a private channel needs a person to `/invite` the bot, so it
 * is reported as `needs_invite`, never forced.
 */
import { joinPublicChannel, listBotChannels } from '../slack-api';
import { loadSlackInstall, loadSlackTokenForProject } from './installs';

export type SlackJoinStatus = 'joined' | 'already_member' | 'needs_invite' | 'not_found' | 'error';

export interface SlackJoinResult {
  channel: string;
  id: string | null;
  status: SlackJoinStatus;
  error?: string;
}

export interface SlackJoinResponse {
  connected: boolean;
  team: string | null;
  bot_user_id: string | null;
  results: SlackJoinResult[];
}

const CHANNEL_ID = /^[CG][A-Z0-9]{6,}$/;

/** `#General` → `general`; a channel id stays as it is. */
export function normalizeChannelRef(raw: string): string {
  const trimmed = raw.trim().replace(/^#/, '');
  return CHANNEL_ID.test(trimmed) ? trimmed : trimmed.toLowerCase();
}

export async function joinSlackChannels(projectId: string, channels: string[]): Promise<SlackJoinResponse> {
  const install = await loadSlackInstall(projectId);
  const token = install ? await loadSlackTokenForProject(projectId) : null;
  if (!install || !token) return { connected: false, team: null, bot_user_id: null, results: [] };
  const base = { connected: true, team: install.workspaceName, bot_user_id: install.botUserId };
  const listed = await listBotChannels(token);
  if ('error' in listed) {
    return { ...base, results: channels.map((channel) => ({ channel, id: null, status: 'error' as const, error: listed.error })) };
  }
  const results: SlackJoinResult[] = [];
  for (const raw of channels) {
    const ref = normalizeChannelRef(raw);
    const row = listed.find((c) => c.id === ref || c.name === ref);
    if (!row) {
      // A bot sees a private channel only after a person invites it.
      const isId = CHANNEL_ID.test(ref);
      results.push({ channel: raw, id: isId ? ref : null, status: isId ? 'needs_invite' : 'not_found' });
    } else if (row.is_member) {
      results.push({ channel: raw, id: row.id, status: 'already_member' });
    } else if (row.is_private) {
      results.push({ channel: raw, id: row.id, status: 'needs_invite' });
    } else {
      const joined = await joinPublicChannel(token, row.id);
      results.push(joined.ok ? { channel: raw, id: row.id, status: 'joined' } : { channel: raw, id: row.id, status: 'error', error: joined.error });
    }
  }
  return { ...base, results };
}
