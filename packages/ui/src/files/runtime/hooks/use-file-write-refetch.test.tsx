/**
 * D-08 / P-F08: a write or a Refresh must reach a file the missing-file gate
 * remembers as gone.
 *
 * Files ▸ New ▸ New file showed the new row's card BEFORE the create chain
 * ran, so its preview read the path and got a 404. The gate then answered
 * every refetch for 5 minutes without a request: the create's invalidation,
 * the viewer opened from the card, and the viewer's Refresh. Card and viewer
 * said "File not found" for a file the API served as `{ content: '' }`.
 *
 * Contract held here, through the public hooks:
 *   - a successful create / upload / copy / rename / mkdir re-reads an open
 *     file under the written path, and the file shows;
 *   - Refresh always sends a new read, also after a 404;
 *   - an invalidation with no write still stays silent (KRTX-4563).
 */
import { ApiError, toDaemonPath } from '@kortix/sdk';
import { fileContentKeys } from '@kortix/sdk/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

const textReads: string[] = [];
const blobReads: string[] = [];
/** Paths that exist on the fake box. A read of any other path is a 404. */
const existing = new Set<string>();
/** When set, the next text read waits on it before it answers. */
let holdRead: Promise<void> | null = null;
const missingError = () => new ApiError('File or folder not found', { status: 404, code: 'not_found' });

mock.module('../../../internal/files/runtime-files', () => ({
  readFile: async (path: string) => {
    textReads.push(path);
    // Existence is decided when the read STARTS; `holdRead` delays the answer.
    const existed = existing.has(path);
    const hold = holdRead;
    holdRead = null;
    if (hold) await hold;
    if (!existed) throw missingError();
    return { type: 'text' as const, content: '' };
  },
  readFileAsBlob: async (path: string) => {
    blobReads.push(path);
    if (!existing.has(path)) throw missingError();
    return new Blob([new Uint8Array([1])], { type: 'application/octet-stream' });
  },
  createFile: async (path: string) => {
    existing.add(path);
    return [{ path: `/workspace/${path}`, size: 0 }];
  },
  uploadFile: async (file: File, targetPath?: string) => {
    const path = targetPath ? `${targetPath}/${file.name}` : file.name;
    existing.add(path);
    return [{ path: `/workspace/${path}`, size: file.size }];
  },
  copyFile: async (_from: string, to: string) => {
    existing.add(to);
    return [{ path: `/workspace/${to}`, size: 0 }];
  },
  renameFile: async (_from: string, to: string) => {
    existing.add(to);
    return true;
  },
  mkdirFile: async () => true,
  deleteFile: async () => true,
  listFiles: async () => [],
  toDaemonPath,
  getFileStatus: async () => [],
}));
mock.module('./use-server-health', () => ({
  useServerHealth: () => ({ parked: false }),
  useCurrentProject: () => ({}),
}));

const { setMissingFileClockForTests, clearMissingFileReadsForTests } = await import(
  '../../../internal/files/file-read-retry'
);
const { useFileContent } = await import('./use-file-content');
const { useFileRefresh } = await import('./use-file-refresh');
const { useFileCopy, useFileCreate, useFileMkdir, useFileRename, useFileUpload } = await import(
  './use-file-mutations'
);

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let queryClient: QueryClient;
const roots: ReactTestRenderer[] = [];
const saved = new Map<string, PropertyDescriptor | undefined>();
let win: Window;

beforeEach(() => {
  textReads.length = 0;
  blobReads.length = 0;
  holdRead = null;
  existing.clear();
  setMissingFileClockForTests(() => 1_000_000);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  win = new Window();
  const globals: Record<string, unknown> = {
    window: win,
    document: win.document,
    navigator: win.navigator,
    HTMLElement: win.HTMLElement,
    Element: win.Element,
    Node: win.Node,
    MutationObserver: win.MutationObserver,
  };
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  queryClient.clear();
  await win.happyDOM.abort();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  saved.clear();
  clearMissingFileReadsForTests();
});

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

type Probe = {
  error: unknown;
  content: string | undefined;
  refresh: () => void;
  create: (v: { filePath: string }) => Promise<unknown>;
  upload: (v: { file: File; targetPath?: string }) => Promise<unknown>;
  copy: (v: { sourcePath: string; destPath: string }) => Promise<unknown>;
  rename: (v: { from: string; to: string }) => Promise<unknown>;
  mkdir: (v: { dirPath: string }) => Promise<unknown>;
};
let probe: Probe;

