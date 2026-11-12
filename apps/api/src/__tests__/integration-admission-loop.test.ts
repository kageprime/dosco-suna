/**
 * Integration test (real local PostgreSQL): a session whose head prompt cannot
 * be delivered must not churn the prompts queued behind it.
 *
 * Prod 2026-11-09: one failed session with a stopped box held a head prompt
 * parked on `runtime_unreachable` and 374 prompts behind it. Every follower was
 * claimed and put back several times a minute, and each cycle wrote two
 * `kortix.audit_events` rows and a new TOAST copy of the row's payload. Each
 * head then walked the full three-park ladder (~12 min) before the next row
 * became head, so the queue took days to drain. A follower that a drain held
 * in `running` also refused the head as "in flight".
 *
 * Every case drives the shipped writers (claim, admission, requeue, park,
 * dead-letter, the drain itself) and reads the rows back.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { admitInboxPrompt } from '../projects/session-lifecycle/inbox-admission';
import { drainSessionLifecycleQueue } from '../projects/session-lifecycle/drain';
import {
  MAX_RUNTIME_UNREACHABLE_RETRIES,
  type SessionLifecycleCommandRow,
  claimDueLifecycleCommands,
  markCommandFailed,
  parkPromptForUnreachableRuntime,
  requeueForAdmission,
} from '../projects/session-lifecycle/store';
import { sessionLifecycleCommands } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

type Row = Record<string, unknown>;
const rows = (result: unknown) => ((result as { rows?: Row[] }).rows ?? result) as Row[];

let project: SeededProject;
const sessions: string[] = [];

/** A session with a box. `failed` is the state a parked runtime leaves. */
async function seedSessionWithBox(status: 'failed' | 'stopped', box: 'stopped' | 'active'): Promise<string> {
  const sessionId = crypto.randomUUID();
  sessions.push(sessionId);
  await db.execute(sql`
    INSERT INTO kortix.project_sessions (session_id, account_id, project_id, branch_name, status, origin)
    VALUES (${sessionId}, ${project.account_id}::uuid, ${project.project_id}::uuid,
            ${`session/${sessionId}`}, ${status}::kortix.project_session_status, 'system')`);
  await db.execute(sql`
    INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, status, metadata)
    VALUES (${sessionId}::uuid, ${sessionId}, ${project.account_id}::uuid, ${project.project_id}::uuid,
            ${box}::kortix.session_sandbox_status, '{}'::jsonb)`);
  return sessionId;
}

let seq = 0;
/** One inbox prompt, as the prompt route writes it, with a payload large enough to be TOASTed. */
async function enqueue(
  sessionId: string,
  opts: { payload?: Row; result?: Row; createdAt?: Date; label?: string } = {},
): Promise<SessionLifecycleCommandRow> {
  seq += 1;
  const label = opts.label ?? `p${seq}`;
  // Hex of random bytes compresses ~2:1, so 24 KB of it stays above the
  // ~2 KB TOAST threshold after compression.
  const filler = Buffer.from(crypto.getRandomValues(new Uint8Array(12_000))).toString('hex');
  const payload = {
    text: `synthetic prompt ${label} ${filler}`,
    clientMessageId: `${label}-${crypto.randomUUID()}`,
    wireMessageId: `msg_${String(seq).padStart(6, '0')}`,
    delivery: 'queue',
    placement: 'composer',
    ...opts.payload,
  };
  const createdAt = opts.createdAt ?? new Date(Date.now() - 3 * 86_400_000 + seq * 1_000);
  const [row] = await db
    .insert(sessionLifecycleCommands)
    .values({
      commandType: 'continue_session',
      source: 'system',
      status: 'queued',
      projectId: project.project_id,
      accountId: project.account_id,
      sessionId,
      idempotencyKey: `admission-loop-it:${label}:${crypto.randomUUID()}`,
      payload,
      result: opts.result ?? {},
      createdAt,
      updatedAt: createdAt,
    })
    .returning();
  return row;
}

async function read(commandId: string) {
  const [row] = rows(
    await db.execute(sql`
      SELECT status, attempts, payload, result, last_error, available_at,
             pg_column_toast_chunk_id(payload)::text AS toast_chunk
        FROM kortix.session_lifecycle_commands WHERE command_id = ${commandId}::uuid`),
  );
  return row as {
    status: string;
    attempts: number;
    payload: Row;
    result: Row;
    last_error: string | null;
    available_at: Date | string;
    toast_chunk: string | null;
  };
}

/** Claim exactly this row, as a drain would. */
async function claim(row: SessionLifecycleCommandRow, workerId = `admission-loop-it:${crypto.randomUUID()}`) {
  const [claimed] = await claimDueLifecycleCommands({ workerId, limit: 1, idempotencyKey: row.idempotencyKey! });
  expect(claimed?.commandId).toBe(row.commandId);
  return claimed!;
}

