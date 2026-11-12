import { expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
notifyManager.setScheduler(queueMicrotask);

/**
 * Characterization + contract test for the shared account-member roster hook.
 *
 * The hook owns the one `['account-members', accountId]` entry: every observer
 * of an account rides the same fetch, and the email/meta derivations read that
 * single copy. KRTX-4735 moved the IAM panels' four hand-built id→email maps
 * onto this hook; these tests pin the two properties that make the move safe:
 * one fetch serves many consumers, and a member without an email is absent
 * from the email map (callers fall back to the user id) while its meta stays.
 *
 * The consumers render what they read (a component stays pure); the test
 * reads the rendered text back out of the tree.
 */

let members: Array<{
  user_id: string;
  email: string | null;
  account_role: string;
  is_super_admin?: boolean;
}> = [
  { user_id: 'u1', email: 'u1@example.test', account_role: 'owner' },
  { user_id: 'u2', email: null, account_role: 'member' },
];
let fetches = 0;

const realSdk = await import('@kortix/sdk');
mock.module('@kortix/sdk', () => ({
  ...realSdk,
  listAccountMembers: async () => {
    fetches += 1;
    return members;
  },
}));

const { UiProvider } = await import('../../providers/ui-provider');
const { useAccountMembers } = await import('./use-account-members');

function RosterConsumer({ accountId }: { accountId: string }) {
  const { emailByUserId, accountMetaByUserId, data } = useAccountMembers(accountId);
  const meta2 = accountMetaByUserId.get('u2');
  const line = [
    `emails=${JSON.stringify([...emailByUserId.entries()].sort())}`,
    `meta2=${meta2 ? `${meta2.accountRole}/${String(meta2.isSuperAdmin)}` : 'none'}`,
    `rows=${data?.length ?? 0}`,
  ].join(' ');
  return <span data-roster>{line}</span>;
}

function text(node: unknown): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  const props = (node as { props?: { children?: unknown } }).props;
  return props ? text(props.children) : '';
}

function rosterLines(root: ReturnType<typeof create>): string[] {
  return root.root.findAllByProps({ 'data-roster': true }).map((span) => text(span));
}

async function mount(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let root: ReturnType<typeof create> | undefined;
  await act(async () => {
    root = create(
      <QueryClientProvider client={client}>
        <UiProvider useViewerId={() => 'synthetic-viewer'}>{children}</UiProvider>
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  if (!root) throw new Error('mount failed');
  return root;
}

test('two consumers of one account cause one listAccountMembers fetch', async () => {
  fetches = 0;
  const root = await mount(
    <>
      <RosterConsumer accountId="synthetic-account" />
      <RosterConsumer accountId="synthetic-account" />
    </>,
  );
  expect(fetches).toBe(1);
  await act(async () => root.unmount());
});

test('a member without an email is absent from the email map and present in the meta map', async () => {
  fetches = 0;
  const root = await mount(<RosterConsumer accountId="synthetic-account" />);
  const line = rosterLines(root)[0];
  // u2's email is null: the email map omits it, the meta map keeps the row
  expect(line).toContain('emails=[["u1","u1@example.test"]]');
  expect(line).toContain('meta2=member/false');
  expect(line).toContain('rows=2');
  await act(async () => root.unmount());
});

test('the enabled gate keeps the fetch off while closed', async () => {
  fetches = 0;
  members = [];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let root: ReturnType<typeof create> | undefined;
  function Gated() {
    useAccountMembers('synthetic-account', { enabled: false });
    return null;
  }
  await act(async () => {
    root = create(
      <QueryClientProvider client={client}>
        <UiProvider useViewerId={() => 'synthetic-viewer'}>
          <Gated />
        </UiProvider>
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(fetches).toBe(0);
  if (!root) throw new Error('mount failed');
  const mounted = root;
  await act(async () => mounted.unmount());
});
