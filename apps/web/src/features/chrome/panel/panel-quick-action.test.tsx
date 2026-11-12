import { afterEach, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
const win = new Window({ url: 'http://localhost/panel' });
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.location = win.location;
globals.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
globals.cancelAnimationFrame = (id: number) => clearTimeout(id);
globals.getComputedStyle = win.getComputedStyle.bind(win);
globals.customElements = win.customElements;
for (const key of Object.getOwnPropertyNames(win)) {
  if (/^[A-Z]/.test(key) && (!(key in globals) || key.endsWith('Event'))) {
    globals[key] = Reflect.get(win, key);
  }
}
const { createRoot } = await import('react-dom/client');

const pushed = mock((_href: string) => {});
const activeTab = { id: 7, title: 'Docs page', url: 'https://docs.example.test/page', readable: true };
let onContext: (context: { tab: typeof activeTab | null; quote?: string }) => void = () => {};
const channel = {
  activeTab,
  inPanel: true,
  listTabs: async () => [],
  readTabs: async (ids: number[]) =>
    ids.map((tabId) => ({ tabId, title: 'Docs page', url: 'https://docs.example.test/page', text: 'The page body.', truncated: false })),
  capture: async () => null,
  handAct: () => {},
};
const realSdkReact = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({ ...realSdkReact, useProjectSessions: () => ({ data: { pages: [], pageParams: [] } }) }));
const realAuth = await import('@/features/providers/auth-provider');
mock.module('@/features/providers/auth-provider', () => ({ ...realAuth, useAuth: () => ({ user: { id: 'user-1' } }) }));
const realSelector = await import('@/features/workspace/project-selector/use-project-selector-data');
mock.module('@/features/workspace/project-selector/use-project-selector-data', () => ({
  ...realSelector,
  useProjectSelectorData: () => ({ openable: [{ project: { project_id: 'p1', name: 'P1' } }], listsLoading: false }),
}));
const realNav = await import('next/navigation');
mock.module('next/navigation', () => ({ ...realNav, useRouter: () => ({ push: pushed, replace: () => {}, prefetch: () => {}, back: () => {} }) }));
const realCookies = await import('@/lib/supabase/panel-cookies');
mock.module('@/lib/supabase/panel-cookies', () => ({ ...realCookies, isInExtensionPanel: () => true }));
mock.module('./panel-channel', () => ({
  usePanelChannel: (cb: typeof onContext) => {
    onContext = cb;
    return channel;
  },
}));
const { ChromePanelHome } = await import('./chrome-panel-home');
const { useComposerPrefillStore } = await import('@kortix/ui/internal/stores/composer-prefill-store');

const container = document.createElement('div');
document.body.append(container);
let root = createRoot(container);

afterEach(async () => {
  await act(async () => root.unmount());
  container.replaceChildren();
  root = createRoot(container);
  pushed.mockClear();
  useComposerPrefillStore.setState({ prefillByProject: {} });
});
const textarea = () => {
  const node = document.body.querySelector('#panel-prompt');
  if (!(node instanceof HTMLTextAreaElement)) throw new Error('missing the prompt textarea');
  return node;
};
const type = async (text: string) => {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (!set) throw new Error('the value property has no setter');
    set.call(textarea(), text);
    textarea().dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const prefill = () => useComposerPrefillStore.getState().prefillByProject['p1'];

test('a quick action hands the read page text to the project composer as a when-ready prefill', async () => {
  await act(async () => root.render(<ChromePanelHome />));
  const summarize = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Summarize this page');
  if (!(summarize instanceof HTMLElement)) throw new Error('missing the summarize quick action');
  await act(async () => {
    summarize.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const prefill1 = prefill();
  expect(prefill1?.text).toBe('Summarize this page.');
  expect(prefill1?.submit).toBe('when-ready');
  expect(prefill1?.files).toHaveLength(1);
  const attached = prefill1?.files?.[0];
  if (!attached || !('file' in attached) || typeof attached.file.text !== 'function') {
    throw new Error('the attachment is not a readable File');
  }
  expect(await attached.file.text()).toContain('The page body.');
  expect(pushed).toHaveBeenCalledTimes(1);
  expect(pushed.mock.calls[0]?.[0]).toBe('/workspaces/p1');
});

test('send carries the quoted selection: the prefill quotes it with its source tab', async () => {
  await act(async () => root.render(<ChromePanelHome />));
  await act(() => onContext({ tab: activeTab, quote: 'Selected words' }));
  expect(document.body.textContent).toContain('Selected words');
  await type('Do this');
  const send = [...document.body.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Send');
  if (!(send instanceof HTMLElement)) throw new Error('missing the send button');
  await act(async () => {
    send.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const prefill2 = prefill();
  expect(prefill2?.text).toContain('Do this');
  expect(prefill2?.text).toContain('> Selected words');
  expect(prefill2?.text).toContain('from “Docs page”');
  expect(prefill2?.submit).toBe('when-ready');
  expect(pushed).toHaveBeenCalledTimes(1);
  expect(pushed.mock.calls[0]?.[0]).toBe('/workspaces/p1');
});
