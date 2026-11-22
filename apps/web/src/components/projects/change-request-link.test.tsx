import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { notifyManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configureKortix } from '@kortix/sdk';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../../../translations/en.json';

const win = new Window({ url: 'http://kortix.test/workspaces/w/change-requests/233?tag=a&tag=b&id=wrong#files' });
Object.assign(globalThis, { window: win, document: win.document, navigator: win.navigator, IS_REACT_ACT_ENVIRONMENT: true });
notifyManager.setScheduler((callback) => callback());
let navigations: string[] = [];
const router = { replace: (path: string) => { navigations.push(path); } };
mock.module('next/navigation', () => ({ useRouter: () => router, useSearchParams: () => new URLSearchParams(win.location.search) }));
mock.module('./project-pending-screen', () => ({ ProjectPendingScreen: () => <span>Opening</span> }));
const { ChangeRequestLink } = await import('./change-request-link');
const originalFetch = globalThis.fetch;
const requests: string[] = [];
let status = 200;
const C = 'bbbbbbbb-2222-4222-8222-222222222222';
configureKortix({ backendUrl: 'http://api.kortix.test/v1', getToken: async () => 'synthetic-token' });
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let qc: QueryClient | undefined;

async function mount(workspaceId: string, crRef: string) {
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return Response.json(status === 200 ? { change_request: { cr_id: C } } : { error: 'Not found' }, { status });
  }, { preconnect: originalFetch.preconnect });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  qc = client;
  await act(async () => {
    root?.render(<NextIntlClientProvider locale="en" messages={messages}><QueryClientProvider client={client}><ChangeRequestLink workspaceId={workspaceId} crRef={crRef} /></QueryClientProvider></NextIntlClientProvider>);
  });
  await act(async () => { await qc?.refetchQueries(); });
}

afterEach(() => {
  act(() => root?.unmount());
  qc?.clear(); host?.remove(); requests.length = 0; navigations = []; status = 200;
});
afterAll(() => { globalThis.fetch = originalFetch; mock.restore(); });

test('a display number resolves through the scoped SDK HTTP read then selects its UUID, preserving query/hash', async () => {
  await mount('synthetic-workspace', '233');
  expect(requests[0]).toBe('http://api.kortix.test/v1/workspaces/synthetic-workspace/change-requests/233');
  expect(navigations).toContain(`/workspaces/synthetic-workspace/review?id=cr%3A${C}&tag=a&tag=b#files`);
});

test('UUID navigation preserves hash and repeated query without a CR data request', async () => {
  await mount('synthetic-workspace', C);
  expect(requests).toEqual([]);
  expect(navigations).toContain(`/workspaces/synthetic-workspace/review?id=cr%3A${C}&tag=a&tag=b#files`);
});

test.each([403, 404, 500])('a refused or failed read (%s) never navigates to another workspace or Review', async (code) => {
  status = code;
  await mount('other-workspace', '233');
  expect(requests.every((url) => url.includes('/workspaces/other-workspace/change-requests/233'))).toBe(true);
  expect(navigations).toEqual([]);
  expect(document.body.textContent).toContain('Could not open change request');
});
