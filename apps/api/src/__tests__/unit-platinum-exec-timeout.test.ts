import { afterEach, expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';

const captured: unknown[] = [];
mock.module('../lib/sentry', () => ({
  captureException: (error: unknown) => captured.push(error),
  isSentryIgnoredError: () => false,
}));
const realConfig = await import('../config');
mock.module('../config', () => ({
  ...realConfig,
  config: {
    PLATINUM_API_KEY: 'synthetic-key', PLATINUM_API_URL: 'http://provider.test',
    SANDBOX_PROVIDER: 'platinum',
  },
}));
const { platinumJson } = await import('../shared/platinum');
const { PlatinumProvider } = await import('../platform/providers/platinum');
const { installHttpErrors } = await import('../http-errors');
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; captured.length = 0; });

for (const scenario of [
  { method: 'POST', path: '/v1/sandboxes/sbx_synthetic/exec', upstream: 504, expected: 504 },
  { method: 'GET', path: '/v1/sandboxes/sbx_synthetic/exec', upstream: 504, expected: 500 },
  { method: 'POST', path: '/v1/sandboxes/sbx_synthetic/stop', upstream: 504, expected: 500 },
  { method: 'POST', path: '/v1/sandboxes/sbx_synthetic/exec', upstream: 500, expected: 500 },
  { method: 'POST', path: '/v1/sandboxes/sbx_synthetic/exec', upstream: 403, expected: 500 },
]) {
  test(`${scenario.method} ${scenario.path} upstream ${scenario.upstream} returns ${scenario.expected} without replay`, async () => {
    let calls = 0;
    globalThis.fetch = Object.assign(async () => {
      calls++;
      return new Response('<!DOCTYPE html><title>Gateway Timeout</title>', { status: scenario.upstream });
    }, { preconnect: originalFetch.preconnect });
    const app = new OpenAPIHono();
    installHttpErrors(app);
    app.post('/exec', async (c) => c.json(await platinumJson(scenario.path, { method: scenario.method })));
    const response = await app.request('/exec', { method: 'POST' });
    expect(response.status).toBe(scenario.expected);
    expect(calls).toBe(1);
    expect(captured.length).toBe(scenario.expected === 504 ? 0 : 1);
    if (scenario.expected === 504) {
      expect(await response.json()).toEqual({
        error: true, code: 'sandbox_exec_outcome_unknown', status: 504,
        message: 'The sandbox provider timed out. The command may have run; inspect its effects before running it again.',
      });
      expect(response.headers.get('retry-after')).toBeNull();
    }
  });
}

for (const scenario of [
  { method: 'POST', path: '/v1/sandboxes/sbx_synthetic/exec', expected: 413 },
  { method: 'GET', path: '/v1/sandboxes/sbx_synthetic/exec', expected: 500 },
  { method: 'POST', path: '/v1/sandboxes/sbx_synthetic/stop', expected: 500 },
]) {
  test(`${scenario.method} ${scenario.path} output limit returns ${scenario.expected} without replay`, async () => {
    let calls = 0;
    globalThis.fetch = Object.assign(async () => {
      calls++;
      return Response.json({ error: 'the command ran, but its output is larger than the 16 MiB limit' }, { status: 413 });
    }, { preconnect: originalFetch.preconnect });
    const app = new OpenAPIHono();
    installHttpErrors(app);
    app.post('/exec', async (c) => c.json(await platinumJson(scenario.path, { method: scenario.method })));
    const response = await app.request('/exec', { method: 'POST' });
    expect(response.status).toBe(scenario.expected);
    expect(calls).toBe(1);
    expect(captured.length).toBe(scenario.expected === 413 ? 0 : 1);
    expect(response.headers.get('retry-after')).toBeNull();
    if (scenario.expected === 413) {
      expect(await response.json()).toEqual({
        error: true, code: 'sandbox_exec_output_too_large', status: 413,
        message: 'The sandbox provider could not return the command output because it exceeded the response limit. The command may have run; inspect its effects before running it again. Redirect large output to a file.',
      });
    }
  });
}

for (const upstream of [200, 413]) {
  test(`provider exec preserves argv and timeout at upstream ${upstream}`, async () => {
    let calls = 0;
    globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      calls++;
      expect(String(input)).toBe('http://provider.test/v1/sandboxes/sbx_synthetic/exec');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ cmd: ['printf', 'synthetic output'], timeout_ms: 1234 });
      return upstream === 200
        ? Response.json({ result: { exit_code: 0, stdout: 'synthetic output', stderr: '' } })
        : Response.json({ error: 'output limit' }, { status: 413 });
    }, { preconnect: originalFetch.preconnect });
    const provider = new PlatinumProvider();
    const app = new OpenAPIHono();
    installHttpErrors(app);
    app.post('/exec', async (c) => c.json(await provider.exec('sbx_synthetic', ['printf', 'synthetic output'], { timeoutMs: 1234 })));
    const response = await app.request('/exec', { method: 'POST' });
    expect(response.status).toBe(upstream);
    const body = await response.json();
    if (upstream === 200) expect(body).toEqual({ exitCode: 0, stdout: 'synthetic output', stderr: '' });
    else expect(body.code).toBe('sandbox_exec_output_too_large');
    expect(calls).toBe(1);
    expect(captured).toHaveLength(0);
  });
}
