import { afterEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configureKortix, type SessionProviderSecretPool } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlTestProvider } from '../../test-utils/intl';
import { defaultUiMessages as messages } from '../../i18n';
import { SessionIdsProvider } from '../../providers/session-ids';
import {
  SubscriptionSwitcher,
  peakBlockingWindow,
  subscriptionProviderOf,
} from './subscription-switcher';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const login = (id: string, extra: Record<string, unknown> = {}) => ({
  secret_id: id,
  provider_id: 'claude-agent',
  consumer: 'llm_gateway',
  strategy: 'broker',
  access_mode: 'project',
  granted_user_ids: [],
  label: id,
  can_use: true,
  active: true,
  ...extra,
});

/** A login whose provider already reported a weekly window. */
const withWeekly = (id: string, usedPercent: number, limited = false) =>
  login(id, {
    usage: {
      windows: [{ id: 'weekly', window_minutes: 10080, used_percent: usedPercent, resets_at: null }],
      limited,
      observed_at: '2026-11-11T00:00:00Z',
      source: 'usage_endpoint',
    },
    provider_account: { email: `${id}@example.test`, plan: 'max' },
  });

interface Harness {
  client: QueryClient;
  /** Every fetch the UI made: method, path, and the parsed JSON body. */
  calls: Array<{ method: string; path: string; body: unknown }>;
}

/**
 * Seeds the reads the pane shares with Customize → Models and the
 * provider-keys row: the account's logins, the session's pool, the session
 * row. A PUT the test drives rewrites the pool the stub serves, so the
 * refetch after a save reads the new state.
 */
function harness(options: {
  logins?: unknown[];
  pools?: SessionProviderSecretPool[];
  canEdit?: boolean;
  sessionId?: string | null;
} = {}): Harness {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const calls: Harness['calls'] = [];
  const sessionId = options.sessionId === undefined ? 's' : options.sessionId;
  const state = { pools: options.pools ?? [], canEdit: options.canEdit ?? true };
  client.setQueryData(['provider-pool-project', 'p'], { project: { account_id: 'account' } });
  client.setQueryData(['account-secret-resources', 'account', 'p'], { secrets: options.logins ?? [] });
  if (sessionId) {
    client.setQueryData(['session-provider-secret-pools', 'p', sessionId], {
      pools: state.pools, can_edit: state.canEdit, personal_user_id: 'u1', personal_keys_reason: null,
    });
    client.setQueryData(qk.project.session('p', sessionId), { session_id: sessionId, visibility: 'private', created_by: 'u1' });
  }
  globalThis.fetch = mock(async (url: unknown, init: RequestInit = {}) => {
    const path = String(url).replace(/^http:\/\/switcher\.test/, '');
    const method = init.method ?? 'GET';
    calls.push({ method, path, body: typeof init.body === 'string' ? JSON.parse(init.body) : null });
    if (method === 'PUT') {
      const saved = (init.body ? JSON.parse(String(init.body)).secret_ids : []) as string[];
      state.pools = [{ provider_id: 'claude-agent', configured: true, secret_ids: saved }];
      return Response.json(state.pools[0]);
    }
    if (path.includes('/provider-secret-pools')) {
      return Response.json({ pools: state.pools, can_edit: state.canEdit, personal_user_id: 'u1', personal_keys_reason: null });
    }
    if (path.startsWith('/accounts/')) return Response.json({ secrets: options.logins ?? [] });
    if (path.startsWith('/projects/')) return Response.json({ project: { account_id: 'account' } });
    return Response.json({});
  }) as unknown as typeof fetch;
  return { client, calls };
}

function tree(client: QueryClient, sessionId: string | null, children: React.ReactNode) {
  return (
    <IntlTestProvider locale="en" timeZone="UTC" messages={messages}>
      <QueryClientProvider client={client}>
        <SessionIdsProvider projectId="p" sessionId={sessionId ?? undefined}>{children}</SessionIdsProvider>
      </QueryClientProvider>
    </IntlTestProvider>
  );
}

function mountStatic(client: QueryClient, sessionId: string | null): string {
  const html = renderToStaticMarkup(tree(client, sessionId, <SubscriptionSwitcher providerId="claude-agent" />));
  client.clear();
  return html;
}

function radios(renderer: ReactTestRenderer) {
  return renderer.root.findAll((node) => node.props.role === 'radio');
}

configureKortix({ backendUrl: 'http://switcher.test', getToken: async () => 'test-token' }, { global: true });

