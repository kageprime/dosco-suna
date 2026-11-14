import { afterEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import type { Root } from 'react-dom/client';

// KRTX-4802: opening a CLI login link (`/cli/authorize?user_code=…`) shows the
// login code already in the field, so nobody copies it from the terminal by
// hand. The URL is not consent: a phished link carries a code too (RFC 8628
// §5.4), so Authorize enables only after the person confirms that the code
// matches their own terminal. A link with no code renders no field at all.

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const win = new Window();
const setGlobal = (key: string, value: unknown) =>
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
setGlobal('window', win);
setGlobal('document', win.document);
setGlobal('navigator', win.navigator);
setGlobal('getComputedStyle', win.getComputedStyle.bind(win));
for (const key of Object.getOwnPropertyNames(win)) {
  if (/^[A-Z]/.test(key) && !(key in globalThis)) setGlobal(key, Reflect.get(win, key));
}
// Bun has its own event classes; happy-dom dispatches only its own.
for (const key of ['Event', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'FocusEvent']) {
  setGlobal(key, Reflect.get(win, key));
}

let params = new URLSearchParams();
mock.module('next/navigation', () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  useSearchParams: () => params,
  usePathname: () => '/cli/authorize',
  useParams: () => ({}),
}));
mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({ user: { email: 'member@example.test' }, isLoading: false }),
}));
const syntheticRow = {
  workspaceId: 'w-synthetic',
  accountId: 'a-synthetic',
  project: { id: 'w-synthetic', name: 'Synthetic Workspace', icon: null, icon_glyph: null },
};
mock.module('@kortix/ui/workspace/sidebar/use-workspace-directory', () => ({
  useWorkspaceDirectory: () => ({
    accounts: [],
    workspaces: [syntheticRow],
    openable: [syntheticRow],
    loading: false,
    failedAccountIds: [],
    reusableAccount: null,
    githubSourceAccount: null,
    retryFailed: () => {},
  }),
}));
const approved: string[] = [];
mock.module('@kortix/sdk', () => ({
  approveCliDevice: async (code: string) => {
    approved.push(code);
    return {};
  },
  createAccountToken: async () => ({}),
  isNoWorkspaceError: () => false,
  revokeAccountToken: async () => ({}),
}));

// After the DOM globals: React DOM detects input-event support when it loads.
const { createRoot } = await import('react-dom/client');
const { default: CliAuthorizePage } = await import('./page');

let root: Root | null = null;
function openLink(query: string) {
  params = new URLSearchParams(query);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const mounted = createRoot(host);
  root = mounted;
  act(() => mounted.render(<CliAuthorizePage />));
}
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  approved.length = 0;
  document.body.innerHTML = '';
});

/** The one element `selector` matches; a missing element fails the test. */
function the<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`no element matches ${selector}`);
  return node;
}
const field = () => the<HTMLInputElement>('#cli-user-code');
const authorize = () => the<HTMLButtonElement>('button[type="submit"]');
const matchBox = () => the<HTMLButtonElement>('button[role="checkbox"]');
const click = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
/** Types into the code field the way a browser does: the native setter, then `input`. */
function type(value: string) {
  const input = field();
  act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('the CLI authorize page prefills the login code from its link', () => {
  test('a user_code link shows the code in the field; Authorize waits for the match confirmation', () => {
    openLink(`user_code=${encodeURIComponent('ab12-cd34-ef56-7890')}`);

    expect(field().value).toBe('ab12-cd34-ef56-7890');
    expect(document.body.textContent).toContain('This code matches my terminal');
    expect(authorize().disabled).toBe(true);

    click(matchBox());
    expect(matchBox().getAttribute('aria-checked')).toBe('true');
    expect(authorize().disabled).toBe(false);
  });

  test('the prefilled field stays editable, and only the matching code enables Authorize', () => {
    openLink('user_code=AB12CD34');
    click(matchBox());

    type('ZZZZ9999');
    expect(field().value).toBe('ZZZZ9999');
    expect(authorize().disabled).toBe(true);

    type('ab12-cd34');
    expect(authorize().disabled).toBe(false);
  });

  test('a submit without the confirmation approves nothing', async () => {
    openLink('user_code=AB12CD34');
    // requestSubmit skips the disabled button, so this reaches the form's own guard.
    const submit = () =>
      act(async () => {
        the<HTMLFormElement>('form').requestSubmit();
      });

    await submit();
    expect(approved).toEqual([]);

    click(matchBox());
    await submit();
    expect(approved).toEqual(['AB12CD34']);
  });

  test('a link with no user_code renders no login-code field at all', () => {
    openLink('');
    expect(document.body.textContent).toContain('kortix login');
    expect(document.querySelector('#cli-user-code')).toBeNull();
    expect(document.querySelector('button[role="checkbox"]')).toBeNull();
  });
});
