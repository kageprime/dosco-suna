/**
 * Integration test (real local PostgreSQL): a Teams connector read reaches
 * only the calling project's own conversations. Real: chat_installs,
 * chat_channel_bindings, chat_threads, project_sessions rows and the SQL in
 * `dbChannelOwnership`.
 *
 * Two projects share one Teams tenant, as they do with the managed app: both
 * resolve the same platform token. Slack reads follow the Slack workspace's
 * link instead (channels/slack/link.integration.test.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chatChannelBindings, chatInstalls, chatThreads, projectSessions } from '@kortix/db';
import { inArray } from 'drizzle-orm';
import {
  CONVERSATION_NOT_IN_PROJECT,
  type ChannelReadGate,
  gateChannelRead,
} from '../connectors/channel-read-scope';
import { db } from '../shared/db';
import { removeSeeded, seedProject, seedSession, type SeededProject } from './helpers/integration-fixtures';

const RUN = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
const TENANT = `tenant-${RUN.toLowerCase()}`;
// Teams channels in the shared tenant.
const CH = `19:chan-${RUN.toLowerCase()}@thread.tacv2`;
const CH_ONLY_OTHER = `19:onlyother-${RUN.toLowerCase()}@thread.tacv2`;
const CH_QUIET = `19:quiet-${RUN.toLowerCase()}@thread.tacv2`;
const CH_MIXED_STORED = `19:MiXeD-${RUN}@thread.tacv2`;
const CH_SESSION_ONLY = `19:sessiononly-${RUN.toLowerCase()}@thread.tacv2`;

let mine: SeededProject;
let other: SeededProject;

function gate(projectId: string, platform: 'teams', actionPath: string, args: Record<string, unknown>) {
  return gateChannelRead({ projectId, platform, actionPath, args, risk: 'read' });
}

function refused(g: ChannelReadGate): string {
  expect(g.refusal?.reason).toBe(CONVERSATION_NOT_IN_PROJECT);
  return g.refusal!.message;
}

async function answer(g: ChannelReadGate, data: unknown): Promise<unknown> {
  expect(g.refusal).toBeNull();
  const res = await g.answer(data);
  if ('refusal' in res) throw new Error(`answer refused: ${res.refusal.message}`);
  return res.data;
}

beforeAll(async () => {
  mine = await seedProject('channel-read-mine');
  other = await seedProject('channel-read-other');
  const mineSession = await seedSession(mine, crypto.randomUUID());
  const otherSession = await seedSession(other, crypto.randomUUID());

  await db.insert(chatInstalls).values([
    { platform: 'teams', platformTeamId: TENANT, projectId: mine.project_id },
    { platform: 'teams', platformTeamId: TENANT, projectId: other.project_id },
  ]);
  await db.insert(chatChannelBindings).values([
    { platform: 'teams', platformTeamId: TENANT, channelId: `${CH};messageid=1`, projectId: mine.project_id },
    { platform: 'teams', platformTeamId: TENANT, channelId: `${CH};messageid=2`, projectId: other.project_id },
    // Re-pointed to the other project while this project's session still runs it.
    { platform: 'teams', platformTeamId: TENANT, channelId: `${CH};messageid=6`, projectId: other.project_id },
    { platform: 'teams', platformTeamId: TENANT, channelId: `${CH_ONLY_OTHER};messageid=9`, projectId: other.project_id },
    { platform: 'teams', platformTeamId: TENANT, channelId: `${CH_MIXED_STORED};messageid=5`, projectId: mine.project_id },
    { platform: 'teams', platformTeamId: TENANT, channelId: `${CH_MIXED_STORED};messageid=7`, projectId: other.project_id },
  ]);
  await db.insert(chatThreads).values([
    // A Teams thread whose session is the other project's and that has no binding.
    { platform: 'teams', platformTeamId: TENANT, threadId: `${CH};messageid=3`, projectId: other.project_id, sessionId: otherSession },
    { platform: 'teams', platformTeamId: TENANT, threadId: `${CH};messageid=6`, projectId: mine.project_id, sessionId: mineSession },
    // The only trace of the other project in this channel is its session.
    { platform: 'teams', platformTeamId: TENANT, threadId: `${CH_SESSION_ONLY};messageid=8`, projectId: other.project_id, sessionId: otherSession },
  ]);
});

afterAll(async () => {
  const workspaces = [TENANT];
  await db.delete(chatThreads).where(inArray(chatThreads.platformTeamId, workspaces));
  await db.delete(chatChannelBindings).where(inArray(chatChannelBindings.platformTeamId, workspaces));
  await db.delete(chatInstalls).where(inArray(chatInstalls.platformTeamId, workspaces));
  await db.delete(projectSessions).where(inArray(projectSessions.projectId, [mine.project_id, other.project_id]));
  await removeSeeded([mine, other]);
});

describe('Teams, a tenant two projects share', () => {
  test("a channel this project has a conversation in is read without the other project's threads", async () => {
    const data = await answer(await gate(mine.project_id, 'teams', 'list_messages', { 'team-id': 'team', 'channel-id': CH }), {
      value: [
        { id: '1', body: { content: 'ours' } },
        { id: '2', body: { content: 'bound to theirs' } },
        { id: '3', body: { content: 'their session' } },
        { id: '4', body: { content: 'nobody asked the bot' } },
      ],
    });
    expect((data as { value: Array<{ id: string }> }).value.map((m) => m.id)).toEqual(['1', '4']);
  });

  test('a channel only the other project has a conversation in, or none has, is refused', async () => {
    expect(refused(await gate(mine.project_id, 'teams', 'list_messages', { 'channel-id': CH_ONLY_OTHER }))).toContain(
      'belongs to another Kortix workspace',
    );
    expect(refused(await gate(mine.project_id, 'teams', 'list_messages', { 'channel-id': CH_QUIET }))).toContain(
      'Mention the bot in that channel',
    );
    expect(refused(await gate(mine.project_id, 'teams', 'list_messages', { 'channel-id': CH_SESSION_ONLY }))).toContain(
      'belongs to another Kortix workspace',
    );
    expect((await gate(other.project_id, 'teams', 'list_messages', { 'channel-id': CH_ONLY_OTHER })).refusal).toBeNull();
  });

  test('a thread follows its session, then its binding, then its channel', async () => {
    const thread = (m: string) => ({ 'team-id': 'team', 'channel-id': CH, 'message-id': m });
    expect((await gate(mine.project_id, 'teams', 'get_message', thread('1'))).refusal).toBeNull();
    expect(refused(await gate(mine.project_id, 'teams', 'list_replies', thread('2')))).toContain('Teams thread 2');
    expect(refused(await gate(mine.project_id, 'teams', 'get_message', thread('3')))).toContain('Teams thread 3');
    expect((await gate(mine.project_id, 'teams', 'list_replies', thread('4'))).refusal).toBeNull();
    // Bound to the other project, but this project's session runs it.
    expect((await gate(mine.project_id, 'teams', 'get_message', thread('6'))).refusal).toBeNull();
    expect(refused(await gate(other.project_id, 'teams', 'get_message', thread('6')))).toContain('Teams thread 6');
  });

  test('channel ids compare without case', async () => {
    const lower = `19:mixed-${RUN.toLowerCase()}@thread.tacv2`;
    const upper = `19:MIXED-${RUN}@thread.tacv2`;
    expect((await gate(mine.project_id, 'teams', 'list_messages', { 'channel-id': lower })).refusal).toBeNull();
    expect(refused(await gate(other.project_id, 'teams', 'get_message', { 'channel-id': upper, 'message-id': '5' }))).toContain(
      'Teams thread 5',
    );
    // This project has a conversation in the channel, so only the thread's own owner can refuse it.
    expect(refused(await gate(mine.project_id, 'teams', 'get_message', { 'channel-id': lower, 'message-id': '7' }))).toContain(
      'Teams thread 7',
    );
  });
});
