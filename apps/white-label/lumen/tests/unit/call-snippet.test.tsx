import { afterEach, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';

const window = new Window();
Object.defineProperties(globalThis, {
  window: { value: window, configurable: true },
  document: { value: window.document, configurable: true },
  navigator: { value: window.navigator, configurable: true },
  getComputedStyle: { value: window.getComputedStyle.bind(window), configurable: true },
  requestAnimationFrame: { value: window.requestAnimationFrame.bind(window), configurable: true },
  cancelAnimationFrame: { value: window.cancelAnimationFrame.bind(window), configurable: true },
  IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true },
  // Base UI's positioning (Floating UI) reads these DOM classes as bare globals.
  Element: { value: window.Element, configurable: true },
  HTMLElement: { value: window.HTMLElement, configurable: true },
  Node: { value: window.Node, configurable: true },
  ShadowRoot: { value: window.ShadowRoot, configurable: true },
});
mock.module('@kortix/ui/toast', () => ({ successToast: mock(), errorToast: mock() }));
process.env.NEXT_PUBLIC_LUMEN_DEV_PANELS = '1';
const { CallSnippet } = await import('../../src/components/dev/call-snippet');
const { AUTHORIZATION_HEADER } = await import('../../src/lib/call-snippets');
let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

/** The HTTP block's text: the request line, then the authorization line. */
function httpBlock(host: HTMLElement, method: string): string[] {
  const blocks = [...host.querySelectorAll('pre code')].map((node) => node.textContent ?? '');
  return (blocks.find((text) => text.startsWith(`${method} `)) ?? '').split('\n');
}

// The panel's copy behaviour is tested once, in packages/white-label-shared.
// What stays here is what this app decides: its bearer and its gate.

test('the HTTP block carries the member-token placeholder and no other bearer', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<CallSnippet id="session.delete" defaultOpen />));
  expect(httpBlock(host, 'DELETE')[1]).toBe(AUTHORIZATION_HEADER);
  expect(host.textContent?.match(/Bearer (?!\$KORTIX_MEMBER_TOKEN)\S+/)).toBeNull();
});

test('the panel renders nothing unless NEXT_PUBLIC_LUMEN_DEV_PANELS=1 (customers never see it)', async () => {
  process.env.NEXT_PUBLIC_LUMEN_DEV_PANELS = '';
  try {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root?.render(<CallSnippet id="session.delete" defaultOpen />));
    expect(host.innerHTML).toBe('');
  } finally {
    process.env.NEXT_PUBLIC_LUMEN_DEV_PANELS = '1';
  }
});
