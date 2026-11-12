import { describe, expect, it } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import { installHttpErrors } from '../http-errors';
import { registerSystemRoutes } from '../routes/system';

// KRTX-4704 (pentest wrong-method-bare-404): a wrong method on an existing
// GET-only route fell through to the bare 404 envelope with no Allow header.
// RFC 9110 §15.5.5: a path that exists but rejects the method answers 405 and
// names its methods in Allow; 404 stays for unmatched paths.
const app = new OpenAPIHono();
registerSystemRoutes(app); // GET-only /v1/openapi.json, /v1/health, /v1/docs, ...
installHttpErrors(app);

describe('a wrong method on an existing GET-only route answers 405 + Allow', () => {
  for (const method of ['DELETE', 'PATCH', 'POST', 'PUT']) {
    for (const path of ['/v1/openapi.json', '/v1/health', '/v1/docs']) {
      it(`${method} ${path} answers 405 with Allow: GET, HEAD`, async () => {
        const res = await app.request(path, { method });
        expect(res.status).toBe(405);
        expect(res.headers.get('allow')).toBe('GET, HEAD');
      });
    }
  }

  it('GET control still reaches the handler', async () => {
    const res = await app.request('/v1/openapi.json');
    expect(res.status).toBe(200);
  });

  it('an unmatched path still answers the bare 404 envelope', async () => {
    const res = await app.request('/v1/definitely-not-a-route', { method: 'PATCH' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: true, message: 'Not found', status: 404 });
  });

  it('a path only middleware matches stays 404', async () => {
    const app = new OpenAPIHono();
    app.use('/v1/zone/*', async (_c, next) => next());
    installHttpErrors(app);
    const res = await app.request('/v1/zone/unknown', { method: 'PATCH' });
    expect(res.status).toBe(404);
  });

  it('a handler that answers 404 on a matched method stays 404, never 405', async () => {
    const app = new OpenAPIHono();
    app.get('/only-get-404s', (c) => c.notFound());
    installHttpErrors(app);
    const res = await app.request('/only-get-404s');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: true, message: 'Not found', status: 404 });
  });
});
