// The one-retry rule for server fetches: a GET or HEAD whose connection fails
// before any response is sent again once; a write, an aborted request and any
// other failure are not.
import { describe, expect, test } from 'bun:test';

import { isStaleConnectionError, withStaleConnectionRetry } from './server-fetch-retry';

function fetchFailed(code: string): TypeError {
  const cause = Object.assign(new Error('other side closed'), { code });
  return new TypeError('fetch failed', { cause });
}

/** A fetch that throws `failures` in order, then answers 200. */
function scripted(failures: unknown[]) {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    const next = failures.shift();
    if (next !== undefined) throw next;
    return new Response('ok', { status: 200 });
  };
  return { calls, fetch: withStaleConnectionRetry(impl as typeof fetch) };
}

describe('isStaleConnectionError', () => {
  test('matches undici socket and reset causes', () => {
    expect(isStaleConnectionError(fetchFailed('UND_ERR_SOCKET'))).toBe(true);
    expect(isStaleConnectionError(fetchFailed('ECONNRESET'))).toBe(true);
  });

  test('does not match a timeout, a DNS failure or a plain error', () => {
    expect(isStaleConnectionError(fetchFailed('UND_ERR_CONNECT_TIMEOUT'))).toBe(false);
    expect(isStaleConnectionError(fetchFailed('ENOTFOUND'))).toBe(false);
    expect(isStaleConnectionError(new Error('boom'))).toBe(false);
    expect(isStaleConnectionError(new TypeError('fetch failed'))).toBe(false);
  });
});

describe('withStaleConnectionRetry', () => {
  test('sends a GET again once after a stale socket and returns the second response', async () => {
    const { calls, fetch } = scripted([fetchFailed('UND_ERR_SOCKET')]);
    const response = await fetch('https://api.example.test/v1/items');
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  test('retries a bodyless GET Request object', async () => {
    const { calls, fetch } = scripted([fetchFailed('ECONNRESET')]);
    await fetch(new Request('https://api.example.test/v1/items'));
    expect(calls).toHaveLength(2);
  });

  test('gives up after one retry and rethrows the second failure', async () => {
    const second = fetchFailed('ECONNRESET');
    const { calls, fetch } = scripted([fetchFailed('UND_ERR_SOCKET'), second]);
    await expect(fetch('https://api.example.test/v1/items')).rejects.toBe(second);
    expect(calls).toHaveLength(2);
  });

  test('never sends a POST twice', async () => {
    const failure = fetchFailed('UND_ERR_SOCKET');
    const { calls, fetch } = scripted([failure]);
    await expect(
      fetch('https://api.example.test/v1/items', { method: 'POST', body: '{}' }),
    ).rejects.toBe(failure);
    expect(calls).toHaveLength(1);
  });

  test('does not retry a GET with a body or an aborted request', async () => {
    const withBody = scripted([fetchFailed('UND_ERR_SOCKET')]);
    await expect(
      withBody.fetch('https://api.example.test/v1/items', { method: 'GET', body: 'x' }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(withBody.calls).toHaveLength(1);

    const controller = new AbortController();
    controller.abort();
    const abortedCall = scripted([fetchFailed('UND_ERR_SOCKET')]);
    await expect(
      abortedCall.fetch('https://api.example.test/v1/items', { signal: controller.signal }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(abortedCall.calls).toHaveLength(1);
  });

  test('does not retry an error that is not a connection failure', async () => {
    const failure = fetchFailed('ENOTFOUND');
    const { calls, fetch } = scripted([failure]);
    await expect(fetch('https://api.example.test/v1/items')).rejects.toBe(failure);
    expect(calls).toHaveLength(1);
  });
});
