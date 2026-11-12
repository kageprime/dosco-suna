import { afterAll, beforeAll, expect, test } from 'bun:test';
import { accounts, projects, chatPendingAuthMessages } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { createPendingSlackAuthMessage } from '../channels/slack/auth-resume';
import type { SlackEnvelope, SlackEvent } from '../channels/slack/types';

const accountId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const teamId = `pending-${crypto.randomUUID()}`;
const event: SlackEvent = { type: 'app_mention', user: 'synthetic-user', channel: 'synthetic-channel', text: 'hello', ts: '1.0' };
const envelope: SlackEnvelope = { type: 'event_callback', team_id: teamId, event };
beforeAll(async () => {
  await db.insert(accounts).values({ accountId, name: 'pending-test' });
  await db.insert(projects).values({ projectId, accountId, name: 'pending-test', repoUrl: 'https://example.test/synthetic.git', metadata: {} });
});
afterAll(async () => {
  await db.delete(chatPendingAuthMessages).where(eq(chatPendingAuthMessages.platformTeamId, teamId));
  await db.delete(projects).where(eq(projects.projectId, projectId));
  await db.delete(accounts).where(eq(accounts.accountId, accountId));
});

test('an auth message persists its exact payload, owner and TTL; the next insertion cleans expired rows', async () => {
  const before = Date.now();
  const authId = await createPendingSlackAuthMessage({ projectId, teamId, slackUserId: 'auth-user', envelope, event });
  const rows = await db.select().from(chatPendingAuthMessages).where(eq(chatPendingAuthMessages.platformTeamId, teamId));
  expect(rows).toHaveLength(1);
  const auth = rows.find(row => row.pendingId === authId);
  expect(auth).toMatchObject({ projectId, platform: 'slack', platformTeamId: teamId, platformUserId: 'auth-user', envelope, event });
  expect(auth?.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 600_000);
  await db.update(chatPendingAuthMessages).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(chatPendingAuthMessages.pendingId, authId!));
  await createPendingSlackAuthMessage({ projectId, teamId, slackUserId: 'next-user', envelope, event });
  const remaining = await db.select().from(chatPendingAuthMessages).where(eq(chatPendingAuthMessages.platformTeamId, teamId));
  expect(remaining.some(row => row.pendingId === authId)).toBe(false);
  expect(remaining.some(row => row.platformUserId === 'next-user')).toBe(true);
});

test('invalid caller guards store no rows', async () => {
  expect(await createPendingSlackAuthMessage({ projectId, teamId: '', slackUserId: 'user', envelope, event })).toBeNull();
  expect(await createPendingSlackAuthMessage({ projectId, teamId, slackUserId: '', envelope, event })).toBeNull();
});
