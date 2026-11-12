import { afterEach, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import type { CapturePolicy } from '@kortix/sdk';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
const win = new Window();
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.location = win.location;
globals.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
globals.cancelAnimationFrame = (id: number) => clearTimeout(id);
globals.getComputedStyle = win.getComputedStyle.bind(win);
for (const key of Object.getOwnPropertyNames(win)) {
  if (/^[A-Z]/.test(key) && (!(key in globals) || key.endsWith('Event'))) {
    globals[key] = Reflect.get(win, key);
  }
}
const { createRoot } = await import('react-dom/client');

const saved = mock((_policy: CapturePolicy) => {});
const basePolicy: CapturePolicy = {
  layers: { screen: true, actions: false, audio: false },
  privacy: {
    redact_pii: false, excluded_bundle_ids: [], excluded_domains: [], exclusion_groups: [],
    exclude_private_browsing: false,
  },
  retention: { local_hours: 24, remote_days: 7 },
  recording: { paused: false, paused_until_ms: null },
  notice: '',
};
const realSdkReact = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...realSdkReact,
  useCapturePolicy: () => ({
    data: { policy: basePolicy, updated_at: '2026-11-01T00:00:00Z' }, isLoading: false, isError: false, refetch: async () => {},
  }),
  useSetCapturePolicy: () => ({ mutate: saved, isPending: false }),
}));
const realCaptureArea = await import('@kortix/ui/internal/capture/use-capture-area');
mock.module('@kortix/ui/internal/capture/use-capture-area', () => ({
  ...realCaptureArea,
  useCaptureArea: () => ({ accountName: 'Example Co' }),
}));
const { CaptureSettingsPane } = await import('./settings-view');

const container = document.createElement('div');
document.body.append(container);
let root = createRoot(container);

afterEach(async () => {
  await act(async () => root.unmount());
  container.replaceChildren();
  root = createRoot(container);
  saved.mockClear();
});
const switches = () => [...document.body.querySelectorAll('[role="switch"]')];
const click = async (node: Element) => {
  if (!(node instanceof HTMLElement)) throw new Error('not a clickable element');
  await act(() => node.click());
};
const button = (label: string) => {
  const node = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  if (!(node instanceof HTMLElement)) throw new Error(`missing the ${label} button`);
  return node;
};

test('toggling a layer shows the save bar and saving posts the patched policy', async () => {
  await act(() => root.render(<CaptureSettingsPane accountId="account-1" />));
  // No save bar while the draft matches the stored policy.
  expect(document.body.textContent).not.toContain('Unsaved changes');
  const screen = switches()[0];
  if (!screen) throw new Error('missing the screen layer switch');
  await click(screen);
  expect(document.body.textContent).toContain('Unsaved changes');
  await click(button('Save changes'));
  expect(saved).toHaveBeenCalledTimes(1);
  expect(saved.mock.calls[0]?.[0]).toEqual({ ...basePolicy, layers: { screen: false, actions: false, audio: false } });
});

test('discard returns the draft to the stored policy and hides the save bar', async () => {
  await act(() => root.render(<CaptureSettingsPane accountId="account-1" />));
  const screen = switches()[0];
  if (!screen) throw new Error('missing the screen layer switch');
  await click(screen);
  await click(button('Discard changes'));
  expect(saved).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain('Unsaved changes');
  // The switch is back to the stored value.
  expect(switches()[0]?.getAttribute('aria-checked')).toBe('true');
});
