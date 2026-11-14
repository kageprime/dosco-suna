import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { FileNode } from '../../../internal/files/types';
import type { ExplorerQueryResult, FileExplorerSource } from '../explorer-source';

/**
 * Characterization of the two git/sandbox explorers' shared listing core
 * (KRTX-4922): `DriveExplorer` and the read-only `FileExplorerPage` pin
 * `.kortix` first, sort folders and files by the store's sort field and
 * order, keep the server order for a partly loaded folder (KRTX-1723), and
 * the read-only page offers no write action.
 */

const browser = new Window({ url: 'http://localhost/workspaces/p1/files' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator,
  HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
  MouseEvent: browser.MouseEvent, PointerEvent: browser.PointerEvent,
  KeyboardEvent: browser.KeyboardEvent, MutationObserver: browser.MutationObserver, DOMRect: browser.DOMRect,
  getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
})) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, value });
}

const node = (name: string, type: FileNode['type']): FileNode => ({
  name,
  path: `/workspace/${name}`,
  absolute: `/workspace/${name}`,
  type,
  ignored: false,
});

/** The server's order: by name within a page, here deliberately unsorted. */
const SERVER_ORDER = [
  node('zeta', 'directory'),
  node('b.txt', 'file'),
  node('.kortix', 'directory'),
  node('alpha', 'directory'),
  node('a.md', 'file'),
  node('c.json', 'file'),
];

const COMPLETE: ExplorerQueryResult<FileNode[]> = {
  data: SERVER_ORDER,
  isLoading: false,
  error: null,
  refetch: async () => undefined,
};
let listing = COMPLETE;
// Folder thumbnails list their own folder: empty here.
const useFileList = (dirPath: string) => (dirPath === '/workspace' ? listing : { ...COMPLETE, data: [] });

// Every request the page could make is a write or a fetch this test does not serve.
const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 500 }));

// The page reads the git-ref hooks directly; serve them the same fixture.
const gitStatus = await import('../hooks/use-git-status');
mock.module('../hooks/use-file-list', () => ({
  fileListKeys: { all: ['project-files', 'list'] },
  useFileList,
  useInvalidateFileList: () => () => {},
}));
mock.module('../hooks/use-git-status', () => ({ ...gitStatus, useGitStatus: () => ({ data: [] }) }));
mock.module('../../tree/hooks/use-file-events', () => ({ useFileEventInvalidation: () => {} }));
const changeRequests = await import('../hooks/use-change-requests');
mock.module('../hooks/use-change-requests', () => ({
  ...changeRequests,
  useOpenChangeRequestList: () => ({ data: { change_requests: [] } }),
}));

const { DriveExplorer } = await import('./drive-explorer');
const { FileExplorerPage } = await import('./file-explorer-page');
const { FileExplorerSourceProvider } = await import('../explorer-source');
const { ProjectFilesProvider } = await import('../context');
const { createFilesStore, FilesStoreProvider } = await import('../../../internal/stores/files-store');
const { TestUiHost } = await import('../../../test-utils/ui-host');
const { IntlTestProvider } = await import('../../../test-utils/intl');
const { defaultUiMessages } = await import('../../../i18n');

const mutation = () => ({ mutateAsync: async () => undefined, isPending: false });
const idle = () => ({ data: undefined, isLoading: false, error: null, refetch: async () => undefined });
const readOnlySource: FileExplorerSource = {
  capabilities: { write: false, search: true, hiddenToggle: false, gitStatusChip: false },
  useFileViewerSource: () => ({
    id: 'stub',
    useFileContent: idle,
    useBinaryBlob: () => ({ blobUrl: null, blob: null, isLoading: false, error: null }),
    download: async () => undefined,
    upload: async () => undefined,
  }),
  useFileList,
  useReadinessParked: () => false,
  useGitStatus: () => ({ data: [] }),
  useFileEventInvalidation: () => {},
  useFileSearch: idle,
  useFileHistory: idle,
  useFileCommitDiff: idle,
  useFileUpload: mutation,
  useFileDelete: mutation,
  useFileMkdir: mutation,
  useFileRename: mutation,
  useFileCreate: mutation,
  useFileCopy: mutation,
  useDirectoryDownload: () => ({ downloadDir: () => {}, isDownloading: () => false }),
  useDownloadFile: () => async () => undefined,
};

let root: Root | null = null;
let container: HTMLElement;
let store: ReturnType<typeof createFilesStore>;

