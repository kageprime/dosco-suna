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
// What stays here is what this app decides: its bearer, and no gate.

async function mount(): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<CallSnippet id="project.provision" defaultOpen />));
  return host;
}

test('the HTTP block carries the API-key placeholder and no other bearer', async () => {
  const host = await mount();
  expect(httpBlock(host, 'POST')[1]).toBe(AUTHORIZATION_HEADER);
  expect(host.textContent?.match(/Bearer (?!\$KORTIX_API_KEY)\S+/)).toBeNull();
});

test('the panel renders with no dev-panel flag: this reference shows every call', async () => {
  delete process.env.NEXT_PUBLIC_LUMEN_DEV_PANELS;
  const host = await mount();
  expect(host.querySelector('[aria-label="Copy the SDK call"]')).not.toBeNull();
});
