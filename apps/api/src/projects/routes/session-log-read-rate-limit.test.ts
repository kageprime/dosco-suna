/**
 * Drives the real stored-log read handlers to prove KRTX-4696: the per-session
 * read guard answers 429 (with `Retry-After`) once a session's log polls pass
 * `KORTIX_SESSION_LOG_READS_PER_MIN`, other sessions keep reading, and the
 * sibling stored-log reads (`GET …/snapshot` and its `/open-bundle` alias)
 * share the same (caller, session) budget — a poller
 * cannot escape the ceiling by switching routes.
 *
 * Prod 2026-11-10 23:38–23:42 UTC: one CLI client polled the stored log of one
 * session in waves that peaked near 24 requests/s (about 50k requests over one
 * evening against a single session). Each poll pays the full session-read gate
 * plus the page transaction and a multi-100 kB serialize+gzip, so the API's p95
 * for the route hit 2.6 s and the API-wide p95 rose with it. The guard caps the
 * amplification at the handler's front door, before the gate.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';

const ORIGINAL_ENV = {
  ALLOWED_SANDBOX_PROVIDERS: process.env.ALLOWED_SANDBOX_PROVIDERS,
  FRONTEND_URL: process.env.FRONTEND_URL,
  INTERNAL_KORTIX_ENV: process.env.INTERNAL_KORTIX_ENV,
  SUPABASE_URL: process.env.SUPABASE_URL,
  KORTIX_SESSION_LOG_READS_PER_MIN: process.env.KORTIX_SESSION_LOG_READS_PER_MIN,
};
process.env.ALLOWED_SANDBOX_PROVIDERS = 'daytona';
process.env.FRONTEND_URL = 'https://app.test.kortix.local';
process.env.INTERNAL_KORTIX_ENV = 'dev';
process.env.SUPABASE_URL = 'https://supabase.test.kortix.local';
// Read at module load: must be set before config is (transitively) imported.
process.env.KORTIX_SESSION_LOG_READS_PER_MIN = '3';

const PROJECT_ID = 'd7700000-0000-4000-a000-000000000001';
const SESSION_ID = 'd7800000-0000-4000-a000-000000000001';
const OTHER_SESSION_ID = 'd7800000-0000-4000-a000-000000000002';

mock.module('./lib/route-bindings', () => ({
  resolveSessionBinding: async () => ({
    kind: 'ok',
    loaded: { userId: 'd7900000-0000-4000-a000-000000000001', row: { metadata: {} } },
  }),
}));

const realAccess = await import('../lib/access');

mock.module('../lib/access', () => ({
  ...realAccess,
  assertProjectCapability: async () => {},
  loadVisibleSession: async () => ({ row: {} }),
  sessionIsTombstoned: () => false,
}));

const realSessionLogRead = await import('../session-log-read');

mock.module('../session-log-read', () => ({
  ...realSessionLogRead,
  readSessionLogPage: async () => ({
    session: {},
    generation: 1,
    threads: [],
    thread_id: 'root',
    messages: [],
    has_more: false,
  }),
}));

const { projectsApp } = await import('../lib/app');
// The caller the guard keys on: the handler reads `userId` (auth middleware sets
// it in prod); this test mints it from a header so each caller is addressable.
projectsApp.use('*', async (c, next) => {
  const testUser = c.req.header('x-test-user');
  if (testUser) c.set('userId', testUser);
  await next();
});
const { registerSessionLogRoutes } = await import('./session-log');
registerSessionLogRoutes();
const { registerSessionOpenBundleRoutes } = await import('./session-open-bundle');
registerSessionOpenBundleRoutes();

afterAll(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('GET …/log under the per-session read guard', () => {
  test('polls past the per-session ceiling answer 429 with Retry-After', async () => {
    const statuses: number[] = [];
    let retryAfter: string | null = null;
    let body: Record<string, unknown> | null = null;
    for (let i = 0; i < 5; i += 1) {
      const res = await projectsApp.request(`/${PROJECT_ID}/sessions/${SESSION_ID}/log`);
      statuses.push(res.status);
      if (res.status === 429) {
        retryAfter = res.headers.get('retry-after');
        body = (await res.json()) as Record<string, unknown>;
      } else {
        await res.text();
      }
    }
    // The ceiling is 3 reads/min for this test: the first 3 pass, the rest refuse.
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
    expect(body).toMatchObject({ error: 'rate_limit_exceeded', retry_after_seconds: expect.any(Number) });
  });

  test('another session of the same caller keeps reading', async () => {
    const res = await projectsApp.request(`/${PROJECT_ID}/sessions/${OTHER_SESSION_ID}/log`);
    expect(res.status).toBe(200);
    await res.text();
  });

  test('a different caller on the same session gets a fresh bucket', async () => {
    // The same session the first test exhausted under the default caller key.
    const callerA = await projectsApp.request(`/${PROJECT_ID}/sessions/${SESSION_ID}/log`, {
      headers: { 'x-test-user': 'd7900000-0000-4000-a000-00000000000a' },
    });
    expect(callerA.status).toBe(200);
    await callerA.text();
    const callerB = await projectsApp.request(`/${PROJECT_ID}/sessions/${SESSION_ID}/log`, {
      headers: { 'x-test-user': 'd7900000-0000-4000-a000-00000000000b' },
    });
    expect(callerB.status).toBe(200);
    await callerB.text();
  });
});

describe('sibling stored-log reads share the same (caller, session) budget', () => {
  // The default caller's bucket on SESSION_ID was drained by the first describe
  // block through GET …/log alone — the snapshot route and its alias 429 on
  // the SAME key, so a poller cannot escape the ceiling by switching routes.
  test('snapshot and open-bundle answer 429 on the drained bucket, with the same denial body', async () => {
    for (const route of ['snapshot', 'open-bundle']) {
      const res = await projectsApp.request(`/${PROJECT_ID}/sessions/${SESSION_ID}/${route}`);
      expect(res.status).toBe(429);
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        error: 'rate_limit_exceeded',
        retry_after_seconds: expect.any(Number),
      });
    }
  });
});
