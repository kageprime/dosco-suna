import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { useSandboxConnectionStore } from '../browser/stores/sandbox-connection-store';
import { configureKortix } from '../core/http/config';
import { setCurrentRuntime } from '../core/session/current-runtime';
import { useRuntimeConfig } from './use-runtime-config';

/**
 * The answer the sandbox proxy gives AFTER its own ~50 s retry budget is
 * exhausted against a dead box (KRTX-4755): 4 connect attempts, then this.
 */
const PROXY_GIVE_UP_502 = {
  error: 'sandbox upstream unreachable',
  port: 8000,
  status: 502,
  hop: 'daemon',
};

const originalFetch = globalThis.fetch;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  setCurrentRuntime(null);
  useSandboxConnectionStore.setState({ status: 'connecting', healthy: null });
});

/**
 * A runtime config read must settle on the FIRST proxy answer, never replay:
 * the proxy already spent its full connect budget, so every client retry
 * re-burns it (one poll became four sequential 50-s burns). The read is
 * immutable, so refetching stays with focus, reconnect and remount.
 */
describe('useRuntimeConfig against a dead box', () => {
  test('a proxy give-up settles the read: one request, no replay, no data', async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      requests.push(url);
      if (url.endsWith('/global/config')) {
        return Response.json(PROXY_GIVE_UP_502, {
          status: 502,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
    setCurrentRuntime('http://test.local/v1/p/sbx_test/8000');
    useSandboxConnectionStore.setState({ status: 'connected', healthy: true });

    // The web app's global default: three retries of a 5xx (the thrown error
    // carries no status, so the 4xx short-circuit cannot classify it).
    const client = new QueryClient({ defaultOptions: { queries: { retry: 3, retryDelay: 1 } } });
    let root!: ReactTestRenderer;
    let reads = 0;
    let settledError: unknown;
    let settledData: unknown;
    function Probe() {
      const { data, error } = useRuntimeConfig();
      reads++;
      if (error) settledError = error;
      if (data !== undefined) settledData = data;
      return null;
    }
    try {
      await act(async () => {
        root = create(
          React.createElement(QueryClientProvider, { client }, React.createElement(Probe)),
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(requests.filter((url) => url.endsWith('/global/config'))).toHaveLength(1);
      expect(reads).toBeGreaterThan(0);
      expect(settledData).toBeUndefined();
      expect(settledError).toBeInstanceOf(Error);
    } finally {
      await act(async () => root?.unmount());
      client.clear();
    }
  });
});
