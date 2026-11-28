/**
 * Integration test (real Postgres): a project's `block` gateway budget stops
 * composer dictation once its spend reaches the limit.
 *
 * Budget spend is summed from `gateway_request_logs` / `gateway_spend_daily`.
 * Dictation settles outside the gateway process, so it must write its request
 * trace itself, or a cap the owner set never counts it (Strix review on
 * #13043). The trace carries no audio and no transcript.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { gatewayBudgets, gatewayRequestLogs } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { config } from '../config';
import { __resetBudgetReservationsForTests } from '../llm-gateway/budgets';
import { transcribeDictation } from '../projects/dictation/transcribe';
import { db } from '../shared/db';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const USER = crypto.randomUUID();
const UPSTREAM = 'https://platinum.test/v1/inference';
const TRANSCRIPT = 'open the session from yesterday';
const saved = {
  enabled: config.KORTIX_MANAGED_PROVIDER_ENABLED,
  key: config.PLATINUM_INFERENCE_API_KEY,
  url: config.PLATINUM_INFERENCE_URL,
  billing: config.KORTIX_BILLING_INTERNAL_ENABLED,
};
const realFetch = globalThis.fetch;
let upstreamCalls = 0;
let project: SeededProject;
let quiet: SeededProject;

// A WebM header: the clip check reads the container from these bytes.
const clip = () => new File([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81])], 'clip.webm');
// The same header, one byte longer: the stub answers it as 60 s of silence.
const silence = () => new File([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0])], 'silence.webm');

beforeAll(async () => {
  project = await seedProject('dictation-budget');
  quiet = await seedProject('dictation-silence');
  Object.assign(config, {
    KORTIX_MANAGED_PROVIDER_ENABLED: true,
    PLATINUM_INFERENCE_API_KEY: 'test-key',
    PLATINUM_INFERENCE_URL: UPSTREAM,
    // The wallet is not under test: the budget gate alone must refuse.
    KORTIX_BILLING_INTERNAL_ENABLED: false,
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === `${UPSTREAM}/audio/transcriptions`) {
      upstreamCalls++;
      const file = (init?.body as FormData).get('file') as File;
      if (file.size === 9) return Response.json({ text: '', usage: { type: 'duration', seconds: 60, cost: 0.0025 } });
      // 30 s of audio: $0.005 at 1 credit per minute.
      return Response.json({ text: TRANSCRIPT, usage: { type: 'duration', seconds: 30, cost: 0.00125 } });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  __resetBudgetReservationsForTests();
  // $0.01 a day: two 30 s clips reach it.
  await db.insert(gatewayBudgets).values({
    projectId: project.project_id,
    scope: 'project',
    subjectUserId: null,
    limitUsd: '0.01',
    period: 'day',
    action: 'block',
  });
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  Object.assign(config, {
    KORTIX_MANAGED_PROVIDER_ENABLED: saved.enabled,
    PLATINUM_INFERENCE_API_KEY: saved.key,
    PLATINUM_INFERENCE_URL: saved.url,
    KORTIX_BILLING_INTERNAL_ENABLED: saved.billing,
  });
  for (const seeded of [project, quiet]) {
    await db.delete(gatewayRequestLogs).where(eq(gatewayRequestLogs.projectId, seeded.project_id));
  }
  await removeSeeded([project, quiet]);
});

test('a block budget refuses dictation once the clips it already charged reach the limit', async () => {
  const scope = { accountId: project.account_id, projectId: project.project_id, userId: USER };

  const first = await transcribeDictation(scope, clip());
  const second = await transcribeDictation(scope, clip());
  expect(first).toMatchObject({ ok: true, text: TRANSCRIPT, seconds: 30 });
  expect(second).toMatchObject({ ok: true, seconds: 30 });

  const third = await transcribeDictation(scope, clip());
  expect(third).toMatchObject({ ok: false, status: 402, code: 'budget_exceeded' });
  // The refusal happens before the paid upstream.
  expect(upstreamCalls).toBe(2);
});

test('the trace a dictation writes holds its cost and no transcript', async () => {
  const rows = await db
    .select()
    .from(gatewayRequestLogs)
    .where(eq(gatewayRequestLogs.projectId, project.project_id));
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row.requestedModel).toBe('dictation');
    expect(Number(row.finalCost)).toBeCloseTo(0.005, 6);
    expect(JSON.stringify(row)).not.toContain(TRANSCRIPT);
  }
});

test('a clip with no speech is charged by its length like any other', async () => {
  const result = await transcribeDictation(
    { accountId: quiet.account_id, projectId: quiet.project_id, userId: USER },
    silence(),
  );
  expect(result).toMatchObject({ ok: true, text: '', seconds: 60 });
  expect(result.ok && result.costUsd).toBeCloseTo(0.01, 6);
  const [row] = await db.select().from(gatewayRequestLogs).where(eq(gatewayRequestLogs.projectId, quiet.project_id));
  expect(Number(row?.finalCost)).toBeCloseTo(0.01, 6);
});