function FileProbe({ path, onProbe }: { path: string; onProbe: (p: Probe) => void }) {
  const q = useFileContent(path);
  const { refresh } = useFileRefresh(path);
  const createM = useFileCreate();
  const uploadM = useFileUpload();
  const copyM = useFileCopy();
  const renameM = useFileRename();
  const mkdirM = useFileMkdir();
  onProbe({
    error: q.error,
    content: q.data?.content,
    refresh,
    create: createM.mutateAsync,
    upload: uploadM.mutateAsync,
    copy: copyM.mutateAsync,
    rename: renameM.mutateAsync,
    mkdir: mkdirM.mutateAsync,
  });
  return null;
}

async function mount(node: ReactNode) {
  let root: ReactTestRenderer | undefined;
  await act(async () => {
    root = create(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
  });
  roots.push(root!);
  await settle();
}

async function run(fn: () => Promise<unknown> | void) {
  await act(async () => { await fn(); });
  await settle();
}

const NEW = 'notes/new.md';

/** The D-08 start: the card read the path before the file existed. */
async function mountMissing(path = NEW) {
  await mount(<FileProbe path={path} onProbe={(p) => (probe = p)} />);
  expect(textReads).toEqual([path]);
  expect((probe.error as Error | null)?.message).toBe('File or folder not found');
}

test('D-08: New file after a 404 re-reads the path and shows the empty file', async () => {
  await mountMissing();
  await run(() => probe.create({ filePath: NEW }));
  expect(textReads).toEqual([NEW, NEW]);
  expect(probe.error).toBeNull();
  expect(probe.content).toBe('');
});

// Council C8: the write finishes while the first read is still in flight, and
// that read answers 404 afterwards. The viewer must still end on the file.
test('D-08: a read started before New file and answering 404 after it does not win', async () => {
  let release!: () => void;
  holdRead = new Promise<void>((resolve) => (release = resolve));
  await mount(<FileProbe path={NEW} onProbe={(p) => (probe = p)} />);
  expect(textReads).toEqual([NEW]);
  await run(() => probe.create({ filePath: NEW }));
  await run(() => release());
  expect(textReads.length).toBeGreaterThanOrEqual(2);
  expect(probe.error).toBeNull();
  expect(probe.content).toBe('');
});

test('P-F08: Refresh on a missing file always sends a new read', async () => {
  await mountMissing();
  await run(() => probe.refresh());
  expect(textReads).toEqual([NEW, NEW]);
  await run(() => probe.refresh());
  expect(textReads).toEqual([NEW, NEW, NEW]);
  // Still missing: the viewer keeps saying so.
  expect((probe.error as Error | null)?.message).toBe('File or folder not found');

  existing.add(NEW);
  await run(() => probe.refresh());
  expect(textReads).toEqual([NEW, NEW, NEW, NEW]);
  expect(probe.content).toBe('');
});

test('an upload of the missing file re-reads it', async () => {
  await mountMissing();
  await run(() => probe.upload({ file: new File(['x'], 'new.md'), targetPath: 'notes' }));
  expect(textReads).toEqual([NEW, NEW]);
  expect(probe.error).toBeNull();
});

test('a copy onto the missing path re-reads it', async () => {
  await mountMissing();
  await run(() => probe.copy({ sourcePath: 'notes/old.md', destPath: NEW }));
  expect(textReads).toEqual([NEW, NEW]);
  expect(probe.error).toBeNull();
});

test('a rename of a folder onto the missing file\'s parent re-reads it', async () => {
  await mountMissing();
  existing.add(NEW); // the moved folder brought the file with it
  await run(() => probe.rename({ from: 'drafts', to: 'notes' }));
  expect(textReads.length).toBeGreaterThanOrEqual(2);
  expect(probe.error).toBeNull();
});

test('a mkdir clears the marks under the new folder', async () => {
  await mountMissing();
  existing.add(NEW);
  await run(() => probe.mkdir({ dirPath: 'notes' }));
  // mkdir does not invalidate content itself; the next refetch now reads.
  await run(() => queryClient.invalidateQueries({ queryKey: fileContentKeys.all }));
  expect(textReads).toEqual([NEW, NEW]);
  expect(probe.error).toBeNull();
});

test('KRTX-4563 holds: an invalidation with no write still sends no read', async () => {
  await mountMissing();
  await run(() => queryClient.invalidateQueries({ queryKey: fileContentKeys.all, type: 'active' }));
  await run(() => queryClient.invalidateQueries({ queryKey: fileContentKeys.all, type: 'active' }));
  expect(textReads).toEqual([NEW]);
});

test('a write elsewhere keeps the gate on an unrelated missing file', async () => {
  await mountMissing();
  await run(() => probe.create({ filePath: 'other/file.md' }));
  expect(textReads).toEqual([NEW]);
});
