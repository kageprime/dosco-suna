import { expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { runWithContext, setContextField } from '../lib/request-context';
import { configCommitMessage } from '../projects/lib/config-commit-message';

mock.module('../lib/sentry', () => ({ setSentryUser: () => {} }));
mock.module('./auth-audit', () => ({ auditLoginSuccess: () => {}, auditLoginFail: () => {}, auditSessionFirstSight: () => {}, auditLogout: () => {} }));
mock.module('./auth-sso', () => ({ jitSyncSso: async () => {} }));
const { patPrincipal, serviceAccountPrincipal, jwtPrincipal } = await import('./auth-principal');

for (const kind of ['session', 'pat', 'service', 'jwt'] as const) {
  test(`${kind} principal attributes config independently of the request body`, async () => {
    const app = new Hono();
    app.use('*', (c, next) => runWithContext(c.req.method, c.req.path, next));
    app.post('/', async (c) => {
      if (kind === 'service') serviceAccountPrincipal(c, 'synthetic-service', 'synthetic-account');
      else if (kind === 'jwt') await jwtPrincipal(c, 'synthetic-user', '', { session_id: 'synthetic-browser-session' }, 'network');
      else patPrincipal(c, { isValid: true, userId: 'synthetic-user', accountId: 'synthetic-account', sessionId: kind === 'session' ? 'synthetic-agent-session' : undefined });
      await c.req.json();
      setContextField('sessionId', 'synthetic-route-target');
      return c.text(configCommitMessage('chore: edit config'));
    });
    const response = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actor: 'forged', sessionId: 'forged', authSessionId: 'forged' }) });
    expect(response.status).toBe(200);
    const session = kind === 'session' ? 'synthetic-agent-session' : kind === 'jwt' ? 'synthetic-browser-session' : 'none';
    expect(await response.text()).toBe(`chore: edit config\n\nKortix-Actor: ${kind === 'service' ? 'synthetic-service' : 'synthetic-user'}\nKortix-Session: ${session}`);
  });
}