async function auditPhases(commandId: string): Promise<string[]> {
  return rows(
    await db.execute(sql`
      SELECT phase FROM kortix.audit_events
       WHERE source_ledger = 'session_lifecycle_commands' AND source_record_id = ${commandId}
       ORDER BY occurred_at, event_id`),
  ).map((r) => String(r.phase));
}

beforeAll(async () => {
  project = await seedProject('admission-loop-it');
});

afterAll(async () => {
  for (const sessionId of sessions) {
    await db.execute(sql`DELETE FROM kortix.session_lifecycle_commands WHERE session_id = ${sessionId}`);
    await db.execute(sql`DELETE FROM kortix.session_sandboxes WHERE session_id = ${sessionId}`);
    await db.execute(sql`DELETE FROM kortix.project_sessions WHERE session_id = ${sessionId}`);
  }
  await removeSeeded([project]);
});

describe('a follower never holds the head back', () => {
  test('a follower a drain claimed, not yet admitted, is not a delivery in flight', async () => {
    const sessionId = await seedSessionWithBox('stopped', 'stopped');
    const head = await enqueue(sessionId);
    const follower = await enqueue(sessionId);
    const claimedFollower = await claim(follower);
    const claimedHead = await claim(head);

    // The follower is `running` only between its claim and its own refusal.
    expect(await admitInboxPrompt(claimedHead)).toEqual({ admit: true });
    // The follower itself still waits behind the head, on the minute clock.
    expect(await admitInboxPrompt(claimedFollower)).toMatchObject({
      admit: false,
      reason: 'older_prompt_pending',
      retryAfterMs: 60_000,
    });
  });

  test('a follower past admission, or promoted by the user, is in flight and holds the head', async () => {
    const sessionId = await seedSessionWithBox('stopped', 'stopped');
    const head = await enqueue(sessionId);
    const started = await enqueue(sessionId);
    await claim(started);
    await db.execute(sql`
      UPDATE kortix.session_lifecycle_commands
         SET result = result || ${JSON.stringify({ delivery_started_at: new Date().toISOString() })}::jsonb
       WHERE command_id = ${started.commandId}::uuid`);
    const claimedHead = await claim(head);
    expect(await admitInboxPrompt(claimedHead)).toMatchObject({ admit: false, reason: 'older_prompt_pending' });

    const sessionB = await seedSessionWithBox('stopped', 'stopped');
    const headB = await enqueue(sessionB);
    const promoted = await enqueue(sessionB, { result: { promoted: true } });
    await claim(promoted);
    const claimedHeadB = await claim(headB);
    expect(await admitInboxPrompt(claimedHeadB)).toMatchObject({ admit: false, reason: 'older_prompt_pending' });
  });
});

describe('a put-back writes no new payload copy', () => {
  test('requeueForAdmission keeps the stored payload once remintOnDelivery is set', async () => {
    const sessionId = await seedSessionWithBox('stopped', 'stopped');
    const row = await enqueue(sessionId);
    expect((await read(row.commandId)).toast_chunk).not.toBeNull();

    // The first put-back stamps `remintOnDelivery`: one new payload, by design.
    expect(await requeueForAdmission(await claim(row), 'older_prompt_pending', new Date())).toBe(true);
    const stamped = await read(row.commandId);
    expect(stamped.payload.remintOnDelivery).toBe(true);

    for (let i = 0; i < 3; i += 1) {
      expect(await requeueForAdmission(await claim(row), 'older_prompt_pending', new Date())).toBe(true);
    }
    const after = await read(row.commandId);
    expect(after.payload).toEqual(stamped.payload);
    // Same TOAST value: the put-backs rewrote the small columns only.
    expect(after.toast_chunk).toBe(stamped.toast_chunk);
    expect(after.result.admission_refusals).toBe(4);
  });
});

describe('the audit trail records the prompt and its outcome, not the queue churn', () => {
  test('claims and put-backs write no audit row; the insert and the dead-letter do', async () => {
    const sessionId = await seedSessionWithBox('stopped', 'stopped');
    const row = await enqueue(sessionId);
    expect(await auditPhases(row.commandId)).toEqual(['queued']);

    for (let i = 0; i < 3; i += 1) {
      expect(await requeueForAdmission(await claim(row), 'older_prompt_pending', new Date())).toBe(true);
    }
    expect(await auditPhases(row.commandId)).toEqual(['queued']);

    const lease = await claim(row);
    expect(await markCommandFailed(lease, 'synthetic terminal failure', {
      retryable: false,
      attempts: lease.attempts,
      sessionId,
    })).toBe('dead_lettered');
    expect(await auditPhases(row.commandId)).toEqual(['queued', 'dead_lettered']);
  });
});

