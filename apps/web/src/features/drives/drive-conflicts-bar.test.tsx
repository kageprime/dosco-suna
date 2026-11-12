import { afterAll, afterEach, expect, jest, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { NextIntlClientProvider } from 'next-intl';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import messages from '../../../translations/en.json';

const win = new Window();
const domKeys = [
  'window',
  'document',
  'navigator',
  'customElements',
  'HTMLElement',
  'Element',
  'Node',
  'MutationObserver',
  'CustomEvent',
  'Event',
  'MouseEvent',
  'PointerEvent',
  'FocusEvent',
  'KeyboardEvent',
  'NodeFilter',
  'HTMLInputElement',
  'getComputedStyle',
  'IS_REACT_ACT_ENVIRONMENT',
];
// `bun test` evaluates every file in one process: put the happy-dom globals
// back when this file ends, so later files do not inherit them.
const globalsBackup = new Map(
  domKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const key of domKeys) {
  Object.defineProperty(globalThis, key, { configurable: true, value: Reflect.get(win, key) });
}
Object.defineProperty(globalThis, 'getComputedStyle', {
  configurable: true,
  value: win.getComputedStyle.bind(win),
});
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
afterAll(() => {
  for (const [key, descriptor] of globalsBackup) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
const conflict = {
  conflictId: 'synthetic-conflict',
  path: '/Shared/report.txt',
  detectedAt: '2026-10-01T00:00:00Z',
};
let entries = [conflict];
const dismiss = mock((_input: { driveId: string; conflictId: string }, _options: unknown) => {});
// The barrel mock that wins a combined `bun test` run is the union of what
// every file in the directory needs, because bun links named imports against
// the mock registered when the importing graph is linked, and
// drive-folder-tree.test.tsx may register its own (smaller) mock first.
// So: spread whatever the registry holds now, and re-add every runtime
// export this file's graph links — the two hooks (stubbed) plus the barrel
// names drive-explorer-source.tsx imports, taken from their own modules.
const files = await import('@kortix/ui/files');
const useDrives = await import('../../../../../packages/ui/src/files/drives/use-drives');
const driveStorage = await import('../../../../../packages/ui/src/files/drives/drive-storage');
mock.module('@kortix/ui/files', () => ({
  ...files,
  saveDriveFile: useDrives.saveDriveFile,
  useDriveLimitMessage: driveStorage.useDriveLimitMessage,
  useDriveConflicts: () => ({ data: entries }),
  useDismissDriveConflict: () => ({ mutate: dismiss, isPending: false }),
}));
const { DriveConflictsBar } = await import('./drive-conflicts-bar');
const { TooltipProvider } = await import('@kortix/ui/tooltip');
const host = document.createElement('div');
document.body.append(host);
const root = createRoot(host);
const openFolder = mock(() => {});

async function mount() {
  await act(async () =>
    root.render(
      <NextIntlClientProvider
        locale="en"
        timeZone="UTC"
        messages={messages}
        now={new Date('2026-10-01T01:00:00Z')}
      >
        <TooltipProvider>
          <DriveConflictsBar driveId="synthetic-drive" onOpenFolder={openFolder} />
        </TooltipProvider>
      </NextIntlClientProvider>,
    ),
  );
}
function trigger() {
  const button = host.querySelector<HTMLButtonElement>('button[aria-expanded]');
  if (!button) throw new Error('Missing conflict trigger');
  return button;
}
function button(label: string) {
  const match = Array.from(document.querySelectorAll('button')).find(
    (node) => node.getAttribute('aria-label') === label || node.textContent === label,
  );
  if (!match) throw new Error(`Missing ${label}`);
  return match;
}
afterEach(async () => {
  await act(async () => root.render(null));
  entries = [conflict];
  dismiss.mockClear();
  openFolder.mockClear();
  jest.useRealTimers();
});

test('hover leaves the conflict details closed and the trigger unchanged', async () => {
  await mount();
  const before = trigger().outerHTML;
  await act(async () => trigger().dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  expect(trigger().getAttribute('aria-expanded')).toBe('false');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(trigger().outerHTML).toBe(before);
});

test('click opens an accessible popover, actions retain their inputs, and Escape restores focus', async () => {
  await mount();
  await act(async () => trigger().click());
  expect(trigger().getAttribute('aria-expanded')).toBe('true');
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('report.txt');
  await act(async () =>
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    ),
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  // The dialog restores focus to the trigger on a queued timer after the close,
  // so flush it before asserting the trigger has focus back.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(document.activeElement).toBe(trigger());
  await act(async () => trigger().click());
  await act(async () => button('Dismiss').click());
  expect(dismiss.mock.calls[0]?.[0]).toEqual({
    driveId: 'synthetic-drive',
    conflictId: conflict.conflictId,
  });
  await act(async () => button('Open folder').click());
  expect(openFolder).toHaveBeenCalledWith('/Shared');
  expect(trigger().getAttribute('aria-expanded')).toBe('false');
});

test('outside pointer closes the popover', async () => {
  jest.useFakeTimers();
  await mount();
  await act(async () => trigger().click());
  await act(async () => jest.advanceTimersByTime(1));
  await act(async () => {
    document.body.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }),
    );
    document.body.click();
  });
  expect(trigger().getAttribute('aria-expanded')).toBe('false');
});

test('no conflicts renders no control', async () => {
  entries = [];
  await mount();
  expect(host.textContent).toBe('');
  expect(host.querySelector('button')).toBeNull();
});
