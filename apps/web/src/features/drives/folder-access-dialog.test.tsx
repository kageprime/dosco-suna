// KRTX-2201: the folder-access dialog keyed its form on the grants query's
// `dataUpdatedAt`. Every drive mutation on the Files page invalidates that
// query, so a background refetch while the dialog was open remounted the form
// and threw away the unsaved draft. The draft now lives from the opening until
// the dialog closes or the folder changes; until the person edits, it follows
// the server.
import { afterEach, expect, mock, test } from 'bun:test';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { folderAccessQueryOptions } from '@kortix/sdk/react';
import type { FolderAccessView } from '@kortix/sdk';
import { Window } from 'happy-dom';

const win = new Window({ width: 1440, height: 900 });
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  window: win,
  document: win.document,
  navigator: win.navigator,
  location: win.location,
  getComputedStyle: win.getComputedStyle.bind(win),
});
for (const key of Object.getOwnPropertyNames(win)) {
  // Base UI dispatches happy-dom's own event classes, not Bun's.
  if (/^[A-Z]/.test(key) && (!(key in globalThis) || key.endsWith('Event'))) {
    Reflect.set(globalThis, key, Reflect.get(win, key));
  }
}

/** What the server answers for a folder; a test edits it between fetches. */
const server = new Map<string, FolderAccessView>();
/** Held fetches: a test resolves them to control when a fetch lands. */
const pending: Array<() => void> = [];
let holdFetches = false;

function view(path: string, agents: string[]): FolderAccessView {
  return {
    path,
    access: 'manage',
    grantable: true,
    grants: agents.map((name) => ({
      grantId: `grant-${path}-${name}`,
      path,
      inherited: false,
      system: false,
      principalType: 'agent',
      principalId: `sa-${name}`,
      label: name,
      level: 'write',
    })),
  };
}

const files = await import('@kortix/ui/files');
mock.module('@kortix/ui/files', () => ({
  ...files,
  // The real query options (key, enabled), with the network replaced.
  useFolderAccess: (driveId: string | null, path: string, enabled = true) =>
    useQuery({
      ...folderAccessQueryOptions(driveId, path, enabled),
      queryFn: () =>
        new Promise<FolderAccessView>((resolve) => {
          const answer = () => {
            const grants = server.get(path);
            if (!grants) throw new Error(`no server answer for ${path}`);
            resolve(structuredClone(grants));
          };
          if (holdFetches) pending.push(answer);
          else answer();
        }),
    }),
  useShareFolder: () => ({ mutateAsync: async () => {} }),
  useUnshareFolder: () => ({ mutateAsync: async () => {} }),
}));
const access = await import('@kortix/ui/access');
mock.module('@kortix/ui/access', () => ({ ...access, PrincipalPicker: () => null }));
mock.module('@kortix/ui/access/access/agent-principals', () => ({
  useProjectAgentIdentities: () => ({ data: [] }),
}));
mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({ user: { id: 'user-1' } }),
}));

// After the window exists: react-dom decides at load whether the DOM fires
// `input` events.
const { createRoot } = await import('react-dom/client');
const { FolderAccessDialog } = await import('./folder-access-dialog');

// The app's defaults (`react-query-provider.tsx`): a cached copy stays fresh
// for 5 minutes, so an opening with a fresh cache fetches nothing.
const appClient = () => new QueryClient({ defaultOptions: { queries: { staleTime: 5 * 60 * 1000 } } });
let root: Root | null = null;
let client = appClient();

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  client = appClient();
  server.clear();
  pending.length = 0;
  holdFetches = false;
  document.body.innerHTML = '';
});

async function render(path: string, open: boolean) {
  const mounted = (root ??= createRoot(document.body.appendChild(document.createElement('div'))));
  await act(async () =>
    mounted.render(
      <QueryClientProvider client={client}>
        <FolderAccessDialog driveId="drive-1" projectId="project-1" path={path} open={open} onOpenChange={() => {}} />
      </QueryClientProvider>,
    ),
  );
  await settle();
}

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

function button(label: string) {
  return Array.from(document.querySelectorAll('button')).find(
    (node) => node.getAttribute('aria-label') === label || node.textContent?.trim() === label,
  );
}

/** The agents the form lists on the folder, as the draft holds them. */
function listedAgents(): string[] {
  return Array.from(document.querySelectorAll('[role="dialog"] li > span > span.font-medium')).map((label) =>
    (label.textContent ?? '').replace('Agent: ', ''),
  );
}

async function removeAgent(name: string) {
  const remove = button(`Remove access for ${name}`);
  if (!remove) throw new Error(`the form lists no ${name} row`);
  await act(async () => remove.click());
}

test('a refetch while the dialog is open keeps the unsaved draft', async () => {
  server.set('/Sales', view('/Sales', ['scout', 'writer']));
  await render('/Sales', true);
  expect(listedAgents()).toEqual(['scout', 'writer']);

  await removeAgent('scout');
  expect(listedAgents()).toEqual(['writer']);
  expect(button('Save')?.disabled).toBe(false);

  // Any drive mutation on the page (an upload, a delete) refetches the grants.
  const before = client.getQueryState(folderAccessQueryOptions('drive-1', '/Sales').queryKey)?.dataUpdatedAt ?? 0;
  await act(async () => new Promise((resolve) => setTimeout(resolve, 2)));
  await act(async () => client.invalidateQueries());
  await settle();
  const after = client.getQueryState(folderAccessQueryOptions('drive-1', '/Sales').queryKey)?.dataUpdatedAt ?? 0;
  expect(after).toBeGreaterThan(before);

  expect(listedAgents()).toEqual(['writer']);
  expect(button('Save')?.disabled).toBe(false);
});

test('every opening starts a fresh draft, and an untouched draft follows a refetch that lands after opening', async () => {
  server.set('/Sales', view('/Sales', ['scout']));
  await render('/Sales', true);
  await removeAgent('scout');
  await render('/Sales', false);

  // Reopened with a fresh cache: no fetch, the form shows at once, last opening's edit is gone.
  await render('/Sales', true);
  expect(listedAgents()).toEqual(['scout']);
  expect(button('Save')?.disabled).toBe(true);
  await render('/Sales', false);

  // A drive mutation while closed invalidates the grants, which changed on the server.
  server.set('/Sales', view('/Sales', ['scout', 'writer']));
  await act(async () => client.invalidateQueries());
  holdFetches = true;
  await render('/Sales', true);
  expect(listedAgents()).toEqual(['scout']);

  await act(async () => pending.shift()?.());
  await settle();
  expect(listedAgents()).toEqual(['scout', 'writer']);
  expect(button('Save')?.disabled).toBe(true);
});

test('switching the folder while open gives a fresh draft for the new folder', async () => {
  server.set('/Sales', view('/Sales', ['scout']));
  server.set('/Ops', view('/Ops', ['runner']));
  await render('/Sales', true);
  await removeAgent('scout');

  await render('/Ops', true);
  expect(listedAgents()).toEqual(['runner']);
  expect(button('Save')?.disabled).toBe(true);
});
