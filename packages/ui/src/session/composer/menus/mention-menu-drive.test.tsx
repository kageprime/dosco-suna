import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

// The SDK reads, as the server answers them: search refuses an empty `q`
// (`useProjectSearch` stays disabled), the folder listing answers what the
// viewer may read.
const searched: string[] = [];
const listed: Array<{ driveId: string | null; path: string }> = [];
const sdk = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...sdk,
  useProjectSearch: (_projectId: string, input: { q: string }, options: { enabled: boolean }) => {
    const q = input.q.trim();
    if (options.enabled && q) searched.push(q);
    return {
      data: options.enabled && q ? { hits: [{ path: '/Company/q3-plan.md', name: 'q3-plan.md', kind: 'file', size: 9 }] } : undefined,
      isFetching: false,
      isError: false,
    };
  },
  useProjectDrive: (_projectId: string, _viewerId: string | undefined, enabled: boolean) => ({
    data: enabled ? { driveId: 'drive-1', personalFolder: '/Users/synthetic' } : undefined,
    isLoading: false,
    isError: false,
  }),
  useDriveFolder: (driveId: string | null, path: string) => {
    listed.push({ driveId, path });
    return {
      data: driveId
        ? {
            entries: [
              { path: '/Users/synthetic/old.txt', name: 'old.txt', type: 'file', size: 3, mtime: 100 },
              { path: '/Users/synthetic/notes', name: 'notes', type: 'dir', size: 0, mtime: 300 },
              { path: '/Users/synthetic/brand.png', name: 'brand.png', type: 'file', size: 7, mtime: 200 },
            ],
            access: 'write',
          }
        : undefined,
      isLoading: false,
      isError: false,
    };
  },
}));
mock.module('../hooks/use-file-search', () => ({ useFileSearch: () => ({ files: [], isLoading: false }) }));
const { MentionMenuHost } = await import('./mention-menu');

const render = (query: string) =>
  renderToStaticMarkup(
    <MentionMenuHost
      query={query}
      agents={[]}
      sessions={[]}
      currentSessionId={undefined}
      drive={{ projectId: 'project-1', onPick: () => {} }}
      now={0}
      selectedIndex={0}
      onSelect={() => {}}
      onRowsChange={() => {}}
    />,
  );

test('a bare @ lists the files of the viewer\'s own Drive folder, newest first, without folders', () => {
  const markup = render('');
  expect(searched).toEqual([]);
  expect(listed).toContainEqual({ driveId: 'drive-1', path: '/Users/synthetic' });
  expect(markup).toContain('Drive');
  expect(markup).toContain('brand.png');
  expect(markup).toContain('old.txt');
  expect(markup.indexOf('brand.png')).toBeLessThan(markup.indexOf('old.txt'));
  expect(markup).not.toContain('>notes<');
});

test('typed text shows the Drive search hits, not the folder listing', () => {
  const markup = render('q3');
  expect(searched).toEqual(['q3']);
  expect(markup).toContain('q3-plan.md');
  expect(markup).not.toContain('brand.png');
});

test('a composer without Drive reads no Drive', () => {
  listed.length = 0;
  const markup = renderToStaticMarkup(
    <MentionMenuHost
      query=""
      agents={[]}
      sessions={[]}
      currentSessionId={undefined}
      drive={null}
      now={0}
      selectedIndex={0}
      onSelect={() => {}}
      onRowsChange={() => {}}
    />,
  );
  expect(listed.every((call) => call.driveId === null)).toBe(true);
  expect(markup).not.toContain('brand.png');
});
