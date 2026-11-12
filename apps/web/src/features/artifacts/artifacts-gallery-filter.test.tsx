import { afterEach, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import type { Artifact } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
const win = new Window({ url: 'http://localhost/workspaces/p1/artifacts' });
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
// After the window exists: react-dom decides at load whether the DOM fires
// `input` events, and without them a typed search never reaches React.
const { createRoot } = await import('react-dom/client');

const artifact = (id: string, title: string, createdBy: string, pinned: boolean, visibility: 'project' | 'private'): Artifact => ({
  artifact_id: id, project_id: 'p1', title, description: null, type: 'doc', path: `/docs/${id}`, entry: 'index.md',
  visibility, shared_with_user_ids: [], pinned, created_by: { user_id: createdBy, name: createdBy, email: null, avatar_url: null },
  created_by_session_id: null, can_manage: true, view_url: `https://example.test/${id}`, web_url: `https://example.test/${id}/web`,
  public_url: null, public_content_url: null, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-02T00:00:00Z',
});
const artifacts = [
  artifact('a-alpha', 'Alpha doc', 'user-1', false, 'project'),
  artifact('a-beta', 'Beta doc', 'user-2', true, 'private'),
];

const realSdkReact = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...realSdkReact,
  useArtifacts: (id: string | null) =>
    id ? { data: artifacts, isLoading: false, isError: false, refetch: async () => {} } : { data: undefined, isLoading: false, isError: false },
  useArtifactMutations: () => ({
    create: { mutateAsync: async () => ({ artifact_id: 'new' }), isPending: false },
    update: { mutate: () => {}, isPending: false },
    remove: { mutateAsync: async () => {}, isPending: false },
    pin: { mutate: () => {} },
  }),
  useProjectConfig: () => ({ data: null }),
  useFeatureFlag: () => ({ enabled: false }),
  prefetchArtifact: () => Promise.resolve(),
}));
const realAuth = await import('@/features/providers/auth-provider');
mock.module('@/features/providers/auth-provider', () => ({
  ...realAuth,
  useAuth: () => ({ user: { id: 'user-1' } }),
}));
const realNav = await import('next/navigation');
mock.module('next/navigation', () => ({
  ...realNav,
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {}, back: () => {} }),
}));
const realUiProvider = { ...(await import('@kortix/ui/providers/ui-provider')) };
mock.module('@kortix/ui/providers/ui-provider', () => ({
  ...realUiProvider,
  useUiSearchParams: () => new URLSearchParams(''),
  useUiPathname: () => '/workspaces/p1/artifacts',
  useUiRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {}, back: () => {} }),
  useUiViewerId: () => 'user-1',
}));
const { ArtifactsGallery } = await import('./artifacts-gallery');

const container = document.createElement('div');
document.body.append(container);
let root = createRoot(container);
const queryClient = new QueryClient();
const render = () => root.render(<QueryClientProvider client={queryClient}><ArtifactsGallery projectId="p1" /></QueryClientProvider>);

afterEach(async () => {
  await act(async () => root.unmount());
  container.replaceChildren();
  root = createRoot(container);
});
const searchInput = () => {
  const node = document.body.querySelector('input');
  if (!(node instanceof HTMLInputElement)) throw new Error('missing the search input');
  return node;
};
const type = async (text: string) => {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (!set) throw new Error('the value property has no setter');
    set.call(searchInput(), text);
    searchInput().dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const cardLinks = () => [...document.body.querySelectorAll('a[href^="/workspaces/p1/artifacts/"]')];
const linkOf = (title: string) => {
  const link = cardLinks().find((a) => a.textContent === title);
  if (!link) throw new Error(`missing the card link: ${title}`);
  return link;
};
/** The hidden wrapper a filtered-out card sits in: still mounted, aria-hidden + fixed. */
const hiddenWrapperOf = (title: string) => linkOf(title).closest('div[aria-hidden="true"]');

test('a search filters which cards show without unmounting any card', async () => {
  await act(render);
  expect(cardLinks().map((a) => a.textContent)).toEqual(['Alpha doc', 'Beta doc']);
  await type('beta');
  // Both cards stay mounted; the filtered-out one goes aria-hidden + inert.
  expect(cardLinks().map((a) => a.textContent)).toEqual(['Alpha doc', 'Beta doc']);
  expect(hiddenWrapperOf('Alpha doc')).not.toBeNull();
  expect(hiddenWrapperOf('Beta doc')).toBeNull();
  await type('');
  expect(hiddenWrapperOf('Alpha doc')).toBeNull();
});

test('the Pinned scope tab keeps the same cards mounted and hides the unpinned one', async () => {
  await act(render);
  const pinned: Element | undefined = [...document.body.querySelectorAll('[role="tab"]')].find((t) => t.textContent === 'Pinned');
  if (!(pinned instanceof HTMLElement)) throw new Error('missing the Pinned tab');
  await act(() => pinned.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })));
  expect(cardLinks().map((a) => a.textContent)).toEqual(['Alpha doc', 'Beta doc']);
  expect(hiddenWrapperOf('Alpha doc')).not.toBeNull();
  expect(hiddenWrapperOf('Beta doc')).toBeNull();
});
