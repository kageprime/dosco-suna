/**
 * Route pins for `GET /{workspaceId}/gateway/usage` (no DB): access gate,
 * query validation and that the handler passes the parsed query + the caller's
 * session visibility into runGatewayUsageQuery. The aggregation SQL itself is
 * proven against a real database in
 * __tests__/integration-gateway-usage-query.test.ts.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import * as realAccess from '../lib/access';

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '11111111-1111-4111-8111-111111111111';

let projectExists = true;
interface RunInput {
  query: { groupBy: string[] };
  visibility: { sessionFilter: unknown };
}
let lastRunInput: RunInput | null = null;
const SESSION_FILTER = Symbol('sessionFilter');

mock.module('../lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async () =>
    projectExists ? { row: { accountId: ACCOUNT_ID, projectId: PROJECT_ID }, userId: USER_ID } : null,
  assertProjectCapability: async () => {},
}));

mock.module('../lib/project-read-view', () => ({
  projectReadView: async () => ({
    full: false,
    where: () => SESSION_FILTER,
    allows: async () => true,
  }),
}));

mock.module('../../shared/gateway-usage-run', () => ({
  runGatewayUsageQuery: async (input: RunInput) => {
    lastRunInput = { query: input.query, visibility: input.visibility };
    return {
      group_by: input.query.groupBy,
      window: { since: null, until: null, days: 30 },
      valuation: { coverage: 'x' },
      groups: [],
      totals: {
        kortix_cost: 0, provider_cost: 0, total_cost: 0, requests: 0, errors: 0,
        input_tokens: 0, output_tokens: 0, cached_tokens: 0, cache_write_tokens: 0,
        estimated_usage_value: null, priced_requests: 0, unpriced_requests: 0, groups: 0,
      },
      next_cursor: null,
    };
  },
}));

const { projectsApp } = await import('../lib/app');
(await import('./gateway')).registerGatewayRoutes();

function buildApp() {
  const app = new Hono<{ Variables: { userId: string; authType: 'pat' | 'supabase' } }>();
  app.use('*', async (c, next) => {
    c.set('userId', USER_ID);
    c.set('authType', 'pat');
    await next();
  });
  app.route('/v1/projects', projectsApp);
  return app;
}

const request = (path: string) => buildApp().request(`/v1/projects/${PROJECT_ID}${path}`);

afterEach(() => {
  projectExists = true;
  lastRunInput = null;
});

describe('GET /gateway/usage', () => {
  test('404 when the caller cannot read the project', async () => {
    projectExists = false;
    expect((await request('/gateway/usage')).status).toBe(404);
  });

  test('400 on an unknown group_by dimension', async () => {
    const res = await request('/gateway/usage?group_by=model,trigger');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/group_by must be/);
  });

  test('400 when an absolute window is combined with days', async () => {
    const res = await request('/gateway/usage?days=7&since=2026-11-01');
    expect(res.status).toBe(400);
  });

  test('400 on a malformed cursor', async () => {
    expect((await request('/gateway/usage?cursor=not%20valid%20!!')).status).toBe(400);
  });

  test('200 passes the parsed query through, grouped', async () => {
    const res = await request('/gateway/usage?group_by=source,model&since=2026-11-01T00:00:00Z&until=2026-11-08T00:00:00Z');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.group_by).toEqual(['source', 'model']);
    expect(lastRunInput!.query.groupBy).toEqual(['source', 'model']);
  });

  test("a session-grouped query carries the caller's visibility filter", async () => {
    await request('/gateway/usage?group_by=session');
    expect(lastRunInput!.visibility.sessionFilter).toBe(SESSION_FILTER);
  });
});
