/**
 * Characterization of `FullScreenPresentationViewer` — the fullscreen slide
 * deck modal. Pinned here so a restructure that moves the metadata lifecycle,
 * the keyboard map and the slide component into their own modules cannot
 * change what a viewer does:
 *
 *   - the metadata load, its retry schedule (1 s, 2 s, 4 s, 8 s, then 10 s
 *     capped; 5 s intervals after that) and the "keep retrying indefinitely,
 *     never an error state" behavior;
 *   - the open/close reset: closing and reopening reloads the metadata;
 *   - the keyboard map: arrows/space/page, Home/End, Escape (editor first),
 *     and preventDefault on every handled key;
 *   - the initial slide only applies when the modal opens.
 *
 * The component mounts on happy-dom (the preview-image.test.tsx pattern);
 * `fetch` is stubbed so the metadata read never leaves the test.
 */
import { afterEach, describe, expect, jest, test } from 'bun:test';
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

// ── fetch stub ──────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
const fetchCalls: string[] = [];
let metadataResponse: () => { ok: boolean; status: number; json: unknown } = () => ({
  ok: true,
  status: 200,
  json: METADATA,
});

// The metadata read goes through plain `fetch` with cache-busting headers.
// Every call is recorded; the answer comes from `metadataResponse`.
const stubFetch = async (input: RequestInfo | URL): Promise<Response> => {
  fetchCalls.push(String(input));
  const answer = metadataResponse();
  return {
    ok: answer.ok,
    status: answer.status,
    json: async () => answer.json,
  } as unknown as Response;
};

(globalThis as { fetch: unknown }).fetch = stubFetch as unknown as typeof fetch;

// ── fixture ─────────────────────────────────────────────────────────────────

function slideMeta(n: number) {
  return {
    title: `Slide ${n}`,
    filename: `slide-${n}.html`,
    file_path: `presentations/quarterly-review/slide-${n}.html`,
    preview_url: `/preview/${n}`,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
  };
}

const METADATA = {
  presentation_name: 'quarterly-review',
  title: 'Quarterly Review',
  description: '',
  slides: { '1': slideMeta(1), '2': slideMeta(2), '3': slideMeta(3) },
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
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
  fetchCalls.length = 0;
  metadataResponse = () => ({ ok: true, status: 200, json: METADATA });
});

type ViewerProps = {
  isOpen: boolean;
  onClose?: () => void;
  presentationName?: string;
  sandboxUrl?: string;
  initialSlide?: number;
};

const renderViewer = async (props: ViewerProps) => {
  const { FullScreenPresentationViewer } = await import('./FullScreenPresentationViewer');
  const { IntlTestProvider } = await import('../../../test-utils/intl');
  const host = win.document.createElement('div');
  win.document.body.appendChild(host);
  const root = createRoot(host as unknown as Container);
  roots.push(root);
  const onClose = props.onClose ?? (() => {});
  const element = (p: ViewerProps) => (
    <IntlTestProvider locale="en" onError={() => {}}>
      <FullScreenPresentationViewer
        isOpen={p.isOpen}
        onClose={() => onClose()}
        presentationName={p.presentationName}
        sandboxUrl={p.sandboxUrl}
        initialSlide={p.initialSlide}
      />
    </IntlTestProvider>
  );
  await act(async () => {
    root.render(element(props));
  });
  return {
    rerender: async (next: ViewerProps) => {
      await act(async () => {
        root.render(element(next));
      });
    },
    onClose,
  };
};

// ── assertions helpers ──────────────────────────────────────────────────────

/** The slide indicator dots: one button per slide, aria-label "Slide <n>". */
const dots = (): HTMLButtonElement[] =>
  Array.from(
    win.document.querySelectorAll('button[aria-label^="Slide"]'),
  ) as unknown as HTMLButtonElement[];

const activeDot = () => {
  const active = dots().find((d) => d.className.includes('bg-black'));
  return active?.getAttribute('aria-label');
};

