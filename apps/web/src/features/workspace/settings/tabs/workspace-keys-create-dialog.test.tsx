/**
 * KRTX-4787: a fresh account's CLI setup mints its PAT at /settings/tokens
 * (the account hub's API keys pane) and pastes it into `kortix login`. The
 * dialog there minted a WORKSPACE-bound key while reading "Acts as: You" —
 * and every other workspace refused it, so the first CLI setup failed.
 *
 * The dialog now asks where the key works, and "All my workspaces" — a
 * personal key, the same credential `kortix login` mints — is the default:
 *
 *   - the default mint goes to `createAccountToken` (no `project_id`: the
 *     key acts as the person in every workspace of theirs);
 *   - "Only this workspace" keeps the workspace key (`createWorkspaceKey`).
 *
 * The Radix Select is mocked as a native <select> so the test can drive
 * `onValueChange` the way the browser does.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realReactQuery from '@tanstack/react-query';
// A dynamic import: the restricted-import lint rule forbids a namespace import
// of the SDK root, and the mock below must spread the real module.
const realSdk = await import('@kortix/sdk');
const realAccess = await import('@kortix/ui/access/access/index');
import { createElement, Fragment, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const ACCOUNT = '00000000-0000-4000-8000-000000000001';
const WORKSPACE = '00000000-0000-4000-8000-000000000002';

const workspaceMints: Array<{ name: string; workspaceId: string }> = [];
const personalMints: Array<{ name: string; accountId?: string; projectId?: string }> = [];

mock.module('@kortix/sdk', () => ({
  ...realSdk,
  listWorkspaceKeys: async () => ({ keys: [], can_manage_principals: false, agents: [], bots: [] }),
  createWorkspaceKey: async (workspaceId: string, input: { name: string }) => {
    workspaceMints.push({ workspaceId, name: input.name });
    return {
      key_id: `key-${workspaceMints.length}`,
      name: input.name,
      acts_as: { type: 'me' },
      credential: 'token',
      public_key: 'pk_synthetic0000000000000000000000',
      secret_key: 'kortix_pat_synthetic',
      status: 'active',
      scope: 'full',
      permissions: null,
      workspace_permissions: null,
      expiry_renews: false,
      expires_at: null,
      last_used_at: null,
      created_at: '2026-11-12T00:00:00.000Z',
      revoked_at: null,
      created_by: null,
      created_by_email: null,
    };
  },
  createAccountToken: async (input: { name: string; accountId?: string; projectId?: string }) => {
    personalMints.push(input);
    return {
      token_id: `tok-${personalMints.length}`,
      name: input.name,
      project_id: input.projectId ?? null,
      public_key: 'pk_synthetic0000000000000000000000',
      secret_key: 'kortix_pat_synthetic',
      status: 'active',
      expires_at: null,
      created_at: '2026-11-12T00:00:00.000Z',
    };
  },
  listPermissions: async () => [],
}));

function Pass({ children }: { children?: ReactNode }) {
  return createElement(Fragment, null, children);
}

const uiModalMock = () => {
  const Modal = ({ open, children }: { open: boolean; children?: ReactNode }) =>
    open ? createElement('div', null, children) : null;
  return {
    Modal,
    ModalBody: Pass,
    ModalContent: Pass,
    ModalDescription: Pass,
    ModalFooter: Pass,
    ModalHeader: Pass,
    ModalTitle: Pass,
  };
};
mock.module('@kortix/ui/modal', uiModalMock);
mock.module('@kortix/ui/toast', () => ({ successToast: () => {}, errorToast: () => {} }));

// Radix Select as a native select: the value lives on Select, the options are
// the SelectItems, and a change fires onValueChange exactly like the browser.
mock.module('@kortix/ui/select', () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children?: ReactNode }) =>
    createElement(
      'select',
      { value, onChange: (event: { target: { value: string } }) => onValueChange(event.target.value) },
      children,
    ),
  SelectContent: Pass,
  SelectGroup: Pass,
  SelectItem: ({ value, children }: { value: string; children?: ReactNode }) =>
    createElement('option', { value }, children),
  SelectLabel: Pass,
  SelectSeparator: Pass,
  SelectTrigger: ({ id, children }: { id?: string; children?: ReactNode }) =>
    createElement('div', { 'data-trigger-id': id }, children),
  SelectValue: () => null,
}));
mock.module('@kortix/ui/access/access/index', () => ({ ...realAccess, CopyRow: Pass }));

const translate = (key: string) => key.split('.').pop() || key;
mock.module('@/i18n/use-translations', () => ({
  useLocale: () => 'en',
  useTranslations: () =>
    Object.assign((key: string) => translate(key), {
      raw: translate,
      rich: (key: string) => translate(key),
    }),
}));

const { WorkspaceKeysSection } = await import('@kortix/ui/customize/settings/tabs/workspace-keys');

async function openCreateDialog(): Promise<ReactTestRenderer> {
  const client = new realReactQuery.QueryClient({ defaultOptions: { queries: { retry: false } } });
  let root: ReactTestRenderer | undefined;
  await act(async () => {
    root = create(
      createElement(
        realReactQuery.QueryClientProvider,
        { client },
        createElement(WorkspaceKeysSection, { workspaceId: WORKSPACE, accountId: ACCOUNT }),
      ),
    );
  });
  if (!root) throw new Error('WorkspaceKeysSection did not render');
  // The empty list's "New key" button opens the dialog.
  const newKey = root.root.find((node) => typeof node.type === 'string' && node.props.onClick);
  await act(async () => {
    newKey.props.onClick();
  });
  return root;
}

async function fillAndSubmit(root: ReactTestRenderer, worksIn?: string, opts?: { submit?: boolean }): Promise<void> {
  const submit = opts?.submit !== false;
  const input = root.root.findByProps({ id: 'workspace-key-name' });
  await act(async () => {
    input.props.onChange({ target: { value: 'setup-key' } });
  });
  if (worksIn !== undefined) {
    // The "Works in" select is the one whose trigger id is workspace-key-works-in.
    const select = root.root
      .findAllByType('select')
      .find((node) =>
        node.findAll((n) => n.props && n.props['data-trigger-id'] === 'workspace-key-works-in').length > 0,
      );
    if (!select) throw new Error(`no "Works in" select offering "${worksIn}"`);
    await act(async () => {
      select.props.onChange({ target: { value: worksIn } });
    });
  }
  const form = root.root.findByType('form');
  if (!submit) return;
  await act(async () => {
    form.props.onSubmit({ preventDefault() {} });
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

beforeEach(() => {
  workspaceMints.length = 0;
  personalMints.length = 0;
});

describe('CreateWorkspaceKeyDialog — where a key works (KRTX-4787)', () => {
  test('the default mint is a personal key: it acts in every workspace of the person', async () => {
    const root = await openCreateDialog();
    try {
      await fillAndSubmit(root);
      expect(personalMints).toHaveLength(1);
      expect(personalMints[0]?.name).toBe('setup-key');
      expect(personalMints[0]?.accountId).toBe(ACCOUNT);
      // No `project_id`: the key is bound to no workspace.
      expect(personalMints[0]?.projectId).toBeUndefined();
      expect(workspaceMints).toEqual([]);
    } finally {
      await act(async () => root.unmount());
    }
  });

  test('a stale Custom access (zero picks) left by "Only this workspace" does not block the personal mint', async () => {
    const root = await openCreateDialog();
    try {
      const selectByValue = (value: string) => {
        const select = root.root.findAllByType('select').find((node) => node.props.value === value);
        if (!select) throw new Error(`no select offering "${value}"`);
        return select;
      };
      // Works in → "Only this workspace": the Access select appears.
      await act(async () => {
        selectByValue('all').props.onChange({ target: { value: 'workspace' } });
      });
      // Access → Custom, pick nothing: Create is disabled, the cause is visible.
      await act(async () => {
        selectByValue('full').props.onChange({ target: { value: 'custom' } });
      });
      // Works in → back to "All my workspaces": the Access select hides. The
      // leftover Custom-with-zero-picks must not keep Create disabled — the
      // control that would clear it is gone from the page.
      await act(async () => {
        selectByValue('workspace').props.onChange({ target: { value: 'all' } });
      });
      const input = root.root.findByProps({ id: 'workspace-key-name' });
      await act(async () => {
        input.props.onChange({ target: { value: 'setup-key' } });
      });
      const submit = root.root.findByProps({ type: 'submit' });
      expect(submit.props.disabled).toBe(false);
      const form = root.root.findByType('form');
      await act(async () => {
        form.props.onSubmit({ preventDefault() {} });
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(personalMints).toHaveLength(1);
      expect(workspaceMints).toEqual([]);
    } finally {
      await act(async () => root.unmount());
    }
  });

  test('"Only this workspace" still mints a workspace key', async () => {
    const root = await openCreateDialog();
    try {
      await fillAndSubmit(root, 'workspace');
      expect(workspaceMints).toHaveLength(1);
      expect(workspaceMints[0]?.workspaceId).toBe(WORKSPACE);
      expect(workspaceMints[0]?.name).toBe('setup-key');
      expect(personalMints).toEqual([]);
    } finally {
      await act(async () => root.unmount());
    }
  });

  test('flipping Works in back to All my workspaces clears the stale Access narrowing (KRTX-4787 review)', async () => {
    const root = await openCreateDialog();
    try {
      // Choose Only this workspace + Access: Custom, leave Custom with nothing
      // picked, then flip back to All my workspaces — no submit in between.
      // The hidden Access narrowing must not strand the Create behind a
      // disabled form (G9 request_changes, head 53fb232).
      await fillAndSubmit(root, 'workspace', { submit: false });
      // The Access select is the one whose trigger id is workspace-key-access.
      const accessSelect = root.root
        .findAllByType('select')
        .find((node) =>
          node.findAll((n) => n.props && n.props['data-trigger-id'] === 'workspace-key-access').length > 0,
        );
      if (!accessSelect) throw new Error('no Access select');
      await act(async () => {
        accessSelect.props.onChange({ target: { value: 'custom' } });
      });
      await fillAndSubmit(root, 'all');
      // The personal path minted despite access === custom with 0 picked.
      expect(personalMints).toHaveLength(1);
      expect(personalMints[0]?.projectId).toBeUndefined();
      expect(workspaceMints).toEqual([]);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
