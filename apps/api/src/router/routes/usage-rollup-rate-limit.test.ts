/**
 * KRTX-4895: the account-wide cost rollups (`GET /v1/usage/session-costs`,
 * `/cost-by-project`, `/cost-summary`) answer 429 with `Retry-After` once ONE
 * caller passes `KORTIX_USAGE_ROLLUPS_PER_MIN` on a route, instead of holding a
 * DB pool connection each until the 25 s request deadline.
 *
 * Prod 2026-11-13 22:09–22:13 UTC: one CLI client sent ~500–800 req/min, 368 of
 * them `GET /v1/usage/session-costs`. Each rollup held a pool connection to the
 * deadline, so about 140 concurrent callers drained the pool and every other
 * route (~40, incl. `GET /v1/notifications`) queued in auth for 25 s and 503'd.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

const ORIGINAL_ENV = {
  ALLOWED_SANDBOX_PROVIDERS: process.env.ALLOWED_SANDBOX_PROVIDERS,
  FRONTEND_URL: process.env.FRONTEND_URL,
  INTERNAL_KORTIX_ENV: process.env.INTERNAL_KORTIX_ENV,
  SUPABASE_URL: process.env.SUPABASE_URL,
  KORTIX_USAGE_ROLLUPS_PER_MIN: process.env.KORTIX_USAGE_ROLLUPS_PER_MIN,
};
process.env.ALLOWED_SANDBOX_PROVIDERS = 'daytona';
process.env.FRONTEND_URL = 'https://app.test.kortix.local';
process.env.INTERNAL_KORTIX_ENV = 'dev';
process.env.SUPABASE_URL = 'https://supabase.test.kortix.local';
// Read at module load: must be set before config is (transitively) imported.
process.env.KORTIX_USAGE_ROLLUPS_PER_MIN = '3';

// Dynamic: a static import would load config before the env above is set.
const realAccess = await import('../../projects/lib/access');
const realAuthorize = await import('../../iam/authorize');

const ACCOUNT_ID = '00000000-0000-4000-a000-000000000001';
const FLOODER = '00000000-0000-4000-a000-0000000000f1';
const OTHER_USER = '00000000-0000-4000-a000-0000000000f2';

mock.module('../../middleware/auth', () => ({
  combinedAuth: async (
    c: { set(key: string, value: unknown): void; req: { header(name: string): string | undefined } },
    next: () => Promise<void>,
  ) => {
    c.set('userId', c.req.header('x-test-user') ?? FLOODER);
    c.set('authType', 'supabase');
    await next();
  },
}));
mock.module('../../middleware/resolve-account', () => ({
  resolveScopedAccountId: async () => ACCOUNT_ID,
}));
mock.module('../../iam/authorize', () => ({
  ...realAuthorize,
  assertAuthorized: async () => {},
  authorize: async () => ({ allowed: true }),
}));
mock.module('../../projects/lib/access', () => ({ ...realAccess }));
mock.module('../../iam/directory-visibility', () => ({
  visibleDirectory: async () => ({ userIds: null, groupIds: null, projectIds: null }),
}));
let holdRollups: Promise<void> | null = null;
// Every drizzle builder step returns the same chain; awaiting it yields no rows.
const emptyQuery: object = new Proxy(() => emptyQuery, {
  get: (_target, prop) => (prop === 'then' ? (resolve: (rows: unknown[]) => void) => resolve([]) : emptyQuery),
});
mock.module('../../shared/db', () => ({ db: emptyQuery }));
mock.module('../../shared/session-costs', () => ({
  listSessionCosts: async () => {
    await holdRollups;
    return { sessions: [], total: 0, limit: 50, offset: 0, next_offset: null };
  },
  getSessionCostRecord: async () => null,
  findSessionCostOwner: async () => null,
  billedComputeSecondsExpression: 0,
}));
mock.module('../../shared/cost-rollups', () => ({
  listCostByProject: async () => ({ projects: [], total: 0, limit: 50, offset: 0, next_offset: null }),
  getCostSummary: async () => {
    await holdRollups;
    return { totals: {}, previous: {}, series: [], models: [] };
  },
}));

const { usageApp } = await import('./usage');

const app = new Hono();
app.route('/v1/usage', usageApp);
app.onError((error, c) =>
  error instanceof HTTPException ? c.json({ error: error.message }, error.status) : c.json({ error: 'x' }, 500),
);

afterAll(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const get = (path: string, user?: string) =>
  app.request(`/v1/usage${path}`, user ? { headers: { 'x-test-user': user } } : undefined);

describe('usage cost rollups under the per-caller guard', () => {
  test('session-costs polls past the ceiling answer 429 with Retry-After', async () => {
    const statuses: number[] = [];
    let retryAfter: string | null = null;
    let body: Record<string, unknown> | null = null;
    for (let i = 0; i < 5; i += 1) {
      const res = await get('/session-costs');
      statuses.push(res.status);
      if (res.status === 429) {
        retryAfter = res.headers.get('retry-after');
        body = (await res.json()) as Record<string, unknown>;
      } else await res.text();
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
    expect(body).toMatchObject({ error: 'rate_limit_exceeded', retry_after_seconds: expect.any(Number) });
  });

  test('a different caller keeps reading while the flooder is refused', async () => {
    const res = await get('/session-costs', OTHER_USER);
    expect(res.status).toBe(200);
    await res.text();
  });

  test('cost-by-project and cost-summary are guarded too', async () => {
    for (const path of ['/cost-by-project', '/cost-summary']) {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        const res = await get(path);
        statuses.push(res.status);
        await res.text();
      }
      expect(statuses.slice(0, 3).every((s) => s !== 429)).toBe(true);
      expect(statuses[3]).toBe(429);
    }
  });

  test('GET /v1/usage is guarded too', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const res = await get('', '00000000-0000-4000-a000-0000000000f3');
      statuses.push(res.status);
      await res.text();
    }
    expect(statuses.slice(0, 3).every((s) => s !== 429)).toBe(true);
    expect(statuses[3]).toBe(429);
  });

  test('one caller cannot hold more than 2 rollups in flight, others are unaffected', async () => {
    const user = '00000000-0000-4000-a000-0000000000f4';
    let release = () => {};
    holdRollups = new Promise<void>((resolve) => { release = resolve; });
    const parked = [get('/session-costs', user), get('/cost-summary?x=1', user)];
    await new Promise((resolve) => setTimeout(resolve, 20));
    const refused = await get('/cost-by-project', user);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('1');
    await refused.text();
    const other = get('/session-costs', OTHER_USER);
    release();
    holdRollups = null;
    expect((await other).status).toBe(200);
    for (const res of await Promise.all(parked)) await res.text();
    const after = await get('/session-costs', user);
    expect(after.status).not.toBe(429);
    await after.text();
  });

  test('the single-session cost record is guarded, with one bucket for every session id', async () => {
    const user = '00000000-0000-4000-a000-0000000000f5';
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const res = await get(`/session-costs/session-${i}`, user);
      statuses.push(res.status);
      await res.text();
    }
    expect(statuses.slice(0, 3).every((s) => s !== 429)).toBe(true);
    expect(statuses[3]).toBe(429);
  });
});