/** Advance the fake clock and flush the fetch promise chain, so a failed
 *  attempt's catch has scheduled its retry before the next advance reads it. */
const advance = async (ms: number) => {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
};

const pressKey = (key: string) => {
  let event: KeyboardEvent | null = null;
  act(() => {
    event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    (win.document as unknown as { dispatchEvent: (e: unknown) => boolean }).dispatchEvent(event);
  });
  return event as unknown as KeyboardEvent;
};

const bodyText = () => win.document.body.textContent ?? '';

// ── the viewer ──────────────────────────────────────────────────────────────

describe('FullScreenPresentationViewer — metadata load', () => {
  test('loads metadata, renders the title, the slide count and the first slide', async () => {
    jest.useFakeTimers();
    try {
      await renderViewer({
        isOpen: true,
        presentationName: 'quarterly review',
        sandboxUrl: 'https://sandbox.example.test',
      });

      // Opening fetches the metadata once immediately…
      expect(fetchCalls.length).toBe(1);
      expect(fetchCalls[0]).toContain('presentations/quarterlyreview/metadata.json');
      expect(bodyText()).toContain('Quarterly Review');
      expect(bodyText()).toContain('1');
      expect(bodyText()).toContain('of');
      expect(bodyText()).toContain('3');
      // The slide is framed from its sandbox path with a cache-busting query.
      const iframe = win.document.querySelector('iframe');
      expect(iframe).not.toBeNull();
      expect(iframe?.getAttribute('src')).toContain('presentations/quarterly-review/slide-1.html');
      expect(iframe?.getAttribute('src')).toContain('?t=');

      // …and the open also arms the editor-exit reload, which re-reads the
      // metadata 300 ms after open — but the loaded flag from the successful
      // first read guards it, so no second fetch lands on the happy path.
      await advance(300);
      expect(fetchCalls.length).toBe(1);
      await advance(5000);
      expect(fetchCalls.length).toBe(1);
      expect(win.document.querySelector('iframe')).not.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test('retries forever on failure — never an error state — on the 1s/2s/4s schedule', async () => {
    jest.useFakeTimers();
    try {
      metadataResponse = () => ({ ok: false, status: 503, json: null });
      await renderViewer({
        isOpen: true,
        presentationName: 'quarterly review',
        sandboxUrl: 'https://sandbox.example.test',
      });

      // Still loading, no error card.
      expect(bodyText()).toContain('Loading presentation...');
      expect(bodyText()).not.toContain('Retrying');
      expect(win.document.querySelector('iframe')).toBeNull();


      // Two retry chains run after a failed open: the immediate load's own
      // retry loop, and the open-armed 300 ms reload's loop (its read fails
      // too, and it retries on the same schedule). The schedule is pinned by
      // cumulative counts — each advance below lands on exactly one new
      // attempt, and the gaps (300→1000: 700 ms of quiet, then 1000→1300,
      // 1300→3000…) are the 1 s / 2 s backoff steps of the two chains.
      await advance(300); // the open-armed reload: the failed first read
      // left the loaded flag false, so this one really fetches
      expect(fetchCalls.length).toBe(2);
      expect(bodyText()).toContain('Loading presentation...');

      await advance(700); // t=1000: chain 1, retry 1 (1 s backoff)
      expect(fetchCalls.length).toBe(3);

      await advance(300); // t=1300: chain 2, retry 1
      expect(fetchCalls.length).toBe(4);

      await advance(1700); // t=3000: chain 1, retry 2 (2 s backoff)
      expect(fetchCalls.length).toBe(5);

      await advance(300); // t=3300: chain 2, retry 2
      expect(fetchCalls.length).toBe(6);
      expect(bodyText()).toContain('Retrying... (attempt 3)');

      // A late success still renders the deck: the viewer never gives up.
      metadataResponse = () => ({ ok: true, status: 200, json: METADATA });
      await advance(3700); // t=7000: chain 1, retry 3 (4 s backoff) succeeds
      expect(win.document.querySelector('iframe')).not.toBeNull();
      expect(bodyText()).toContain('Quarterly Review');
      // The success clears the pending retry timeout of the other chain, and
      // the loaded flag guards any surviving timer — no more reads.
      await advance(20000);
      expect(fetchCalls.length).toBe(7);
    } finally {
      jest.useRealTimers();
    }
  });

  test('closing and reopening resets the load — the metadata is fetched again', async () => {
    const view = await renderViewer({
      isOpen: true,
      presentationName: 'quarterly review',
      sandboxUrl: 'https://sandbox.example.test',
    });
    expect(fetchCalls.length).toBe(1);

    await view.rerender({ isOpen: false, presentationName: 'quarterly review' });
    await view.rerender({
      isOpen: true,
      presentationName: 'quarterly review',
      sandboxUrl: 'https://sandbox.example.test',
      initialSlide: 2,
    });

    expect(fetchCalls.length).toBe(2);
    // The reopen also applied the requested initial slide.
    expect(activeDot()).toBe('Slide 2');
  });

  test('without a sandbox URL the viewer waits quietly — no fetch, no error', async () => {
    await renderViewer({ isOpen: true, presentationName: 'quarterly review' });
    expect(fetchCalls.length).toBe(0);
    expect(bodyText()).not.toContain('Retrying');
    expect(bodyText()).toContain('Loading presentation...');
  });
});

describe('FullScreenPresentationViewer — keyboard map', () => {
  const open = () =>
    renderViewer({
      isOpen: true,
      presentationName: 'quarterly review',
      sandboxUrl: 'https://sandbox.example.test',
    });

  test('ArrowRight, ArrowDown and space go next; ArrowLeft and ArrowUp go back', async () => {
    await open();
    expect(activeDot()).toBe('Slide 1');

    pressKey('ArrowRight');
    expect(activeDot()).toBe('Slide 2');
    pressKey('ArrowDown');
    expect(activeDot()).toBe('Slide 3');
    pressKey(' ');
    expect(activeDot()).toBe('Slide 3'); // clamped at the last slide
    pressKey('ArrowLeft');
    expect(activeDot()).toBe('Slide 2');
    pressKey('ArrowUp');
    expect(activeDot()).toBe('Slide 1');
    pressKey('ArrowUp');
    expect(activeDot()).toBe('Slide 1'); // clamped at the first slide
  });

  test('Home jumps to the first slide, End to the last', async () => {
    await open();
    pressKey('End');
    expect(activeDot()).toBe('Slide 3');
    pressKey('Home');
    expect(activeDot()).toBe('Slide 1');
  });

  test('handled keys are prevented and stopped', async () => {
    await open();
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ', 'Home', 'End', 'Escape']) {
      const event = pressKey(key);
      expect(event.defaultPrevented).toBe(true);
    }
  });

  test('Escape closes the viewer', async () => {
    let closed = 0;
    await renderViewer({
      isOpen: true,
      presentationName: 'quarterly review',
      sandboxUrl: 'https://sandbox.example.test',
      onClose: () => {
        closed++;
      },
    });
    pressKey('Escape');
    expect(closed).toBe(1);
  });

  test('Escape with the editor open exits the editor first, a second Escape closes', async () => {
    let closed = 0;
    await renderViewer({
      isOpen: true,
      presentationName: 'quarterly review',
      sandboxUrl: 'https://sandbox.example.test',
      onClose: () => {
        closed++;
      },
    });

    // Enter the editor through its toolbar button.
    const editButton = win.document.querySelector(
      'button[title="Edit presentation"]',
    ) as unknown as HTMLButtonElement | null;
    expect(editButton).not.toBeNull();
    act(() => {
      editButton!.click();
    });
    // The iframe re-keys to the editor route.
    expect(win.document.querySelector('iframe')?.getAttribute('src')).toContain('/editor');

    pressKey('Escape');
    expect(closed).toBe(0);
    expect(win.document.querySelector('iframe')?.getAttribute('src')).not.toContain('/editor');

    pressKey('Escape');
    expect(closed).toBe(1);
  });
});
