/**
 * POST /v1/access/request-access is idempotent (KRTX-4699, pentest
 * `logic/non-idempotent-create`): replaying an identical submission used to
 * insert a duplicate `kortix.access_requests` row every time. The unique
 * index on the normalized email plus the handler's ON CONFLICT DO NOTHING
 * collapses every replay into the first row; the endpoint answers the same
 * 200 either way.
 */
import { describe, expect, test } from 'bun:test';
import { accessRequests } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { app } from '../index';

const post = (body: unknown) =>
  app.request('/v1/access/request-access', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const rowsFor = (email: string) =>
  db
    .select({ id: accessRequests.id, email: accessRequests.email })
    .from(accessRequests)
    .where(eq(accessRequests.email, email));

describe('the waitlist endpoint inserts one row per address', () => {
  test('an identical replay inserts no second row and answers the same 200', async () => {
    const email = `idempotent-${crypto.randomUUID()}@example.test`;
    const payload = { email, company: 'Synthetic', useCase: 'Testing' };

    const first = await post(payload);
    const firstBody = await first.json();
    expect(first.status).toBe(200);
    expect(firstBody).toEqual({ success: true, message: 'Access request submitted' });

    const replay = await post(payload);
    const replayBody = await replay.json();
    expect(replay.status).toBe(200);
    expect(replayBody).toEqual({ success: true, message: 'Access request submitted' });

    expect(await rowsFor(email)).toHaveLength(1);
  });

  test('the same address spelled with different case collapses into the first row', async () => {
    const email = `idempotent-${crypto.randomUUID()}@example.test`;

    const first = await post({ email });
    expect(first.status, await first.text()).toBe(200);

    // The writer stores trim().toLowerCase(); a replay that only varies the
    // case must land on the same row.
    const replay = await post({ email: email.toUpperCase() });
    expect(replay.status).toBe(200);

    expect(await rowsFor(email)).toHaveLength(1);
  });
});
