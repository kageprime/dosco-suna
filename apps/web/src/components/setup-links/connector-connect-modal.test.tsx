// KRTX-5196: the named-account connect dialog took HTTP success from the link
// finalize as a finished sign-in. The server answers 200 `{connected:false}`
// while the provider has not confirmed the account, and the dialog still showed
// "connected" and told the chat card. Only `connected:true` may complete it.
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConnectorSetupLinkFinalize, ConnectorSetupLinkInfo } from '@kortix/sdk';
import { Window } from 'happy-dom';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const win = new Window({ width: 1440, height: 900 });
Object.assign(globalThis, {
  window: win,
  document: win.document,
  navigator: win.navigator,
  location: win.location,
  getComputedStyle: win.getComputedStyle.bind(win),
});
for (const key of Object.getOwnPropertyNames(win)) {
  // Base UI dispatches happy-dom's own event classes, not Bun's.
  if (/^[A-Z]/.test(key) && (!(key in globalThis) || key.endsWith('Event'))) {
    Object.assign(globalThis, { [key]: Reflect.get(win, key) });
  }
}

const info: ConnectorSetupLinkInfo = {
  project_id: 'project-1',
  project_name: 'Synthetic project',
  label: 'Synthetic CRM',
  owner: 'me',
  slug: 'synthetic-crm',
  app: 'synthetic-crm',
  name: 'Synthetic CRM',
  icon_url: null,
  expires_at: '2099-01-01T00:00:00.000Z',
};

const add = mock(async () => ({ connectionId: 'connection-1' }));
const finalize = mock(
  async (_token: string, _options: unknown, _input: { connectionId?: string }): Promise<ConnectorSetupLinkFinalize> => ({
    connected: false,
  }),
);

const sdk = await import('@kortix/sdk');
mock.module('@kortix/sdk', () => ({
  ...sdk,
  finalizeConnectorSetupLink: finalize,
  listConnections: async () => ({ connections: [] }),
}));
const sdkReact = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({ ...sdkReact, useProjectAccountId: () => 'account-1' }));
const workspace = await import('@kortix/ui/workspace');
mock.module('@kortix/ui/workspace', () => ({
  ...workspace,
  useProjectCan: () => ({ allowed: true, isLoading: false }),
}));
const linkInfo = await import('@kortix/ui/markdown/setup-links/connector-link-info');
mock.module('@kortix/ui/markdown/setup-links/connector-link-info', () => ({
  ...linkInfo,
  useConnectorLinkInfo: () => info,
}));
mock.module('@kortix/ui/internal/hooks/connectors/use-add-managed-account', () => ({
  useAddManagedAccount: () => ({ isPending: false, add }),
}));
mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'member@example.test' } }),
}));

// After the window exists: react-dom decides at load whether the DOM fires events.
const { createRoot } = await import('react-dom/client');
const { ConnectorConnectModal } = await import('./connector-connect-modal');

let root: Root | null = null;
let onConnected = mock(() => {});

beforeEach(() => {
  add.mockClear();
  finalize.mockReset();
  onConnected = mock(() => {});
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function modal(open: boolean) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <ConnectorConnectModal
        token="link-token"
        open={open}
        onOpenChange={() => {}}
        onConnected={onConnected}
        fallbackName="Synthetic CRM"
      />
    </QueryClientProvider>
  );
}

async function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const view = createRoot(host);
  root = view;
  await act(async () => view.render(modal(true)));
  // Let the connections list resolve so the Connect button enables.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return view;
}

function connectButton(): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll('button')).find((node) =>
    node.textContent?.includes('Connect Synthetic CRM'),
  );
  if (!button) throw new Error(`no Connect button in: ${document.body.textContent}`);
  return button;
}

async function clickConnect() {
  const button = connectButton();
  expect(button.disabled).toBe(false);
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const landed = () => document.querySelector('[data-testid="connector-connect-landed"]');
const text = () => document.body.textContent ?? '';

test('a pending finalize renders no connected state and never reports the account connected', async () => {
  finalize.mockImplementation(async () => ({ connected: false }));
  await mount();
  await clickConnect();

  expect(finalize).toHaveBeenCalledTimes(1);
  expect(landed()).toBeNull();
  expect(text()).not.toContain('Synthetic CRM connected');
  expect(text()).toContain('Sign-in not finished');
  expect(onConnected).toHaveBeenCalledTimes(0);
  // Recoverable: the retry button is back.
  expect(connectButton().disabled).toBe(false);
});

test('a retry after a pending finalize lands the returned account once, on the same connection', async () => {
  finalize.mockImplementationOnce(async () => ({ connected: false }));
  finalize.mockImplementationOnce(async () => ({
    connected: true,
    connected_as: 'person@example.test',
    connection_id: 'connection-1',
    label: 'Synthetic CRM (server)',
  }));
  await mount();
  await clickConnect();
  await clickConnect();

  expect(add).toHaveBeenCalledTimes(1);
  expect(finalize).toHaveBeenCalledTimes(2);
  expect(finalize.mock.calls.map((call) => call[2].connectionId)).toEqual(['connection-1', 'connection-1']);
  expect(landed()?.textContent).toContain('Synthetic CRM (server)');
  expect(text()).toContain('Connected as person@example.test');
  expect(onConnected).toHaveBeenCalledTimes(1);
});

test('a rejected finalize is recoverable and the retry reuses the authorized account', async () => {
  finalize.mockImplementationOnce(async () => {
    throw new Error('Failed to finalize connect');
  });
  finalize.mockImplementationOnce(async () => ({ connected: true, connected_as: null }));
  await mount();
  await clickConnect();

  expect(text()).toContain('Failed to finalize connect');
  expect(landed()).toBeNull();
  expect(onConnected).toHaveBeenCalledTimes(0);

  await clickConnect();
  expect(add).toHaveBeenCalledTimes(1);
  expect(finalize.mock.calls.map((call) => call[2].connectionId)).toEqual(['connection-1', 'connection-1']);
  expect(landed()?.textContent).toContain('Synthetic CRM');
  expect(onConnected).toHaveBeenCalledTimes(1);
});

test('closing the dialog before finalize answers reports nothing', async () => {
  let answer: (value: ConnectorSetupLinkFinalize) => void = () => {};
  finalize.mockImplementation(
    () =>
      new Promise<ConnectorSetupLinkFinalize>((resolve) => {
        answer = resolve;
      }),
  );
  const view = await mount();
  await clickConnect();
  expect(finalize).toHaveBeenCalledTimes(1);

  await act(async () => view.render(modal(false)));
  await act(async () => {
    answer({ connected: true, connected_as: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(onConnected).toHaveBeenCalledTimes(0);
});
