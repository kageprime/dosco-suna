/**
 * Characterization tests for the analytics page gate: which document may load
 * a third-party analytics script. The desktop app never loads one; a
 * signed-in or capability-token page (`isAnalyticsExcludedPath`) never does.
 * The gate is decided once per document, on mount.
 */
import { afterEach, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

let desktop = false;

mock.module('@kortix/ui/internal/lib/desktop', () => ({ isDesktop: () => desktop }));
mock.module('next/script', () => ({
  default: (props: { id: string }) => <script id={props.id} />,
}));

const { GoogleTagManager } = await import('./google-tag-manager');
const { useAnalyticsPageEnabled } = await import('@/lib/analytics/gtm');

let win: InstanceType<typeof Window> | null = null;

function installWindow(url: string) {
  win = new Window();
  const globals = globalThis as Record<string, unknown>;
  globals.window = win;
  globals.document = win.document;
  globals.navigator = win.navigator;
  globals.location = win.location;
  win.location.href = url;
}

afterEach(() => {
  win?.happyDOM.abort();
  win = null;
});

/**
 * happy-dom implements the lib.dom surfaces; its own classes carry extra
 * members, so the crossing of that library boundary is one explicit cast.
 */
async function mount(
  element: React.ReactElement,
): Promise<{ container: HTMLElement; unmount: () => void }> {
  const raw = win!.document.createElement('div');
  const container = raw as unknown as HTMLElement;
  win!.document.body.appendChild(raw);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root!.render(element);
  });
  return {
    container,
    unmount: () => {
      act(() => root!.unmount());
    },
  };
}

test('GoogleTagManager loads on a public page outside the desktop app', async () => {
  installWindow('https://kortix.com/pricing');
  const { container, unmount } = await mount(<GoogleTagManager gtmId="GTM-TEST" />);
  expect(container.querySelector('#_next-gtm-init')).not.toBeNull();
  expect(container.querySelector('#_next-gtm')).not.toBeNull();
  unmount();
});

test('GoogleTagManager never loads inside the desktop app', async () => {
  desktop = true;
  installWindow('https://kortix.com/pricing');
  const { container, unmount } = await mount(<GoogleTagManager gtmId="GTM-TEST" />);
  expect(container.querySelector('#_next-gtm')).toBeNull();
  unmount();
  desktop = false;
});

test('GoogleTagManager never loads on an excluded path', async () => {
  installWindow('https://kortix.com/en/workspaces');
  const { container, unmount } = await mount(<GoogleTagManager gtmId="GTM-TEST" />);
  expect(container.querySelector('#_next-gtm')).toBeNull();
  unmount();
});

/** A probe that exposes the hook's boolean as a DOM attribute. */
function GateProbe() {
  const enabled = useAnalyticsPageEnabled();
  return <div data-enabled={enabled ? 'true' : 'false'} />;
}

async function gateEnabled(): Promise<boolean> {
  const mounted = await mount(<GateProbe />);
  const enabled = mounted.container.firstElementChild!.getAttribute('data-enabled') === 'true';
  mounted.unmount();
  return enabled;
}

test('useAnalyticsPageEnabled is false in the desktop app', async () => {
  desktop = true;
  installWindow('https://kortix.com/pricing');
  expect(await gateEnabled()).toBe(false);
  desktop = false;
});

test('useAnalyticsPageEnabled is false on an excluded path', async () => {
  installWindow('https://kortix.com/en/workspaces');
  expect(await gateEnabled()).toBe(false);
});

test('useAnalyticsPageEnabled is true on a public page', async () => {
  installWindow('https://kortix.com/pricing');
  expect(await gateEnabled()).toBe(true);
});