describe('SubscriptionSwitcher', () => {
  test('a Claude subscription model resolves to the claude-agent pool; a ChatGPT one to codex', () => {
    expect(subscriptionProviderOf({ providerID: 'claude-agent', modelID: 'opus' })).toBe('claude-agent');
    expect(subscriptionProviderOf({ providerID: 'kortix', modelID: 'codex/gpt-6.1-sol' })).toBe('codex');
    expect(subscriptionProviderOf({ providerID: 'kortix', modelID: 'glm-5.3-flash' })).toBeNull();
  });

  test('the pane usage is the fullest window still in force that gates the login', () => {
    const now = Date.parse('2026-11-11T12:00:00Z');
    const usage = (windows: Array<{ id: string; used_percent: number; resets_at: string | null }>) =>
      peakBlockingWindow(
        { windows: windows.map((w) => ({ window_minutes: null, ...w })), limited: false, observed_at: '', source: 'usage_endpoint' },
        now,
      );
    // Code review never gates a call; the plain weekly window does.
    expect(usage([{ id: 'code_review_weekly', used_percent: 90, resets_at: null }, { id: 'weekly', used_percent: 42, resets_at: null }])?.id).toBe('weekly');
    // A window whose reset passed no longer counts.
    expect(usage([{ id: 'weekly', used_percent: 99, resets_at: '2026-11-11T00:00:00Z' }, { id: 'five_hour', used_percent: 10, resets_at: null }])?.id).toBe('five_hour');
    expect(usage([{ id: 'extra_usage', used_percent: 99, resets_at: null }])).toBeNull();
    expect(peakBlockingWindow(null, now)).toBeNull();
  });

  test('renders nothing for a pre-create composer (no session: no pool to switch)', () => {
    const { client } = harness({ sessionId: null, logins: [withWeekly('login-a', 10)] });
    expect(mountStatic(client, null)).toBe('');
  });

  test('renders the connected logins with plan, weekly usage, and the unpinned default', () => {
    const { client } = harness({ logins: [withWeekly('login-a', 42), login('login-b')] });
    const html = mountStatic(client, 's');
    expect(html).toContain('Subscription');
    expect(html).toContain('login-a');
    expect(html).toContain('login-a@example.test');
    expect(html).toContain('Max');
    expect(html).toContain('Weekly · 42%');
    expect(html).toContain('Workspace default');
    expect(html).toContain('Rotates through every connected subscription');
    // The pool holds no pin: the default row is the checked one.
    expect(html).toMatch(/aria-checked="true"[^>]*>[\s\S]*?Workspace default/);
  });

  test('a limited login reads as a limit, not a percent', () => {
    const { client } = harness({ logins: [withWeekly('login-a', 96, true)] });
    const html = mountStatic(client, 's');
    expect(html).toContain('Limit reached');
    expect(html).not.toContain('Weekly · 96%');
  });

  test('the pool pin names the checked login', () => {
    const { client } = harness({
      logins: [withWeekly('login-a', 42), withWeekly('login-b', 4)],
      pools: [{ provider_id: 'claude-agent', configured: true, secret_ids: ['login-b'] }],
    });
    const html = mountStatic(client, 's');
    expect(html.match(/aria-checked="true"/g)?.length).toBe(1);
    expect(html).toMatch(/aria-checked="true"[^>]*>[\s\S]{0,600}?login-b/);
  });

  test('REGRESSION: picking a login pins the session pool to it — the state a turn resolves through', async () => {
    const { client, calls } = harness({ logins: [withWeekly('login-a', 42), withWeekly('login-b', 4)] });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(tree(client, 's', <SubscriptionSwitcher providerId="claude-agent" />));
    });
    expect(radios(renderer)).toHaveLength(3);
    const pin = radios(renderer)[2];
    await act(async () => { pin?.props.onClick(); });
    const put = calls.find((call) => call.method === 'PUT');
    expect(put?.path).toBe('/workspaces/p/sessions/s/provider-secret-pools/claude-agent');
    expect(put?.body).toEqual({ secret_ids: ['login-b'] });
    // The saved pool is the checked row: the pane reads the server state back.
    const checked = radios(renderer).filter((row) => row.props['aria-checked'] === true);
    expect(checked).toHaveLength(1);
    renderer.unmount();
    client.clear();
  });

  test('REGRESSION: the default row clears the pin, handing the provider back to rotation', async () => {
    const { client, calls } = harness({
      logins: [withWeekly('login-a', 42)],
      pools: [{ provider_id: 'claude-agent', configured: true, secret_ids: ['login-a'] }],
    });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(tree(client, 's', <SubscriptionSwitcher providerId="claude-agent" />));
    });
    const reset = radios(renderer)[0];
    await act(async () => { reset?.props.onClick(); });
    const put = calls.find((call) => call.method === 'PUT');
    expect(put?.path).toBe('/workspaces/p/sessions/s/provider-secret-pools/claude-agent');
    expect(put?.body).toEqual({ secret_ids: null });
    renderer.unmount();
    client.clear();
  });

  test('a viewer who cannot edit the pool sees the rows locked with the reason', () => {
    const { client } = harness({ logins: [withWeekly('login-a', 42)], canEdit: false });
    const html = mountStatic(client, 's');
    expect(html).toMatch(/role="radio"[^>]*disabled/);
    expect(html).toContain('Only the session owner or a workspace manager');
  });
});
