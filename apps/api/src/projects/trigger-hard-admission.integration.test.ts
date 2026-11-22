import { afterAll, beforeAll, expect, test } from 'bun:test';
import { projectTriggerAdmissions } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { removeSeeded, seedProject, type SeededProject } from '../__tests__/helpers/integration-fixtures';
import { reserveTriggerRun } from './lib/trigger-run-caps';

let project: SeededProject;
const now = new Date('2026-11-19T14:00:00Z');
beforeAll(async () => { project = await seedProject('hard-admission'); });
afterAll(async () => { await removeSeeded([project]); });

test('concurrent manual admissions stop at five before dispatch', async () => {
  const results = await Promise.all(Array.from({ length: 12 }, () => reserveTriggerRun({
    projectId: project.project_id, slug: 'hour', caps: { maxRunsPerHour: 5, maxRunsPerDay: 20 }, now,
  })));
  expect(results.filter((result) => result.admitted)).toHaveLength(5);
  expect(results.filter((result) => !result.admitted)).toHaveLength(7);
  const rows = await db.select().from(projectTriggerAdmissions).where(eq(projectTriggerAdmissions.projectId, project.project_id));
  expect(rows).toHaveLength(5);
});

test('daily ceiling, rolling hour boundary and UTC rollover', async () => {
  const input = { projectId: project.project_id, slug: 'day', caps: { maxRunsPerHour: 30, maxRunsPerDay: 20 }, now };
  for (let n = 0; n < 20; n += 1) expect((await reserveTriggerRun(input)).admitted).toBe(true);
  expect(await reserveTriggerRun(input)).toMatchObject({ admitted: false, reason: expect.stringContaining('max_runs_per_day 20') });
  expect((await reserveTriggerRun({ ...input, now: new Date('2026-11-20T00:00:00Z') })).admitted).toBe(true);
  const hour = { ...input, slug: 'boundary', caps: { maxRunsPerHour: 1 } };
  expect((await reserveTriggerRun(hour)).admitted).toBe(true);
  expect((await reserveTriggerRun({ ...hour, now: new Date(now.getTime() + 3_599_999) })).admitted).toBe(false);
  expect((await reserveTriggerRun({ ...hour, now: new Date(now.getTime() + 3_600_000) })).admitted).toBe(true);
});

test('reservation scope is trigger local', async () => {
  const one = { projectId: project.project_id, slug: 'isolated', caps: { maxRunsPerHour: 1 }, now };
  expect((await reserveTriggerRun(one)).admitted).toBe(true);
  expect((await reserveTriggerRun(one)).admitted).toBe(false);
  expect((await reserveTriggerRun({ ...one, slug: 'another' })).admitted).toBe(true);
});
