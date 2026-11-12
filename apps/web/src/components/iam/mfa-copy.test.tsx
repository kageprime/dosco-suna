import { expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import type { ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
notifyManager.setScheduler(queueMicrotask);

/**
 * Characterization tests for KRTX-4735 (behavior-preserving restructure).
 *
 * They pin the MFA confirmation modal's copy at the component level — the
 * rendered English sentences — because the restructure routes the same words
 * through new ICU plural catalog keys. The sentences must not move: these
 * tests passed before the restructure (the sentence was composed from three
 * keys plus an English `member`/`members` ternary) and must pass after (one
 * plural key per sentence) with the same rendered text.
 */

const policy = { enabled: false };
let preview: { losers: Array<{ user_id: string; account_role: string; is_super_admin?: boolean }>; members_with_mfa: number; total_members: number; will_lock_out_account: boolean } | undefined;
let members: Array<{ user_id: string; email: string | null; account_role: string; is_super_admin?: boolean }> = [];

const realIam = await import('@/lib/iam-client');
mock.module('@/lib/iam-client', () => ({
  ...realIam,
  getMfaRequired: async () => policy,
  previewMfaRequired: async () => preview,
  setMfaRequired: async () => policy,
}));
const realSdk = await import('@kortix/sdk');
mock.module('@kortix/sdk', () => ({ ...realSdk, listAccountMembers: async () => members }));

const pass = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
const realModal = await import('@kortix/ui/modal');
mock.module('@kortix/ui/modal', () => ({
  ...realModal,
  Modal: ({ open, children }: { open: boolean; children?: React.ReactNode }) =>
    open ? <div data-dialog>{children}</div> : null,
  ModalBody: pass,
  ModalContent: pass,
  ModalDescription: pass,
  ModalFooter: pass,
  ModalHeader: pass,
  ModalTitle: pass,
}));
const realAlert = await import('@kortix/ui/alert');
mock.module('@kortix/ui/alert', () => ({
  ...realAlert,
  Alert: pass,
  AlertTitle: ({ children }: { children?: React.ReactNode }) => <div data-alert-title>{children}</div>,
  AlertDescription: ({ children }: { children?: React.ReactNode }) => <div data-alert-desc>{children}</div>,
  AlertMedia: pass,
}));
const realSwitch = await import('@kortix/ui/switch');
mock.module('@kortix/ui/switch', () => ({
  ...realSwitch,
  Switch: ({ onCheckedChange, checked }: { onCheckedChange: (v: boolean) => void; checked: boolean }) => (
    <button data-switch={String(checked)} onClick={() => onCheckedChange(!checked)} />
  ),
}));

const { MfaRequiredCard } = await import('./mfa-required-card');

function text(node: unknown): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  const props = (node as { props?: { children?: unknown } }).props;
  return props ? text(props.children) : '';
}

function dialogs(root: ReactTestRenderer): string[] {
  return root.root
    .findAllByProps({ 'data-dialog': true })
    .map((dialog) => text(dialog));
}

async function mount(): Promise<ReactTestRenderer> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let root: ReactTestRenderer | undefined;
  await act(async () => {
    root = create(
      <QueryClientProvider client={client}>
        <MfaRequiredCard accountId="synthetic-account" canManage />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  if (!root) throw new Error('mount failed');
  return root;
}

async function openModal(root: ReactTestRenderer): Promise<string> {
  const dialog = () => dialogs(root).join('\n');
  const before = dialog();
  if (!before.includes('will be locked out')) {
    const sw = root.root.findAllByProps({ 'data-switch': 'false' })[0];
    if (!sw) throw new Error('switch not found');
    await act(async () => sw.props.onClick());
  }
  return dialog();
}

const LOCKOUT_1 = '1 member will be locked out until they enrol MFA:';
const LOCKOUT_2 = '2 members will be locked out until they enrol MFA:';
const EXEMPT_1 = "1 super-admin without MFA — they won't be locked out, but consider asking them to enrol:";
const EXEMPT_2 = "2 super-admins without MFA — they won't be locked out, but consider asking them to enrol:";

test('the lockout title reads the singular sentence for one member', async () => {
  preview = {
    losers: [{ user_id: 'u1', account_role: 'member' }],
    members_with_mfa: 3,
    total_members: 4,
    will_lock_out_account: false,
  };
  members = [];
  const root = await mount();
  const dialog = await openModal(root);
  expect(dialog).toContain(LOCKOUT_1);
  await act(async () => root.unmount());
});

test('the lockout title reads the plural sentence for two members', async () => {
  preview = {
    losers: [
      { user_id: 'u1', account_role: 'member' },
      { user_id: 'u2', account_role: 'member' },
    ],
    members_with_mfa: 3,
    total_members: 5,
    will_lock_out_account: false,
  };
  members = [];
  const root = await mount();
  const dialog = await openModal(root);
  expect(dialog).toContain(LOCKOUT_2);
  await act(async () => root.unmount());
});

test('the exempt-admins line reads the singular clause for one super-admin', async () => {
  preview = {
    losers: [{ user_id: 'u9', account_role: 'admin', is_super_admin: true }],
    members_with_mfa: 1,
    total_members: 2,
    will_lock_out_account: false,
  };
  members = [{ user_id: 'u9', email: 'u9@example.test', account_role: 'admin', is_super_admin: true }];
  const root = await mount();
  const dialog = await openModal(root);
  expect(dialog).toContain(EXEMPT_1);
  expect(dialog).not.toContain(EXEMPT_2);
  await act(async () => root.unmount());
});

test('the exempt-admins line reads the plural clause for two super-admins', async () => {
  preview = {
    losers: [
      { user_id: 'u9', account_role: 'admin', is_super_admin: true },
      { user_id: 'u10', account_role: 'admin', is_super_admin: true },
    ],
    members_with_mfa: 1,
    total_members: 3,
    will_lock_out_account: false,
  };
  members = [];
  const root = await mount();
  const dialog = await openModal(root);
  expect(dialog).toContain(EXEMPT_2);
  expect(dialog).not.toContain(EXEMPT_1);
  await act(async () => root.unmount());
});
