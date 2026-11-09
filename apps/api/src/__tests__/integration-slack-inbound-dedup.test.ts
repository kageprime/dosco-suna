/**
 * Integration test (real local DB): the exactly-once gate for an inbound Slack
 * user message is scoped to the RECEIVING project.
 *
 * Two projects can each install their own (BYO) Slack app in the SAME workspace.
 * One user message then reaches Kortix as two deliveries that share the message
 * coordinates `(team, channel, ts)` but belong to different projects. The gate
 * must collapse the deliveries of ONE project into one run (retry, fan-out,
 * sibling replica) and must never let one project's claim suppress another
 * project's message (CWE-863, KRTX-4447).
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { chatEventDedup } from '@kortix/db';
import { like } from 'drizzle-orm';
import { claimInboundMessage, inboundMessageKey } from '../channels/slack/dedup';
import { db } from '../shared/db';

// Coordinator => the lane provides DATABASE_URL / TEST_DATABASE_URL, and calling
// the helpers is what pins this file to the loopback test database.
import { localTestDatabaseUrl, seedProject } from './helpers/integration-fixtures';

localTestDatabaseUrl();

const TEAM = 'T0KRTX4447';
const CHANNEL = 'C0KRTX4447';
const TS = '1762000000.000100';

// The suites run in parallel against one template, so every test starts from an
// unclaimed message: no leftover row (this suite's or anyone else's) decides it.
beforeEach(async () => {
  await db.delete(chatEventDedup).where(like(chatEventDedup.eventId, `slack:msg:%${TEAM}:${CHANNEL}:${TS}`));
});

async function claim(projectId: string): Promise<boolean> {
  const key = inboundMessageKey(projectId, TEAM, { channel: CHANNEL, ts: TS });
  if (!key) throw new Error('the message coordinates must build a key');
  return claimInboundMessage(key);
}

describe('inbound Slack message gate — scoped per receiving project', () => {
  test('one project claiming a message does not suppress another project’s delivery', async () => {
    const [first, second] = await Promise.all([seedProject('slack-dedup-a'), seedProject('slack-dedup-b')]);

    expect(await claim(first.project_id), 'the first project must run its delivery').toBe(true);
    expect(
      await claim(second.project_id),
      'the second project was suppressed by another project’s claim (CWE-863)',
    ).toBe(true);
  });

  test('a redelivery into the SAME project is still suppressed', async () => {
    const { project_id } = await seedProject('slack-dedup-redelivery');

    expect(await claim(project_id), 'the first delivery runs').toBe(true);
    expect(await claim(project_id), 'a retry / fan-out / sibling replica must not run again').toBe(false);
    expect(await claim(project_id), 'and the claim stays held').toBe(false);
  });
});
