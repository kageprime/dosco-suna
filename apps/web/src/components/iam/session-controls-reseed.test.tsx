import { expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import type { ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
notifyManager.setScheduler(queueMicrotask);

/**
 * Characterization test for KRTX-4735 (behavior-preserving restructure).
 *
 * Pins the session-policy form's re-seed rule: both fields re-seed from the
 * server when EITHER saved value changes, and an edit in progress (touched)
 * is never clobbered by a refetch. Today the form detects "the server answer
 * changed" by comparing a key built from the two saved values — the rule this
 * pins — and KRTX-4735 only changes that key's separator byte. The rule must
 * not move.
 */

let policy: { max_lifetime_minutes: number | null; idle_timeout_minutes: number | null } = {
  max_lifetime_minutes: 600,
  idle_timeout_minutes: 300,
};

// The card calls next-intl's useTranslations directly (not the test-fallback
// wrapper), so the test provides the English catalog itself.
const { createTranslator } = await import('next-intl');
const enMessages = (await import('../../../translations/en.json')).default;
const realNextIntl = await import('next-intl');
mock.module('next-intl', () => {
  const translator = createTranslator({
    locale: 'en',
    messages: enMessages,
    namespace: 'hardcodedUi.i18nComplete',
  });
  return { ...realNextIntl, useTranslations: () => translator };
});

const realIam = await import('@/lib/iam-client');
mock.module('@/lib/iam-client', () => ({
  ...realIam,
  getSessionPolicy: async () => policy,
  updateSessionPolicy: async () => policy,
}));

const { SessionControlsCard } = await import('./session-controls-card');

function text(node: unknown): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  const props = (node as { props?: { children?: unknown } }).props;
  return props ? text(props.children) : '';
}

type InputProps = { value: string; onChange: (e: { target: { value: string } }) => void };

function inputs(root: ReactTestRenderer): InputProps[] {
  return root.root.findAllByType('input').map((input) => input.props as InputProps);
}

async function mount(): Promise<{ root: ReactTestRenderer; client: QueryClient }> {
  // reset the module-level mock before each mount
  policy = { max_lifetime_minutes: 600, idle_timeout_minutes: 300 };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let root: ReactTestRenderer | undefined;
  await act(async () => {
    root = create(
      <QueryClientProvider client={client}>
        <SessionControlsCard accountId="synthetic-account" canManage />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  if (!root) throw new Error('mount failed');
  return { root, client };
}

async function setSavedPolicy(
  client: QueryClient,
  next: { max_lifetime_minutes: number | null; idle_timeout_minutes: number | null },
) {
  policy = next;
  await act(async () => {
    client.setQueryData(['iam-session-policy', 'synthetic-account'], next);
    await Promise.resolve();
  });
}

test('both fields seed from the loaded policy', async () => {
  const { root } = await mount();
  const fields = inputs(root);
  expect(fields).toHaveLength(2);
  expect(fields[0]?.value).toBe('600');
  expect(fields[1]?.value).toBe('300');
  await act(async () => root.unmount());
});

test('a change to EITHER saved value re-seeds the untouched form', async () => {
  const { root, client } = await mount();
  await setSavedPolicy(client, { max_lifetime_minutes: 900, idle_timeout_minutes: 300 });
  expect(inputs(root)[0]?.value).toBe('900');
  // the max field changed; the idle field re-seeds too (both ride the same key)
  await setSavedPolicy(client, { max_lifetime_minutes: 900, idle_timeout_minutes: 350 });
  expect(inputs(root)[0]?.value).toBe('900');
  expect(inputs(root)[1]?.value).toBe('350');
  await act(async () => root.unmount());
});

test('a refetch never clobbers a touched edit', async () => {
  const { root, client } = await mount();
  await act(async () => inputs(root)[0]?.onChange({ target: { value: '1200' } }));
  await setSavedPolicy(client, { max_lifetime_minutes: 750, idle_timeout_minutes: 350 });
  expect(inputs(root)[0]?.value).toBe('1200');
  expect(inputs(root)[1]?.value).toBe('300');
  await act(async () => root.unmount());
});
