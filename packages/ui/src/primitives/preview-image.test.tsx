/**
 * Characterization of `PreviewImageContent` — the zoomable image dialog.
 *
 * The dialog renders its body through a portal, and a portal renders nothing
 * during SSR. The test mounts the open dialog on happy-dom (the
 * floating-panel-motion.test.tsx pattern) and reads the page markup.
 *
 * Pinned here are the pieces a dead-code sweep must not touch: the
 * visually-hidden dialog title, the close control, the zoom wrapper (its
 * resting `cursor-zoom-in` cursor and scale / transform-origin / transition
 * style) and the image itself.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Container, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

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

const { PreviewImage, PreviewImageContent } = await import('./preview-image');

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => {
      root.unmount();
    });
  }
  win.document.body.innerHTML = '';
});

const IMAGE_SRC = 'data:image/png;base64,AAAA';

const renderDialog = async (fileContent: string | null = IMAGE_SRC, fileName = 'demo.png') => {
  const host = win.document.createElement('div');
  win.document.body.appendChild(host);
  const root = createRoot(host as unknown as Container);
  roots.push(root);
  await act(async () => {
    root.render(
      <PreviewImage open>
        <PreviewImageContent fileContent={fileContent ?? undefined} fileName={fileName} />
      </PreviewImage>,
    );
  });
  return win.document.body.innerHTML;
};

describe('PreviewImageContent — the zoomable image dialog', () => {
  test('renders the dialog with its hidden title and close control', async () => {
    const html = await renderDialog();

    expect(html).toContain('role="dialog"');
    expect(html).toContain('Image preview');
    expect(html).toContain('aria-label="Close image preview"');
  });

  test('renders the zoom wrapper at rest and the image', async () => {
    const html = await renderDialog();

    expect(html).toContain('cursor-zoom-in');
    expect(html).toContain('transform: scale(1)');
    expect(html).toContain('transform-origin: 50% 50%');
    expect(html).toContain('transition: transform 200ms');
    expect(html).toContain('<img');
    expect(html).toContain('alt="demo.png"');
    expect(html).toContain(`src="${IMAGE_SRC}"`);
    expect(html).toContain('width="1920"');
    expect(html).toContain('height="1080"');
    expect(html).toContain('max-h-[100vh] w-auto object-contain');
  });

  test('renders the dialog but no image when there is no source', async () => {
    const html = await renderDialog(null);

    expect(html).toContain('role="dialog"');
    expect(html).not.toContain('<img');
  });

  test('keeps the exports the only call site imports', async () => {
    const mod = await import('./preview-image');

    for (const name of [
      'PreviewImage',
      'PreviewImageClose',
      'PreviewImageContent',
      'PreviewImageOverlay',
      'PreviewImagePortal',
      'PreviewImageTrigger',
    ]) {
      expect(name in mod).toBe(true);
    }
  });
});
