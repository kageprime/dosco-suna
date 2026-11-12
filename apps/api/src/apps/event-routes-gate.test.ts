/**
 * Characterization: the App-token gate of the three routes an App calls with
 * its own KORTIX_APP_TOKEN, pinned before the refactor (KRTX-4617). The gate
 * order is the contract: 401 without the App's token, then 429 over the App's
 * per-minute limit, then 404 for an unknown App — a missing token answers 401
 * even when the App is unknown, and a limited App answers 429 before
 * existence is checked. The rate limiter and the App lookup are stubbed; the
 * routes' own answers and their order are what must survive the refactor.
 */
import { describe, expect, mock, test } from 'bun:test';

const limiter = { limited: false };
mock.module('../middleware/rate-limit', () => ({
  appEventRateLimited: () => (limiter.limited ? { retryAfterSeconds: 30 } : null),
}));
/** What the gate's `scopedApp` answers: null = an unknown App. */
const knownApp = { current: null as { slug: string } | null };
mock.module('./route-access', () => ({
  scopedApp: async () => knownApp.current,
}));
mock.module('../projects/surface', () => ({
  cancelAppRun: async () => true,
  ingestAppEvents: async () => ({}),
  insertAppRun: async () => ({}),
  parseAppEventsBody: () => ({ events: [] }),
}));

const { appEventsApp: app, registerAppEventRoutes } = await import('./event-routes');
const { appEventToken } = await import('./events');
registerAppEventRoutes();

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';
const APP_ID = '00000000-0000-4000-8000-000000000002';
const TOKEN = appEventToken(APP_ID);
const TOKEN_ERROR = {
  error: 'Send the App token: Authorization: Bearer $KORTIX_APP_TOKEN',
  code: 'app_token_invalid',
};

const routes: Array<{
  name: string;
  request: () => Promise<Response> | Response;
  authorize: (headers: Record<string, string>) => Promise<Response> | Response;
}> = [
  {
    name: 'events',
    request: () => app.request(`/${WORKSPACE_ID}/apps/${APP_ID}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'reply.received' }),
    }),
    authorize: (headers: Record<string, string>) => app.request(`/${WORKSPACE_ID}/apps/${APP_ID}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ name: 'reply.received' }),
    }),
  },
  {
    name: 'runs',
    request: () => app.request(`/${WORKSPACE_ID}/apps/${APP_ID}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ run_after: '30s' }),
    }),
    authorize: (headers: Record<string, string>) => app.request(`/${WORKSPACE_ID}/apps/${APP_ID}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ run_after: '30s' }),
    }),
  },
  {
    name: 'run cancel',
    request: () => app.request(`/${WORKSPACE_ID}/apps/${APP_ID}/runs/run-1`, { method: 'DELETE' }),
    authorize: (headers: Record<string, string>) => app.request(`/${WORKSPACE_ID}/apps/${APP_ID}/runs/run-1`, {
      method: 'DELETE',
      headers,
    }),
  },
];

const bearer = { authorization: `Bearer ${TOKEN}` };

describe('App-token routes: the gate order', () => {
  test.each(routes)('the $name route 401s without the App token', async ({ request }) => {
    limiter.limited = false;
    knownApp.current = { slug: 'app' };
    const res = await request();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(TOKEN_ERROR);
  });

  test.each(routes)('the $name route 429s over the per-App limit before existence', async ({ authorize }) => {
    limiter.limited = true;
    knownApp.current = null;
    const res = await authorize(bearer);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: 'This App sent too many requests this minute. Send events in batches ({ "events": [...] }, at most 50) and retry shortly.',
      code: 'rate_limit_exceeded',
      retry_after_seconds: 30,
    });
  });

  test.each(routes)('the $name route 404s an unknown App', async ({ authorize }) => {
    limiter.limited = false;
    knownApp.current = null;
    const res = await authorize(bearer);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  test('a missing token answers 401 even when the App is unknown and limited', async () => {
    limiter.limited = true;
    knownApp.current = null;
    const res = await app.request(`/${WORKSPACE_ID}/apps/${APP_ID}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'reply.received' }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(TOKEN_ERROR);
  });
});
