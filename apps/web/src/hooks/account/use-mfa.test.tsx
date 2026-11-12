import { beforeEach, expect, mock, test } from 'bun:test';
import { createElement, useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

/**
 * Characterization for the unified MFA cache (KRTX-4748): the phone-
 * verification mutations and the settings Security tab must read and
 * invalidate ONE cache entry for the factor list and one for the `aal`
 * level — previously the two surfaces carried two drifted copies of both
 * (the phone page read the same service under its own factor key), so a
 * factor enrolled on the phone page never reached the Security tab.
 */

const calls = { listFactors: 0, getAAL: 0, enrollPhone: 0 };
let probe: {
  mfaFactors?: unknown;
  standaloneFactors?: unknown;
  mfaSessionVerified?: boolean;
} = {};

mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({ user: { id: 'user-1' }, isLoading: false }),
}));
mock.module('@/lib/supabase/mfa', () => ({
  supabaseMFAService: {
    listFactors: async () => {
      calls.listFactors++;
      return {
        factors: [{ id: 'factor-1', factor_type: 'phone', status: 'verified', phone: '+15550001111' }],
      };
    },
    getAAL: async () => {
      calls.getAAL++;
      return { current_level: 'aal2', next_level: 'aal2', factors: [] };
    },
    enrollPhoneNumber: async (data: { friendly_name: string; phone_number: string }) => {
      calls.enrollPhone++;
      return { id: 'factor-2', friendly_name: data.friendly_name, phone_number: data.phone_number };
    },
    unenrollFactor: async () => ({}),
    createChallenge: async () => ({ id: 'challenge-1' }),
    verifyChallenge: async () => ({ success: true }),
    challengeAndVerify: async () => ({ success: true }),
  },
  mfaChallengeRequired: () => false,
}));
mock.module('@/lib/auth-token', () => ({ invalidateTokenCache: () => {} }));
mock.module('@/i18n/use-translations', () => ({
  useTranslations: () => ({ raw: (key: string) => key, t: (key: string) => key }),
}));
mock.module('@kortix/ui/toast', () => ({ errorToast: () => {}, successToast: () => {} }));

const { useMfa, useMfaFactors, useEnrollPhoneNumber, MFA_FACTORS_QUERY_KEY, MFA_AAL_QUERY_KEY } =
  await import('./use-mfa');

function MfaProbe() {
  const mfa = useMfa();
  const standaloneFactors = useMfaFactors();
  const enroll = useEnrollPhoneNumber();
  // Capture what the probes read, outside render (the react-hooks purity
  // rule): the test asserts on these after the settle ticks.
  useEffect(() => {
    probe = {
      mfaFactors: mfa.factors,
      standaloneFactors: standaloneFactors.data?.factors,
      mfaSessionVerified: mfa.sessionVerified,
    };
  });
  return createElement(
    'button',
    {
      'data-testid': 'enroll-phone',
      onClick: () => enroll.mutate({ friendly_name: 'Primary Phone', phone_number: '+15551234567' }),
    },
    'enroll-phone',
  );
}

let client: QueryClient;
let renderer: ReactTestRenderer;

beforeEach(() => {
  calls.listFactors = 0;
  calls.getAAL = 0;
  calls.enrollPhone = 0;
  probe = {};
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});

async function render(): Promise<void> {
  await act(async () => {
    renderer = create(createElement(QueryClientProvider, { client }, createElement(MfaProbe)));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function button(testId: string) {
  const hits = renderer.root.findAll((node) => node.props['data-testid'] === testId);
  if (hits.length === 0) throw new Error(`no node ${testId}`);
  return hits[0];
}

test('one factor-list cache entry serves both the standalone hook and useMfa', async () => {
  await render();

  expect(client.getQueryCache().findAll({ queryKey: MFA_FACTORS_QUERY_KEY })).toHaveLength(1);
  // The phone page's list and the Security tab's list are the same entry: the
  // observers read one object reference, not two drifted copies.
  expect(probe.standaloneFactors).toBe(probe.mfaFactors);
  expect(probe.mfaFactors).toEqual([
    { id: 'factor-1', factor_type: 'phone', status: 'verified', phone: '+15550001111' },
  ]);
  expect(probe.mfaSessionVerified).toBe(true);
  // The second factor key the phone copies used to write is gone from the
  // cache: the only keys left are the two unified ones.
  const cacheKeys = client
    .getQueryCache()
    .getAll()
    .map((query) => query.queryKey[0])
    .sort();
  expect(cacheKeys).toEqual([MFA_AAL_QUERY_KEY[0], MFA_FACTORS_QUERY_KEY[0]]);
  await act(async () => {
    renderer.unmount();
  });
});

test('one aal cache entry serves useMfa', async () => {
  await render();
  expect(client.getQueryCache().findAll({ queryKey: MFA_AAL_QUERY_KEY })).toHaveLength(1);
  expect(probe.mfaSessionVerified).toBe(true);
  await act(async () => {
    renderer.unmount();
  });
});

test('enrolling a phone factor through the phone hook refetches the shared entries', async () => {
  await render();
  const listCallsBefore = calls.listFactors;
  const aalCallsBefore = calls.getAAL;

  await act(async () => {
    button('enroll-phone').props.onClick();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  expect(calls.enrollPhone).toBe(1);
  // The mutation invalidates the shared entries, so both cached queries
  // refetch — the enroll reaches the Security tab's cache entry directly.
  expect(calls.listFactors).toBe(listCallsBefore + 1);
  expect(calls.getAAL).toBe(aalCallsBefore + 1);
  await act(async () => {
    renderer.unmount();
  });
});
