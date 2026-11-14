import { expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';

// KRTX-4916: a BillingError the caller can fix (a 4xx refusal such as "tier does
// not allow credit purchases") is an expected outcome, not a server fault. It
// must not log at `error` level, which feeds the infra sweep's error-log alerts.
const logged: { level: string; message: string }[] = [];
mock.module('../lib/logger', () => {
  const at = (level: string) => (message: string) => logged.push({ level, message });
  return { logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') } };
});
mock.module('../lib/sentry', () => ({
  captureException: () => undefined,
  isSentryIgnoredError: () => false,
}));
const { installHttpErrors } = await import('../http-errors');
const { BillingError, WalletUnavailableError } = await import('../errors');

async function levelFor(err: Error): Promise<{ status: number; levels: string[] }> {
  logged.length = 0;
  const app = new OpenAPIHono();
  installHttpErrors(app);
  app.post('/v1/billing/purchase-credits', () => {
    throw err;
  });
  const response = await app.request('/v1/billing/purchase-credits', { method: 'POST' });
  return {
    status: response.status,
    levels: logged.filter((l) => l.message.includes('[BillingError]')).map((l) => l.level),
  };
}

test('a 400 BillingError is logged at warn, not error', async () => {
  const out = await levelFor(new BillingError('Your tier does not allow credit purchases'));
  expect(out).toEqual({ status: 400, levels: ['warn'] });
});

test('a 5xx billing error stays at error level', async () => {
  const out = await levelFor(new WalletUnavailableError());
  expect(out).toEqual({ status: 503, levels: ['error'] });
});
