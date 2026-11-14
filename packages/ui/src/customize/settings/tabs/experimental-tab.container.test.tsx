import { afterAll, afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { configureKortix, type FeatureFlagView } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// The container `ExperimentalTab`, mounted for real: the Reset control's click
// goes through its handler and its mutation to the wire, so these tests pin
// what a reset sends, where its switch lands while in flight, and when the
// Channels dialog asks first.
const win = new Window();
const previous = new Map<string, PropertyDescriptor | undefined>();
for (const key of ['window', 'document', 'navigator', 'getComputedStyle', 'HTMLElement', 'HTMLButtonElement', 'SVGElement', 'Node', 'NodeFilter', 'MutationObserver', 'Event', 'CustomEvent', 'FocusEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'IS_REACT_ACT_ENVIRONMENT']) {
  previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: key === 'window' ? win : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : key === 'getComputedStyle' ? win.getComputedStyle.bind(win) : Reflect.get(win, key),
  });
}
const { createRoot } = await import('react-dom/client');
const { ExperimentalTab } = await import('./experimental-tab');
const { UiProvider } = await import('../../../providers/ui-provider');

let root: Root | undefined;
let client: QueryClient | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  client?.clear();
  document.body.innerHTML = '';
});
afterAll(() => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  configureKortix({ backendUrl: '', getToken: async () => null });
  void win.happyDOM.close();
});

const PROJECT = 'synthetic-project';

const flag = (over: Partial<FeatureFlagView> & Pick<FeatureFlagView, 'key' | 'name'>): FeatureFlagView => ({
  description: `${over.name} flag.`,
  stability: 'beta',
  available: true,
  enabled: true,
  overridden: true,
  default_enabled: true,
  ...over,
});

/** Mounts the tab over these flags. The PATCH never answers, so the reset
 *  stays in flight and the optimistic switch position can be read. */
async function mount(features: FeatureFlagView[]) {
  const patches: unknown[] = [];
  const project = { project_id: PROJECT, name: 'Synthetic workspace', experimental_features: features };
  configureKortix({
    backendUrl: 'http://backend.test/v1',
    getToken: async () => 'synthetic-token',
    fetch: async (input, init) => {
      const url = String(input);
      if (init?.method === 'PATCH' && url.endsWith(`/workspaces/${PROJECT}/features`)) {
        patches.push(JSON.parse(String(init.body)));
        return new Promise<Response>(() => {});
      }
      if (url.endsWith(`/workspaces/${PROJECT}`)) return Response.json(project);
      // The admin-role read: not a platform operator.
      return Response.json({ isAdmin: false });
    },
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client = queryClient;
  queryClient.setQueryData(qk.project.summary(PROJECT), project);
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <QueryClientProvider client={queryClient}>
        {/* A host-enforced host: no IAM probe, the viewer may change settings. */}
        <UiProvider config={{ accountApiEnabled: false }} useViewerId={() => 'synthetic-user'}>
          <ExperimentalTab projectId={PROJECT} />
        </UiProvider>
      </QueryClientProvider>,
    ),
  );
  await settle();
  return patches;
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

const button = (label: string) => {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`Expected a "${label}" button`);
  return found;
};
const click = async (el: Element) => {
  await act(async () => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await settle();
};
const switchOf = (key: string) => document.querySelector(`[aria-labelledby="feature-flag-${key}"]`);

test('Reset sends enabled: null, and its switch shows the platform default while the reset is in flight', async () => {
  const patches = await mount([flag({ key: 'reminders', name: 'Loops', enabled: false, default_enabled: true })]);
  expect(switchOf('reminders')?.getAttribute('aria-checked')).toBe('false');

  await click(button('Reset to default'));

  expect(patches).toEqual([{ feature: 'reminders', enabled: null }]);
  expect(switchOf('reminders')?.getAttribute('aria-checked')).toBe('true');
});

test('a Channels reset that keeps Channels as it is sends at once, with no dialog', async () => {
  const patches = await mount([flag({ key: 'chat', name: 'Spaces', enabled: true, default_enabled: true })]);

  await click(button('Reset to default'));

  expect(document.body.textContent).not.toContain('Turn off Spaces?');
  expect(patches).toEqual([{ feature: 'chat', enabled: null }]);
});

test('a Channels reset that turns Channels off asks first, and sends only on confirm', async () => {
  const patches = await mount([flag({ key: 'chat', name: 'Spaces', enabled: true, default_enabled: false })]);

  await click(button('Reset to default'));

  expect(document.body.textContent).toContain('Turn off Spaces?');
  expect(patches).toEqual([]);

  await click(button('Turn off'));

  expect(patches).toEqual([{ feature: 'chat', enabled: null }]);
  expect(switchOf('chat')?.getAttribute('aria-checked')).toBe('false');
});
