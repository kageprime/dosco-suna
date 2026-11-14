import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { GitTriggerSpec } from '../triggers';

type Captured = { values: Record<string, unknown> | null };
const captured: Captured = { values: null };

function fakeInsert() {
  return {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        captured.values = values;
        return { returning: async () => [{ ...values, fake: true }] };
      },
    }),
  };
}

const realDb = await import('../../shared/db');
mock.module('../../shared/db', () => ({ ...realDb, db: fakeInsert() }));

const { insertRuntimeAgentTrigger } = await import('./runtime-triggers');
const { insertSessionReminder } = await import('./session-reminders');
const { triggerScheduleRevision } = await import('../trigger-schedule');

const NOW = new Date('2026-11-14T00:00:00.000Z');
const FIRE = new Date('2026-11-14T09:00:00.000Z');
const SESSION = '00000000-0000-4000-a000-00000000aa01';

function spec(fields: Partial<GitTriggerSpec>): GitTriggerSpec {
  return {
    slug: 'nightly', path: 'kortix.yaml#triggers.nightly', name: 'nightly', type: 'cron', agent: 'default',
    model: null, enabled: true, promptTemplate: 'x', cron: '0 0 9 * * *', runAt: null, timezone: 'UTC',
    secretEnv: null, sessionMode: 'fresh', pinnedSessionId: null, sessionKey: null, filter: null,
    ...fields,
  };
}

function expectedValues(s: GitTriggerSpec) {
  return {
    projectId: 'p1',
    slug: s.slug,
    ownerUserId: 'u1',
    triggerType: s.type,
    enabled: true,
    scheduleCron: s.cron,
    scheduleRunAt: s.runAt ? new Date(s.runAt) : null,
    scheduleTimezone: s.timezone,
    scheduleRevision: triggerScheduleRevision(s),
    scheduleSpec: s,
    nextFireAt: FIRE,
    updatedAt: NOW,
  };
}

beforeEach(() => {
  captured.values = null;
});

describe('project_trigger_runtime row written by the two insert helpers', () => {
  test('an agent trigger row carries no sessionId', async () => {
    const s = spec({});
    const row = await insertRuntimeAgentTrigger({ projectId: 'p1', spec: s, createdBy: 'u1', firstFireAt: FIRE, now: NOW });
    expect(captured.values).toEqual(expectedValues(s));
    expect(captured.values?.sessionId).toBeUndefined();
    expect(row).toMatchObject({ fake: true });
  });

  test('a one-shot agent trigger stores runAt as a Date and a null first slot', async () => {
    const s = spec({ cron: null, runAt: '2026-11-15T10:00:00.000Z' });
    await insertRuntimeAgentTrigger({ projectId: 'p1', spec: s, createdBy: 'u1', firstFireAt: null, now: NOW });
    expect(captured.values).toEqual({ ...expectedValues(s), nextFireAt: null });
    expect(captured.values?.scheduleRunAt).toEqual(new Date('2026-11-15T10:00:00.000Z'));
  });

  test('a session reminder row carries the pinned sessionId', async () => {
    const s = spec({ pinnedSessionId: SESSION });
    await insertSessionReminder({ projectId: 'p1', spec: s, createdBy: 'u1', firstFireAt: FIRE, now: NOW });
    expect(captured.values).toEqual({ ...expectedValues(s), sessionId: SESSION });
  });
});
