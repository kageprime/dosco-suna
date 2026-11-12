import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { ProjectSession } from '@kortix/sdk';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const translate = Object.assign((key: string) => key, { raw: (key: string) => key });
mock.module('../../../i18n', () => ({ useTranslations: () => translate }));
const uiProvider = await import('../../../providers/ui-provider');
mock.module('../../../providers/ui-provider', () => ({
  ...uiProvider,
  useUiHostConfig: () => ({ accountApiEnabled: true, publicSharesEnabled: true }),
}));
const toast = await import('../../../primitives/toast');
mock.module('../../../primitives/toast', () => ({
  ...toast,
  successToast: () => undefined,
  errorToast: () => undefined,
}));
mock.module('../../../primitives/label', () => ({
  Label: ({ children }: { children?: ReactNode }) => children,
}));
// The Modal shells render their children unconditionally: this test judges the
// dialog's own composition (picker in, embed out), not the portals.
const shell =
  (testid: string) =>
  function ModalShell({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) {
    return createElement('div', { ...props, 'data-testid': testid }, children);
  };
mock.module('../../../primitives/modal', () => ({
  Modal: ({ children }: { children?: ReactNode }) => children,
  ModalContent: shell('modal-content'),
  ModalHeader: shell('modal-header'),
  ModalTitle: shell('modal-title'),
  ModalDescription: shell('modal-description'),
  ModalBody: shell('modal-body'),
  ModalFooter: shell('modal-footer'),
}));
const picker = await import('../../../access/sharing-picker');
mock.module('../../../access/sharing-picker', () => ({
  ...picker,
  SharingPicker: () => createElement('div', { 'data-testid': 'sharing-picker' }),
}));
const sdk = await import('@kortix/sdk');
mock.module('@kortix/sdk', () => ({
  ...sdk,
  getSessionOversight: async () => ({ enabled: false }),
}));

const { ShareSessionModal } = await import('./share-session-modal');

const SESSION = {
  session_id: 'synthetic-session',
  account_id: 'synthetic-account',
  is_owner: true,
  can_manage_sharing: true,
  visibility: 'private',
  sharing: { mode: 'private', ownerId: 'synthetic-user' },
} as unknown as ProjectSession;

let renderer: ReactTestRenderer | undefined;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

describe('ShareSessionModal — the access dialog carries no embed surface', () => {
  test('the owner dialog renders the access picker and no embed section', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { origin: 'https://kortix.com' } },
    });
    const queryClient = new QueryClient();
    await act(async () => {
      renderer = create(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(ShareSessionModal, {
            projectId: 'synthetic-project',
            session: SESSION,
            open: true,
            onOpenChange: () => undefined,
          }),
        ),
      );
    });
    if (!renderer) throw new Error('Modal did not mount');
    const html = JSON.stringify(renderer.toJSON());
    expect(html).toContain('"data-testid":"sharing-picker"');
    expect(html).not.toContain('"data-testid":"session-embed"');
  });
});
