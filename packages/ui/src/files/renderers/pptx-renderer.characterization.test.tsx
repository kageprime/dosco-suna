/**
 * Characterization of the PPTX stage scale — the fixed 1040 px desktop stage
 * scaled down (never up) to fit its viewport, on a ResizeObserver.
 *
 * Pinned here so the stage-fit-scale dedupe cannot change what the pptx
 * viewer does: the stage keeps the library's desktop chrome down to narrow
 * panels by scaling visually instead of re-laying out, it never scales above
 * 1, and its scale follows the viewport element (not the window).
 *
 * The real pptx-react-viewer is stubbed: a fake deck's bytes are enough to
 * reach the stage; the viewer itself is not the behavior under test. The
 * ResizeObserver stub reports sizes the runner has no layout engine for.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Container, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

mock.module('pptx-react-viewer', () => ({
  PowerPointViewer: (props: { content?: Uint8Array; fileName?: string }) => (
    <div data-testid="stub-pptx-viewer" data-file-name={props.fileName} />
  ),
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const win = new Window({ width: 1440, height: 900 });
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.getComputedStyle = win.getComputedStyle.bind(win);
globals.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
globals.cancelAnimationFrame = (id: number) => clearTimeout(id);
for (const key of Object.getOwnPropertyNames(win)) {
  if (/^[A-Z]/.test(key) && !(key in globals)) globals[key] = Reflect.get(win, key);
}
for (const key of ['Event', 'CustomEvent', 'FocusEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent']) {
  globals[key] = Reflect.get(win, key);
}

// ── ResizeObserver stub ─────────────────────────────────────────────────────

type RoEntry = { contentRect: { width: number; height: number } };
type RoCallback = (entries: RoEntry[]) => void;

const realResizeObserver = globalThis.ResizeObserver;
const observers: Array<{ callback: RoCallback; element: Element }> = [];

class StubResizeObserver {
  constructor(callback: RoCallback) {
    observers.push({ callback, element: null as unknown as Element });
  }
  observe(element: Element) {
    observers[observers.length - 1].element = element;
  }
  disconnect() {
    observers.pop();
  }
}

(globalThis as { ResizeObserver: unknown }).ResizeObserver = StubResizeObserver;

/** Report a viewport size to every live observer, the way layout would. */
/** Report a viewport size to every live observer, the way layout would.
 *  Wrapped in act: the observer's callback sets component state. */
const reportSize = (width: number, height: number) => {
  act(() => {
    for (const { callback } of [...observers]) {
      callback([{ contentRect: { width, height } }]);
    }
  });
};

// ── mount harness ───────────────────────────────────────────────────────────

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => {
      root.unmount();
    });
  }
  win.document.body.innerHTML = '';
  observers.length = 0;
});

const renderPptx = async (blob: Blob | null) => {
  const { PptxRenderer } = await import('./pptx-renderer');
  const { IntlTestProvider } = await import('../../test-utils/intl');
  const host = win.document.createElement('div');
  win.document.body.appendChild(host);
  const root = createRoot(host as unknown as Container);
  roots.push(root);
  await act(async () => {
    root.render(
      <IntlTestProvider locale="en" onError={() => {}}>
        <PptxRenderer blob={blob} fileName="deck.pptx" />
      </IntlTestProvider>,
    );
  });
};

const stage = (): HTMLElement | null =>
  win.document.querySelector('[data-pptx-minimal]') as unknown as HTMLElement | null;

// ── the stage scale ─────────────────────────────────────────────────────────

describe('PptxRenderer stage scale', () => {
  test('narrow viewport: the stage stays 1040 px wide and scales down to fit', async () => {
    await renderPptx(new Blob([new Uint8Array([1])]));
    expect(win.document.querySelector('[data-testid="stub-pptx-viewer"]')).not.toBeNull();

    reportSize(520, 600);
    const el = stage();
    expect(el).not.toBeNull();
    expect(el!.style.width).toBe('1040px');
    expect(el!.style.transform).toBe('scale(0.5)');
  });

  test('wide viewport: never scales above 1 — full width, no transform', async () => {
    await renderPptx(new Blob([new Uint8Array([1])]));

    reportSize(2080, 1200);
    const el = stage();
    expect(el!.style.width).toBe('100%');
    expect(el!.style.transform).toBe('');
  });

  test('scale follows the viewport element: a resize updates the scale', async () => {
    await renderPptx(new Blob([new Uint8Array([1])]));

    reportSize(260, 600);
    expect(stage()!.style.transform).toBe('scale(0.25)');
    reportSize(780, 600);
    expect(stage()!.style.transform).toBe('scale(0.75)');
    reportSize(1040, 600);
    expect(stage()!.style.transform).toBe('');
  });

  test('the stage height never drives the scale — width fits alone', async () => {
    await renderPptx(new Blob([new Uint8Array([1])]));

    // A tall, wide-enough viewport: scale 1 even though the height is small
    // for a 1040 px stage; the height ratio is not part of the pptx fit.
    reportSize(2080, 100);
    expect(stage()!.style.transform).toBe('');
    expect(stage()!.style.width).toBe('100%');

    // And a narrow viewport with generous height scales by width only.
    reportSize(520, 5000);
    expect(stage()!.style.transform).toBe('scale(0.5)');
  });

  test('without bytes the viewer shows the loader, not the stage', async () => {
    await renderPptx(null);
    expect(stage()).toBeNull();
    expect(win.document.querySelector('[data-testid="stub-pptx-viewer"]')).toBeNull();
  });
});
