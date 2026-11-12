import { expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';

// Audit persistence is unrelated to response headers and needs PostgreSQL.
mock.module('../middleware/audit', () => ({
  auditApiRequest: async (_context: unknown, next: () => Promise<void>) => next(),
}));
const { installHttpMiddleware } = await import('../http-middleware');

const app = new OpenAPIHono();
installHttpMiddleware(app);
app.get('/', (c) => c.text('ok'));
app.get('/denied', (c) => c.json({ error: 'unauthorized' }, 401));
app.get('/failure', () => {
  throw new Error('synthetic failure');
});

// Every response the API serves at its origin carries the same referrer
// policy, so the header is uniform across edge-served paths whether or not a
// request passed through a Cloudflare Worker (KRTX-4702).
for (const [path, status] of [
  ['/', 200],
  ['/denied', 401],
  ['/missing', 404],
  ['/failure', 500],
] as const) {
  test(`Referrer-Policy covers ${status} responses`, async () => {
    const response = await app.request(path);
    expect(response.status).toBe(status);
    expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });
}

test('Referrer-Policy covers CORS preflight', async () => {
  const response = await app.request('/', {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:3000', 'Access-Control-Request-Method': 'GET' },
  });
  expect(response.status).toBe(204);
  expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
});

test('a route-set stricter Referrer-Policy survives the global header', async () => {
  const strictApp = new OpenAPIHono();
  installHttpMiddleware(strictApp);
  strictApp.get('/shared', (c) => {
    c.header('Referrer-Policy', 'no-referrer');
    return c.text('ok');
  });
  const response = await strictApp.request('/shared');
  expect(response.status).toBe(200);
  expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
});