beforeEach(() => {
  listing = COMPLETE;
  fetchSpy.mockClear();
  store = createFilesStore();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

afterAll(() => {
  fetchSpy.mockRestore();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function mount(explorer: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root = createRoot(container);
    root.render(
      <IntlTestProvider locale="en" messages={defaultUiMessages} onError={() => {}}>
        <TestUiHost params={{ id: 'p1' }} pathname="/workspaces/p1/files">
          <QueryClientProvider client={queryClient}>
            <ProjectFilesProvider value={{ projectId: 'p1', ref: 'main', defaultBranch: 'main' }}>
              <FileExplorerSourceProvider value={readOnlySource}>
                <FilesStoreProvider store={store}>{explorer}</FilesStoreProvider>
              </FileExplorerSourceProvider>
            </ProjectFilesProvider>
          </QueryClientProvider>
        </TestUiHost>
      </IntlTestProvider>,
    );
  });
}

/** The names of the listed rows, top to bottom (list view). */
function listedNames(): string[] {
  return Array.from(
    container.querySelectorAll('tbody tr'),
    (row) => row.querySelector('td span.truncate')?.textContent ?? '',
  );
}

function row(name: string): HTMLElement {
  const match = Array.from(container.querySelectorAll<HTMLElement>('tbody tr')).find(
    (tr) => tr.querySelector('td span.truncate')?.textContent === name,
  );
  if (!match) throw new Error(`no row named ${name}`);
  return match;
}

/** Opens a row's "⋯" menu and returns its entries. */
async function rowMenu(name: string): Promise<string[]> {
  const trigger = row(name).querySelector<HTMLElement>('button[aria-haspopup="menu"]');
  if (!trigger) throw new Error(`row ${name} has no menu`);
  await act(async () => trigger.click());
  return Array.from(document.querySelectorAll('[role="menuitem"]'), (item) => item.textContent ?? '');
}

const WRITE_ENTRIES = ['Copy', 'Cut', 'Rename', 'Remove'];

function sortListing(sortBy: 'name' | 'type', sortOrder: 'asc' | 'desc') {
  store.getState().setViewMode('list');
  store.getState().setSortBy(sortBy);
  store.getState().setSortOrder(sortOrder);
}

const EXPLORERS = [
  ['DriveExplorer', () => <DriveExplorer />],
  ['FileExplorerPage', () => <FileExplorerPage />],
] as const;

describe.each(EXPLORERS)('%s listing order', (_name, explorer) => {
  test('name ascending: .kortix first, then folders, then files', async () => {
    sortListing('name', 'asc');
    await mount(explorer());
    expect(listedNames()).toEqual(['.kortix', 'alpha', 'zeta', 'a.md', 'b.txt', 'c.json']);
  });

  test('name descending reverses folders and files; .kortix stays first', async () => {
    sortListing('name', 'desc');
    await mount(explorer());
    expect(listedNames()).toEqual(['.kortix', 'zeta', 'alpha', 'c.json', 'b.txt', 'a.md']);
  });

  test('type ascending sorts files by extension', async () => {
    sortListing('type', 'asc');
    await mount(explorer());
    expect(listedNames()).toEqual(['.kortix', 'alpha', 'zeta', 'c.json', 'a.md', 'b.txt']);
  });

  test('type descending reverses the extension order', async () => {
    sortListing('type', 'desc');
    await mount(explorer());
    expect(listedNames()).toEqual(['.kortix', 'zeta', 'alpha', 'b.txt', 'a.md', 'c.json']);
  });

  test('a partly loaded folder keeps the server order (KRTX-1723)', async () => {
    sortListing('name', 'desc');
    listing = { ...COMPLETE, hasNextPage: true, fetchNextPage: async () => undefined };
    await mount(explorer());
    expect(listedNames()).toEqual(['.kortix', 'zeta', 'alpha', 'b.txt', 'a.md', 'c.json']);
  });
});

describe('FileExplorerPage is read-only', () => {
  test('a writable DriveExplorer row menu offers the write entries', async () => {
    sortListing('name', 'asc');
    const writable = { ...readOnlySource, capabilities: { ...readOnlySource.capabilities, write: true } };
    await mount(
      <FileExplorerSourceProvider value={writable}>
        <DriveExplorer />
      </FileExplorerSourceProvider>,
    );
    expect(await rowMenu('b.txt')).toEqual(expect.arrayContaining(WRITE_ENTRIES));
  });

  test('a file row menu offers no copy, cut, rename or remove', async () => {
    sortListing('name', 'asc');
    await mount(<FileExplorerPage />);
    expect(await rowMenu('b.txt')).toEqual(['Preview', 'Download', 'Version history', 'Copy path']);
  });

  test('a folder row menu offers no copy, cut, rename or remove', async () => {
    sortListing('name', 'asc');
    await mount(<FileExplorerPage />);
    const entries = await rowMenu('alpha');
    for (const entry of WRITE_ENTRIES) expect(entries).not.toContain(entry);
  });

  test('⌘V changes nothing', async () => {
    sortListing('name', 'asc');
    await mount(<FileExplorerPage />);
    const paste = new KeyboardEvent('keydown', { key: 'v', metaKey: true, bubbles: true, cancelable: true });
    await act(async () => window.dispatchEvent(paste));
    expect(paste.defaultPrevented).toBe(false);
    expect(store.getState().clipboard).toBeNull();
    expect(listedNames()).toEqual(['.kortix', 'alpha', 'zeta', 'a.md', 'b.txt', 'c.json']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
