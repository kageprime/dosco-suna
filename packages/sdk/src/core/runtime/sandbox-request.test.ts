import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { RuntimeNotReadyError } from './runtime-not-ready-error';

// Characterization pins for the shared sandbox request core, written before
// `./sandbox-request` existed: the four daemon clients (`./env`, `./pty`,
// `./triggers`, `./kortix-master`) keep these behaviors through the restructure.
// The section at the bottom pins the issue's two deliberate behavior changes
// (one error-message union, one not-ready error class) — red before, green after.
//
// This file must be hermetic against process-wide `mock.module('../http/auth')`
// registrations made by OTHER test files (Bun's `mock.module` is process-wide;
// see kortix-master.test.ts): it registers its OWN mock and imports the modules
// under test via `await import(...)` so they resolve against that registration.

interface Call {
  url: string;
  method: string;
  body?: string;
}

let calls: Call[] = [];
let nextResponse: () => Response = () =>
  new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });

let authToken: string | null = 'test-token';
mock.module('../http/auth', () => ({
  getAuthToken: async () => authToken,
  getAuthTokenWithRetry: async () => authToken,
  authenticatedFetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return nextResponse();
  },
  invalidateTokenCache: () => {},
  setCachedAuthToken: () => {},
  setBootstrapAuthToken: () => {},
  getSupabaseAccessToken: async () => authToken,
  getSupabaseAccessTokenWithRetry: async () => authToken,
}));

const Env = await import('./env');
const Pty = await import('./pty');
const Triggers = await import('./triggers');
const last = () => calls[calls.length - 1];
const BASE = 'http://sbx.test';

beforeEach(() => {
  calls = [];
  authToken = 'test-token';
  nextResponse = () =>
    new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
});

describe('pty client request behavior (pinned before the sandbox-request core)', () => {
  test('listKortixPty GETs {baseUrl}/kortix/pty and returns the parsed list', async () => {
    nextResponse = () =>
      new Response(
        JSON.stringify([{ id: 'p1', title: 't', command: 'bash', args: [], cwd: '/', status: 'running', pid: 7 }]),
      );
    const list = await Pty.listKortixPty(BASE);
    expect(last().url).toBe('http://sbx.test/kortix/pty');
    expect(last().method).toBe('GET');
    expect(list).toEqual([{ id: 'p1', title: 't', command: 'bash', args: [], cwd: '/', status: 'running', pid: 7 }]);
  });

  test('listKortixPty strips a trailing slash on the base url', async () => {
    await Pty.listKortixPty('http://sbx.test/');
    expect(last().url).toBe('http://sbx.test/kortix/pty');
  });

  test('createKortixPty POSTs the spawn body', async () => {
    await Pty.createKortixPty(BASE, { command: 'bash' });
    expect(last().method).toBe('POST');
    expect(JSON.parse(last().body!)).toEqual({ command: 'bash' });
  });

  test('a non-2xx body with only `error` surfaces that text', async () => {
    nextResponse = () => new Response(JSON.stringify({ error: 'terminal quota' }), { status: 503 });
    await expect(Pty.listKortixPty(BASE)).rejects.toThrow('terminal quota');
  });

  test('a non-2xx body with only `message` surfaces that text', async () => {
    nextResponse = () => new Response(JSON.stringify({ message: 'pty registry full' }), { status: 502 });
    await expect(Pty.listKortixPty(BASE)).rejects.toThrow('pty registry full');
  });

  test('a non-2xx empty body falls back to the per-operation message', async () => {
    nextResponse = () => new Response('', { status: 500, statusText: '' });
    await expect(Pty.listKortixPty(BASE)).rejects.toThrow('Failed to list terminals');
  });

  test('listKortixPty("") refuses to fetch and never cross-wires to a global runtime', async () => {
    await expect(Pty.listKortixPty('')).rejects.toThrow('Server URL not ready');
    expect(calls).toHaveLength(0);
  });
});

describe('triggers request message order (pinned before the sandbox-request core)', () => {
  test('a non-2xx body with only `message` surfaces that text', async () => {
    nextResponse = () => new Response(JSON.stringify({ message: 'trigger paused' }), { status: 409 });
    await expect(Triggers.triggersRequest(BASE, '/t-1')).rejects.toThrow('trigger paused');
  });
});

describe('the two deliberate behavior changes of the sandbox-request core', () => {
  test('triggersRequest: a non-2xx response with an empty body rejects with the status, not a SyntaxError', async () => {
    nextResponse = () => new Response('', { status: 503, statusText: '' });
    await expect(Triggers.triggersRequest(BASE, '')).rejects.toThrow('Request failed with 503');
  });

  test('env.listEnv("") rejects with instanceof RuntimeNotReadyError', async () => {
    const error = await Env.listEnv('').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RuntimeNotReadyError);
    expect(calls).toHaveLength(0);
  });

  test('pty.listKortixPty("") rejects with instanceof RuntimeNotReadyError', async () => {
    const error = await Pty.listKortixPty('').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RuntimeNotReadyError);
    expect(calls).toHaveLength(0);
  });
});
