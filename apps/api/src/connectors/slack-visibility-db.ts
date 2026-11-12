import { createHash } from 'node:crypto';
import type { SlackReadDeps, SlackView } from './slack-visibility';

// The channel modules load on first use: the gateway imports this module, and
// a connector call that never reads Slack should not pull the Slack app in.
const channels = async () => ({
  ...(await import('../channels/install-store')),
  ...(await import('../channels/slack-api')),
  ...(await import('../channels/slack/auto-link')),
  ...(await import('../channels/slack/link')),
});

/**
 * The database and Slack behind `gateSlackRead`. Memberships are read from
 * Slack (`users.conversations`), the source of truth for who is in what, and
 * kept for a minute: a person added to a channel reads it within a minute.
 */
const TTL_MS = 60_000;
const MAX_ENTRIES = 500;

// replica-local: a one-minute cache of Slack memberships; every replica asks Slack itself.
const cache = new Map<string, { at: number; value: unknown }>();

async function cached<T>(key: string, load: () => Promise<T | null>): Promise<T | null> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;
  const value = await load();
  // A failed read is not kept: the next call asks Slack again.
  if (value === null) return null;
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: Date.now(), value });
  return value;
}

export const dbSlackReadDeps: SlackReadDeps = {
  link: async (projectId) => (await channels()).slackProjectLink(projectId),

  async view(projectId, teamId, userId): Promise<SlackView | 'no_slack' | null> {
    const { loadSlackTokenForProject, slackMemberships, slackPersonForKortixUser } = await channels();
    const token = await loadSlackTokenForProject(projectId);
    if (!token) return 'no_slack';
    // Keyed by the token that answered: two Slack apps in one Slack workspace
    // see different conversations, and one Kortix workspace can replace the
    // shared app with its own (or back) under the same secret.
    const app = createHash('sha256').update(token).digest('hex').slice(0, 16);
    const bot = await cached(`bot:${projectId}:${teamId}:${app}`, () => slackMemberships(token, 'private_channel,mpim,im'));
    if (!bot) return null;
    const person = userId ? await slackPersonForKortixUser({ teamId, userId, token, projectId }).catch(() => null) : null;
    const allowed = new Set<string>(bot.filter((c) => c.isIm && person && c.user === person).map((c) => c.id));
    if (person) {
      const own = await cached(`person:${projectId}:${teamId}:${app}:${person}`, () => slackMemberships(token, 'private_channel,mpim', person));
      if (!own) return null;
      for (const c of own) allowed.add(c.id);
    }
    return { privateIds: new Set(bot.map((c) => c.id)), allowedIds: allowed, hasPerson: Boolean(person) };
  },
};