describe('a head that gives up on a failed session ends the queue behind it', () => {
  test('the unreachable dead-letter also dead-letters the waiting prompts of a failed session, once', async () => {
    const failed = await seedSessionWithBox('failed', 'stopped');
    const head = await enqueue(failed, {
      payload: { runtimeUnreachableRetries: MAX_RUNTIME_UNREACHABLE_RETRIES, deliveryAttempt: 3 },
      result: { delivery_blocked: 'runtime_unreachable', runtime_retries: MAX_RUNTIME_UNREACHABLE_RETRIES },
    });
    const followers = [await enqueue(failed), await enqueue(failed), await enqueue(failed)];
    const held = await enqueue(failed, { result: { held: true } });
    const elsewhere = await seedSessionWithBox('stopped', 'stopped');
    const unrelated = await enqueue(elsewhere);

    const lease = await claim(head);
    const parked = await parkPromptForUnreachableRuntime(lease, 'unreachable', { sessionId: failed });
    expect(parked.parked).toBe(false);
    expect(await markCommandFailed(lease, 'unreachable after 3 attempts', {
      retryable: false,
      attempts: lease.attempts,
      sessionId: failed,
      runtimeUnreachable: true,
    })).toBe('dead_lettered');

    for (const follower of followers) {
      const after = await read(follower.commandId);
      expect(after.status).toBe('dead_lettered');
      expect(after.last_error).toBe("the session's machine could not be reached");
      expect(await auditPhases(follower.commandId)).toEqual(['queued', 'dead_lettered']);
    }
    // The user's Stop holds a row out of the line; it keeps waiting for them.
    expect((await read(held.commandId)).status).toBe('queued');
    expect((await read(unrelated.commandId)).status).toBe('queued');
  });

  test('a head on a session that is only stopped leaves the queue behind it waiting', async () => {
    const stopped = await seedSessionWithBox('stopped', 'stopped');
    const head = await enqueue(stopped, {
      payload: { runtimeUnreachableRetries: MAX_RUNTIME_UNREACHABLE_RETRIES },
    });
    const follower = await enqueue(stopped);
    const lease = await claim(head);
    await markCommandFailed(lease, 'unreachable after 3 attempts', {
      retryable: false,
      attempts: lease.attempts,
      sessionId: stopped,
      runtimeUnreachable: true,
    });
    expect((await read(follower.commandId)).status).toBe('queued');
  });
});

describe('the drain ends a failed session queue in a bounded number of writes', () => {
  test('the parked head reaches dead-letter and its followers are claimed once', async () => {
    const failed = await seedSessionWithBox('failed', 'stopped');
    // The prod shape: two unreachable parks spent, the payload already re-posted twice.
    const head = await enqueue(failed, {
      payload: {
        remintOnDelivery: true,
        deliveryAttempt: 2,
        runtimeUnreachableRetries: 2,
        redeliveredMessageId: 'msg_redelivered_2',
        redeliveredMessageIds: ['msg_redelivered_1', 'msg_redelivered_2'],
      },
      result: { delivery_blocked: 'runtime_unreachable', runtime_retries: 2 },
      createdAt: new Date(Date.now() - 4 * 86_400_000),
    });
    const followers = [];
    for (let i = 0; i < 5; i += 1) followers.push(await enqueue(failed));
    // The drain claims every due row: keep the other cases' rows out of it.
    await db.execute(sql`
      UPDATE kortix.session_lifecycle_commands SET available_at = now() + interval '1 day'
       WHERE session_id <> ${failed} AND status = 'queued'`);

    let drains = 0;
    while ((await read(head.commandId)).status === 'queued' && drains < 30) {
      // Time passes: the head's own backoff (answer check, park ladder) is due.
      await db.execute(sql`
        UPDATE kortix.session_lifecycle_commands SET available_at = now()
         WHERE command_id = ${head.commandId}::uuid AND status = 'queued'`);
      await drainSessionLifecycleQueue({ limit: 10 });
      drains += 1;
    }
    expect((await read(head.commandId)).status).toBe('dead_lettered');
    expect(drains).toBeLessThan(30);

    for (const follower of followers) {
      const after = await read(follower.commandId);
      expect(after.status).toBe('dead_lettered');
      // Claimed by the first drain, refused once, then left alone until the end.
      expect(Number(after.result?.admission_refusals ?? 0)).toBeLessThanOrEqual(1);
      expect(await auditPhases(follower.commandId)).toEqual(['queued', 'dead_lettered']);
    }
    // The head: its insert and its dead-letter. Its claims and parks write none.
    expect(await auditPhases(head.commandId)).toEqual(['queued', 'dead_lettered']);
  });
});
