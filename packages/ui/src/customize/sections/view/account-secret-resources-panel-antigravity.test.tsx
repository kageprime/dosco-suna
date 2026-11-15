/**
 * Google Antigravity pooled accounts connect with the same guided OAuth flow
 * as ChatGPT and Claude, plus a collapsible fallback for pasting raw OAuth JSON
 * or a `ya29.` bearer token.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import type { Root } from 'react-dom/client';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const win = new Window({ width: 1440, height: 900 });
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.location = win.location;
globals.history = win.history;
globals.localStorage = win.localStorage;
globals.getComputedStyle = win.getComputedStyle.bind(win);
globals.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
globals.cancelAnimationFrame = (id: number) => clearTimeout(id);
for (const key of Object.getOwnPropertyNames(win)) {
  if (/^[A-Z]/.test(key) && !(key in globals)) globals[key] = Reflect.get(win, key);
}
for (const key of ['Event', 'CustomEvent', 'FocusEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent']) {
  globals[key] = Reflect.get(win, key);
}

const { createRoot } = await import('react-dom/client');

const ME = 'user-1';
const starts: unknown[] = [];
const polls: unknown[] = [];
const creates: unknown[] = [];
const opened: string[] = [];

const sdk = await import('@kortix/sdk');
mock.module('@kortix/sdk', () => ({
  ...sdk,
  listAccountMembers: async () => [],
  startProjectProviderOAuth: async (projectId: string, provider: string, input: unknown) => {
    starts.push([projectId, provider, input]);
    return {
      flow_id: 'flow-ag',
      verification_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=s1',
      authorize_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=s1',
      mode: 'redirect',
      user_code: '',
      expires_at: Date.now() + 60_000,
      interval_ms: 1000,
    };
  },
  pollProjectProviderOAuth: async (projectId: string, provider: string, flowId: string, redirectUrl?: string) => {
    polls.push([projectId, provider, flowId, redirectUrl]);
    return {
      status: 'success',
      credential: {
        provider_id: 'antigravity',
        secret_id: 'secret-ag',
        label: 'Personal Ultra',
        expires_in_ms: 3600_000,
        updated_at: '2026-11-15T00:00:00.000Z',
      },
    };
  },
  createAccountSecretResource: async (accountId: string, body: Record<string, unknown>) => {
    creates.push([accountId, body]);
    return { secret_id: 'secret-manual', label: String(body.label), status: 'ok' };
  },
}));
const sdkReact = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...sdkReact,
  refreshProjectProviderState: () => undefined,
  useAccountSecretResources: () => ({
    data: { secrets: [] }, isSuccess: true, isLoading: false, isError: false, isFetching: false,
    dataUpdatedAt: Date.parse('2026-11-15T00:00:00.000Z'), refetch: async () => ({ data: { secrets: [] } }),
  }),
}));
const realUiProvider = { ...(await import('../../../providers/ui-provider')) };
mock.module('../../../providers/ui-provider', () => ({ ...realUiProvider, useUiViewer: () => ({ id: ME }) }));
const projectCan = await import('../../../internal/lib/use-project-can');
mock.module('../../../internal/lib/use-project-can', () => ({ ...projectCan, useProjectCan: () => ({ allowed: true }) }));

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { IntlTestProvider: NextIntlClientProvider } = await import('../../../test-utils/intl');
const messages = (await import('../../../../../../apps/web/translations/en.json')).default;
const { AccountSecretResourcesPanel } = await import('./account-secret-resources-panel');

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  (window as unknown as { open: (url: string) => unknown }).open = (url: string) => {
    opened.push(url);
    return { closed: false, close: () => undefined, location: { set href(next: string) { opened.push(next); } } };
  };
  act(() => {
    root!.render(
      <QueryClientProvider client={new QueryClient()}>
        <NextIntlClientProvider locale="en" messages={messages} onError={() => {}}>
          <AccountSecretResourcesPanel
            accountId="account-1"
            projectId="p1"
            providerId="antigravity"
            providerName="Google Antigravity"
            envVar="ANTIGRAVITY_AUTH_JSON"
            canWrite
            oauth={{ projectId: 'p1', onConnected: () => undefined, kind: 'antigravity' }}
          />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null; host = null;
  starts.length = 0; polls.length = 0; creates.length = 0; opened.length = 0;
  document.body.innerHTML = '';
});

const settle = (ms = 0) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
function typeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event('input', { bubbles: true }));
  });
}

describe('Google Antigravity account connection', () => {
  test('opens Google OAuth and completes from the pasted localhost callback URL', async () => {
    mount();
    expect(document.body.textContent).toContain('No Google Antigravity accounts yet');
    act(() => button('Sign in with Google')!.click());
    await settle();
    typeValue(document.querySelector('#provider-key-label-antigravity') as HTMLInputElement, 'Personal Ultra');
    act(() => button('Connect account')!.click());
    await settle(10);
    expect(starts).toEqual([['p1', 'google', { resourceLabel: 'Personal Ultra', sharing: { mode: 'project' } }]]);
    expect(opened).toEqual(['about:blank', 'https://accounts.google.com/o/oauth2/v2/auth?state=s1']);

    const input = document.querySelector('[data-provider-antigravity] input') as HTMLInputElement;
    expect(input).toBeTruthy();
    typeValue(input, 'http://localhost:51121/oauth-callback?code=4/abc&state=s1');
    act(() => (document.querySelector('[data-provider-antigravity] form') as HTMLFormElement).requestSubmit());
    await settle(10);
    expect(polls).toEqual([['p1', 'google', 'flow-ag', 'http://localhost:51121/oauth-callback?code=4/abc&state=s1']]);
  });

  test('manual fallback inside the step saves pasted OAuth JSON with llm_gateway broker flags', async () => {
    mount();
    act(() => button('Sign in with Google')!.click());
    await settle();
    typeValue(document.querySelector('#provider-key-label-antigravity') as HTMLInputElement, 'Manual Cred');
    act(() => button('Connect account')!.click());
    await settle(10);

    const textarea = document.querySelector('[data-provider-antigravity] textarea') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    typeValue(textarea, '{"access_token":"ya29.a0AfH6SMC1234567890abcdefghijklmnop","refresh_token":"1//ref-1"}');
    const forms = document.querySelectorAll('[data-provider-antigravity] form');
    act(() => (forms[1] as HTMLFormElement).requestSubmit());
    await settle(10);
    expect(creates).toEqual([[
      'account-1',
      expect.objectContaining({
        project_id: 'p1',
        provider_id: 'antigravity',
        name: 'ANTIGRAVITY_AUTH_JSON',
        label: 'Manual Cred',
        consumer: 'llm_gateway',
        strategy: 'broker',
      }),
    ]]);
  });
});
