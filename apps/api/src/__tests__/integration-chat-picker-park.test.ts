/**
 * Integration test (real local PostgreSQL): a Teams project-picker click
 * replays the message that triggered the picker, whichever replica receives
 * the click. The message is parked in `chat_pending_auth_messages` with no
 * project yet. Real rows, nothing faked. Slack has no picker: one Slack
 * workspace runs in one Kortix workspace (channels/slack/link.ts).
 */
import { afterAll, expect, test } from 'bun:test';
import { chatPendingAuthMessages } from '@kortix/db';
import { inArray } from 'drizzle-orm';
import {
  consumePendingTeamsPickerMessage,
  createPendingTeamsPickerMessage,
  latestPendingTeamsAuthMessageId,
} from '../channels/teams/auth-resume';
import type { TeamsActivity } from '../channels/teams/types';
import { db } from '../shared/db';

const WORKSPACE = `picker-park-${crypto.randomUUID()}`;

afterAll(async () => {
  await db.delete(chatPendingAuthMessages).where(inArray(chatPendingAuthMessages.platformTeamId, [WORKSPACE]));
});

test('Teams: the picker message is stored (it was dropped before) and replayed once in its conversation', async () => {
  const activity = {
    type: 'message',
    text: 'summarize the thread',
    from: { id: 'aad-picker', name: 'Picker' },
    conversation: { id: 'conv-one' },
  } as unknown as TeamsActivity;
  const pendingId = await createPendingTeamsPickerMessage({ tenantId: WORKSPACE, teamsUserId: 'aad-picker', activity });
  expect(pendingId).toMatch(/^[0-9a-f-]{36}$/);

  // The /login resume lookup for the same person ignores the picker row.
  expect(await latestPendingTeamsAuthMessageId({ tenantId: WORKSPACE, teamsUserId: 'aad-picker' })).toBeNull();
  expect(
    await consumePendingTeamsPickerMessage({ pendingId: pendingId!, tenantId: WORKSPACE, conversationId: 'conv-two' }),
  ).toBeNull();

  const replayed = await consumePendingTeamsPickerMessage({
    pendingId: pendingId!,
    tenantId: WORKSPACE,
    conversationId: 'conv-one',
  });
  expect(replayed?.text).toBe('summarize the thread');
  expect(
    await consumePendingTeamsPickerMessage({ pendingId: pendingId!, tenantId: WORKSPACE, conversationId: 'conv-one' }),
  ).toBeNull();
});
