import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const translate = Object.assign((key: string) => key, { raw: (key: string) => key });
mock.module('../../i18n', () => ({ useTranslations: () => translate }));
const toasts: string[] = [];
const toast = await import('../../primitives/toast');
mock.module('../../primitives/toast', () => ({
  ...toast,
  successToast: (message: string) => toasts.push(message),
  errorToast: (message: string) => toasts.push(message),
}));
// Menu shells that render inline and pass the handler through: the test
// judges the submenu's composition and copy wiring, not the portals.
const slot =
  (testid: string) =>
  function MenuShell({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) {
    return createElement('div', { ...props, 'data-testid': testid }, children);
  };
mock.module('../../primitives/dropdown-menu', () => ({
  DropdownMenuSub: slot('menu-sub'),
  DropdownMenuSubTrigger: slot('menu-sub-trigger'),
  DropdownMenuSubContent: slot('menu-sub-content'),
  DropdownMenuItem: slot('menu-item'),
}));
let written: string | undefined;
let clipboardOk = true;
mock.module('../../internal/lib/utils/clipboard', () => ({
  copyToClipboard: async (text: string) => {
    written = text;
    return clipboardOk;
  },
}));

const { SessionEmbedMenuItem } = await import('./session-embed-menu-item');

let renderer: ReactTestRenderer | undefined;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  toasts.length = 0;
  written = undefined;
  clipboardOk = true;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

function item() {
  if (!renderer) throw new Error('Menu item did not mount');
  const node = renderer.root.findAll((n) => n.props['data-testid'] === 'menu-item')[0];
  if (!node) throw new Error('No menu item rendered');
  return node;
}

describe('SessionEmbedMenuItem — the embed entry point in the session menu', () => {
  test('the submenu shows the caveat and copies the session snippet', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { origin: 'https://kortix.com' } },
    });
    await act(async () => {
      renderer = create(
        createElement(SessionEmbedMenuItem, { projectId: 'synthetic-project', sessionId: 'synthetic-session' }),
      );
    });
    const html = JSON.stringify(renderer?.toJSON());
    expect(html).toContain('sectionTitle');
    // The caveat text survives the move, word for word (same i18n key).
    expect(html).toContain('sectionDescription');
    expect(html).toContain('copy');

    await act(async () => item().props.onClick());
    expect(written).toContain('/workspaces/synthetic-project/sessions/synthetic-session');
    expect(toasts).toEqual(['copied']);
  });

  test('a failed clipboard write reports the failure instead of success', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { origin: 'https://kortix.com' } },
    });
    clipboardOk = false;
    await act(async () => {
      renderer = create(
        createElement(SessionEmbedMenuItem, { projectId: 'synthetic-project', sessionId: 'synthetic-session' }),
      );
    });
    await act(async () => item().props.onClick());
    expect(toasts).toEqual(['text167c96824acb']);
  });
});
