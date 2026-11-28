import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const win = new Window({ url: 'http://localhost/workspaces/synthetic-project' });
Object.defineProperties(globalThis, {
  window: { value: win, configurable: true },
  document: { value: win.document, configurable: true },
  HTMLAnchorElement: { value: win.HTMLAnchorElement, configurable: true },
  IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true },
});
const P = 'synthetic-project';
const home = `/workspaces/${P}`;
let path = home;
const push = mock(() => {});
const replace = mock(() => {});
const prefetch = mock(() => {});
const router = { push, replace, prefetch };
mock.module('next/navigation', () => ({
  usePathname: () => path,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => router,
}));
const sidebar = await import('@kortix/ui/sidebar');
mock.module('@kortix/ui/sidebar', () => ({ ...sidebar, useSidebar: () => ({ state: 'expanded', isMobile: false }) }));
const { DesktopTabStrip } = await import('./desktop-tab-strip');
const { useDesktopTabsStore, readProjectTabs } = await import('./desktop-tabs-store');
let root: Root;
let client: QueryClient;
let navigation: InstanceType<typeof win.EventTarget>;
let clock: ReturnType<typeof spyOn>;

function render() {
  act(() => root.render(<QueryClientProvider client={client}><DesktopTabStrip projectId={P} /></QueryClientProvider>));
}
function command(action: string) {
  act(() => win.dispatchEvent(Object.assign(new win.Event('kortix-desktop-command'), { detail: action })));
}
function click(target: string, modified = false) {
  const link = win.document.createElement('a');
  link.href = target;
  win.document.body.append(link);
  act(() => link.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: modified })));
}
beforeEach(() => {
  path = home;
  push.mockClear(); replace.mockClear(); prefetch.mockClear();
  clock = spyOn(Date, 'now').mockReturnValue(1000);
  navigation = new win.EventTarget();
  Object.defineProperty(win, 'navigation', { value: navigation, configurable: true });
  Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} disconnect() {} }, configurable: true });
  useDesktopTabsStore.setState({ byProject: { [P]: { tabs: [], activeId: null, closed: [], recent: [] } } });
  client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  const host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
  render();
});
afterEach(() => { act(() => root.unmount()); client.clear(); clock.mockRestore(); document.body.innerHTML = ''; });

test('modified project link opens in the background without navigating', () => {
  const active = readProjectTabs(P).activeId;
  click(`${home}/sessions/background`, true);
  expect(readProjectTabs(P).activeId).toBe(active);
  expect(readProjectTabs(P).tabs.some(tab => tab.path === `${home}/sessions/background`)).toBe(true);
  expect(push).not.toHaveBeenCalled();
});
test('key and native command execute once, repeated same-source presses execute twice', () => {
  act(() => useDesktopTabsStore.setState({ byProject: { [P]: {
    tabs: [{ id: 'a', path: home }, { id: 'b', path: `${home}/sessions/b` }, { id: 'c', path: `${home}/sessions/c` }],
    activeId: 'a', closed: [], recent: [],
  } } }));
  const key = () => act(() => win.dispatchEvent(new win.KeyboardEvent('keydown', { code: 'Tab', ctrlKey: true, bubbles: true })));
  key(); command('next-tab');
  expect(readProjectTabs(P).activeId).toBe('b');
  key();
  expect(readProjectTabs(P).activeId).toBe('c');
  key();
  expect(readProjectTabs(P).activeId).toBe('a');
});
test('redirect replacement stays in its original tab', () => {
  const before = readProjectTabs(P).activeId;
  const event = new win.Event('navigate');
  Object.assign(event, { navigationType: 'replace', destination: { url: `http://localhost${home}/sessions/redirected` } });
  act(() => navigation.dispatchEvent(event));
  path = `${home}/sessions/redirected`; render();
  expect(readProjectTabs(P).activeId).toBe(before);
  expect(readProjectTabs(P).tabs.find(tab => tab.id === before)?.path).toBe(path);
});
test('a late link overtaken by a same-path tab restores the foreground route', () => {
  const from = readProjectTabs(P).activeId;
  click(`${home}/sessions/late`);
  command('new-tab');
  path = `${home}/sessions/late`; render();
  expect(readProjectTabs(P).tabs.find(tab => tab.id === from)?.path).toBe(path);
  expect(replace).toHaveBeenCalledWith(home);
});
