import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

// A sign-in window the person closes before the provider answers. The account
// row exists by then: the list must show it without a reload.
const POPUP_CLOSED = 'The connection popup closed before authorization completed.';

const sdk = await import('@kortix/sdk');
mock.module('@kortix/sdk', () => ({
  ...sdk,
  reconcileMemberConnection: async () => ({ connection_id: 'mine-1' }),
  pipedreamConnectConnection: async () => ({ connected: false, connect_link_url: 'https://provider.example.test' }),
  pipedreamFinalizeConnection: async () => ({ connected: false }),
  connectionSignInSteps: () => ({ start: async () => ({ connected: false }), finalize: async () => ({ connected: false }) }),
}));
mock.module('./use-connect-link', () => ({
  runConnectLinkFlow: async (start: () => Promise<unknown>) => {
    await start();
    throw new Error(POPUP_CLOSED);
  },
}));
const toasts: string[] = [];
const uiToastMock = () => ({
  successToast: () => undefined,
  errorToast: (message: string) => toasts.push(message),
});
mock.module('../../../primitives/toast', uiToastMock);
mock.module('../../../i18n', () => ({
  useTranslations: () => Object.assign((key: string) => key, { raw: (key: string) => key }),
}));

const { usePipedreamConnectMember } = await import('./use-pipedream-connect-member');
const { usePipedreamConnectProject } = await import('./use-pipedream-connect-project');
const { useFinishSignIn } = await import('./use-finish-sign-in');

/** Run one hook's sign-in to its failure; return the query keys it invalidated. */
async function invalidatedAfterClosedPopup(run: (onConnected: () => void) => () => Promise<unknown>) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidated: unknown[] = [];
  const original = client.invalidateQueries.bind(client);
  client.invalidateQueries = ((filters?: Parameters<typeof original>[0]) => {
    invalidated.push(filters?.queryKey);
    return original(filters);
  }) as typeof client.invalidateQueries;
  let start = null as (() => Promise<unknown>) | null;
  let connected = 0;
  function Probe() {
    start = run(() => connected++);
    return null;
  }
  await act(async () => {
    create(createElement(QueryClientProvider, { client }, createElement(Probe)));
  });
  await act(async () => {
    await start!().catch(() => undefined);
  });
  return { invalidated, connected };
}

describe('a closed sign-in window still refreshes the account list', () => {
  test('own account (Only you)', async () => {
    const { invalidated, connected } = await invalidatedAfterClosedPopup((onConnected) => {
      const hook = usePipedreamConnectMember('p1', 'gmail', onConnected);
      return () => hook.mutateAsync({ label: 'Work' });
    });
    expect(invalidated).toContainEqual(['connections', 'p1']);
    // Not connected: the caller's "connected" step does not run.
    expect(connected).toBe(0);
    expect(toasts).toContain(POPUP_CLOSED);
  });

  test('shared account', async () => {
    const { invalidated } = await invalidatedAfterClosedPopup((onConnected) => {
      const hook = usePipedreamConnectProject('p1', 'gmail', onConnected);
      return () => hook.mutateAsync({ label: 'Team' });
    });
    expect(invalidated).toContainEqual(['connections', 'p1']);
  });

  test('finishing an unfinished sign-in', async () => {
    const { invalidated } = await invalidatedAfterClosedPopup((onConnected) => {
      const hook = useFinishSignIn('p1', 'gmail', onConnected);
      return () => hook.mutateAsync({ connection_id: 'mine-1', owner_type: 'member' });
    });
    expect(invalidated).toContainEqual(['connections', 'p1']);
  });
});
