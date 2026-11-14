/**
 * `POST /workspaces/:id/channels/slack/join` service: the bot joins public
 * channels by name or id; a private channel, or a name the bot cannot see,
 * is reported for a person's /invite and never forced. Slack is faked at
 * `fetch`; the install store is mocked at its module seam.
 */
import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import * as realInstalls from '../channels/slack/installs';

let installed = true;
mock.module('../channels/slack/installs', () => ({
  ...realInstalls,
  loadSlackInstall: async () => (installed ? { workspaceId: 'T0SYN', workspaceName: 'Synthetic', botUserId: 'U0BOT', installedAt: '2026-11-10T00:00:00.000Z' } : null),
  loadSlackTokenForProject: async () => (installed ? 'xoxb-synthetic' : null),
}));

const { joinSlackChannels, normalizeChannelRef } = await import('../channels/slack/join');

const realFetch = globalThis.fetch;
let calls: Array<{ method: string; body: string }> = [];
const CHANNELS = [
  { id: 'C0PUBLIC1', name: 'eng', is_private: false, is_member: false },
  { id: 'C0PUBLIC2', name: 'support', is_private: false, is_member: true },
  { id: 'G0PRIVATE', name: 'leads', is_private: true, is_member: false },
];

beforeEach(() => {
  calls = [];
  installed = true;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = String(input).split('/').pop()!;
    const body = String(init?.body ?? '');
    calls.push({ method, body });
    if (method === 'conversations.list') {
      const page = new URLSearchParams(body).get('cursor') ? 2 : 1;
      return Response.json(page === 1
        ? { ok: true, channels: CHANNELS.slice(0, 2), response_metadata: { next_cursor: 'page-2' } }
        : { ok: true, channels: CHANNELS.slice(2), response_metadata: { next_cursor: '' } });
    }
    if (method === 'conversations.join') return Response.json({ ok: true });
    return Response.json({ ok: false, error: 'unknown_method' });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

test('public channels are joined, members stay, private and unknown ones need an invite', async () => {
  const resp = await joinSlackChannels('project-synthetic', ['#Eng', 'support', 'leads', 'nowhere', 'C0UNSEEN9']);
  expect(resp).toMatchObject({ connected: true, team: 'Synthetic', bot_user_id: 'U0BOT' });
  expect(resp.results).toEqual([
    { channel: '#Eng', id: 'C0PUBLIC1', status: 'joined' },
    { channel: 'support', id: 'C0PUBLIC2', status: 'already_member' },
    { channel: 'leads', id: 'G0PRIVATE', status: 'needs_invite' },
    { channel: 'nowhere', id: null, status: 'not_found' },
    { channel: 'C0UNSEEN9', id: 'C0UNSEEN9', status: 'needs_invite' },
  ]);
  // Both list pages were read (form-encoded, as Slack's read methods require); one join call, for #eng.
  expect(calls.filter((c) => c.method === 'conversations.list')).toHaveLength(2);
  expect(calls.filter((c) => c.method === 'conversations.join').map((c) => JSON.parse(c.body).channel)).toEqual(['C0PUBLIC1']);
});

test('no Slack connection: connected false, no Slack call', async () => {
  installed = false;
  expect(await joinSlackChannels('project-synthetic', ['eng'])).toEqual({ connected: false, team: null, bot_user_id: null, results: [] });
  expect(calls).toHaveLength(0);
});

test('channel refs: a leading # and case go, an id stays', () => {
  expect(normalizeChannelRef('#General')).toBe('general');
  expect(normalizeChannelRef(' C0ABCDEF1 ')).toBe('C0ABCDEF1');
});
