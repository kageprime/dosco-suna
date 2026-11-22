/**
 * The call card's drag wiring, mounted: a real `VoiceCallCard` on happy-dom
 * (the artifact-frame.test.tsx setup), dragged with PointerEvents. The pure
 * spot maths is use-call-card-position.test.ts; here the card itself — the
 * default corner until dragged, a drag on the card moves it and saves it, a
 * press on a control never drags, and a remount reads the saved spot back
 * (what a reload sees).
 */
import { afterEach, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';

import { useVoiceCallStore } from './voice-call-store';

// The mounted card long-polls /start through the SDK; a test has no API. A
// failed, non-retriable start renders the ended card at once — no ringback,
// no relay socket — which is all the drag wiring needs. The other names are
// the module's imports the card tree loads (unused on this path).
mock.module('@kortix/sdk', () => ({
  startProjectSession: async () => ({ stage: 'failed', retriable: false }),
  getAuthToken: async () => null,
  getSandboxUrlForExternalId: () => '/sandbox/none',
  probePreviewPort: async () => ({ alive: false }),
}));

const { VoiceCallCard } = await import('./voice-call-card');

const SPOT_KEY = 'kortix-voice-call-card';

const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
globals.IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  win: Window;
  card: HTMLElement;
  remount: () => Promise<void>;
  close: () => Promise<void>;
}

let mounted: Mounted | undefined;

afterEach(async () => {
  await mounted?.close();
  mounted = undefined;
  useVoiceCallStore.setState({ call: null, cards: 0 });
});

/** Mount the real card with a placed call; `seed` runs before it, on the window. */
async function mountCard(seed?: (win: Window) => void): Promise<Mounted> {
  const win = new Window({ url: 'https://app.example.test/projects/p1' });
  // happy-dom lays nothing out (every box is zero), so the hook declines to clamp against an
  // unmeasured card. Give every element the real card's box (w-80: 320px wide, ~120 tall) so
  // the clamp maths runs as it does in a browser.
  Object.defineProperty(win.HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 120, width: 320, height: 120, toJSON: () => ({}) }),
  });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ['window', 'document', 'navigator', 'Element', 'HTMLElement']) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: (win as unknown as Record<string, unknown>)[key],
    });
  }
  seed?.(win);
  useVoiceCallStore.getState().place({ projectId: 'p1', sessionId: 's1', agent: 'kortix' });
  const { createRoot } = await import('react-dom/client');
  const container = win.document.createElement('div');
  win.document.body.append(container);
  let root: Awaited<ReturnType<typeof createRoot>> | undefined;
  const renderInto = async () => {
    // A root is single-use: a remount unmounts the old one first (as a reload makes a fresh page).
    await act(async () => root?.unmount());
    root = createRoot(container as unknown as Element);
    await act(async () => root?.render(<VoiceCallCard />));
    // The /start long-poll fails (the mock) and the ended card replaces the calling one.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // Any timers the brief calling state scheduled (the tooltip's 300ms delay), drained inside
    // act so nothing updates the tree after it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
  };
  await renderInto();
  const card = () => container.querySelector('section[aria-label]') as unknown as HTMLElement;
  const handle: Mounted = {
    win,
    get card() {
      return card();
    },
    remount: () => renderInto(),
    close: async () => {
      await act(async () => root?.unmount());
      await win.happyDOM.close();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
  mounted = handle;
  return handle;
}

/** A pointer sequence on the card, the way a hand makes one. */
async function drag(m: Mounted, from: [number, number], to: [number, number], on: (card: HTMLElement) => Element = (card) => card): Promise<void> {
  const target = on(m.card);
  const opts = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true };
  // happy-dom's event classes do not extend the DOM-lib types, so each dispatch crosses the bridge.
  await act(async () => {
    const events = [
      new m.win.PointerEvent('pointerdown', { ...opts, clientX: from[0], clientY: from[1], button: 0 }),
      new m.win.PointerEvent('pointermove', { ...opts, clientX: to[0], clientY: to[1] }),
      new m.win.PointerEvent('pointerup', { ...opts, clientX: to[0], clientY: to[1] }),
    ];
    for (const event of events) target.dispatchEvent(event as unknown as Event);
  });
}

test('the card sits at its default corner until dragged', async () => {
  const m = await mountCard();
  expect(m.card.style.left).toBe('');
  expect(m.card.style.top).toBe('');
  expect(m.card.className).toContain('right-4');
  expect(m.card.className).toContain('bottom-4');
});

test('a drag on the card moves it and saves the spot', async () => {
  const m = await mountCard();
  await drag(m, [100, 100], [300, 200]);
  // happy-dom lays nothing out (a zero box), so no clamp applies: the raw spot lands.
  expect(m.card.style.left).toBe('200px');
  expect(m.card.style.top).toBe('100px');
  expect(JSON.parse(m.win.localStorage.getItem(SPOT_KEY) ?? '')).toEqual({ left: 200, top: 100 });
});

test('a press on a control never drags the card', async () => {
  const m = await mountCard();
  // The close button (the X): a press there ends the call, it must not move the card.
  const close = m.card.querySelector('button[aria-label="Close"]') ?? m.card.querySelector('button:last-of-type');
  expect(close).toBeTruthy();
  await drag(m, [100, 100], [300, 200], () => close as unknown as Element);
  expect(m.card.style.left).toBe('');
  expect(m.card.style.top).toBe('');
  expect(m.win.localStorage.getItem(SPOT_KEY)).toBe(null);
});

test('a remount reads the saved spot back — what a reload sees', async () => {
  const m = await mountCard((win) => win.localStorage.setItem(SPOT_KEY, JSON.stringify({ left: 240, top: 80 })));
  expect(m.card.style.left).toBe('240px');
  expect(m.card.style.top).toBe('80px');
  // And it survives the card's own unmount/remount cycle (the call ending and starting again).
  await m.remount();
  expect(m.card.style.left).toBe('240px');
  expect(m.card.style.top).toBe('80px');
});

test('a spot saved off screen comes back on screen', async () => {
  const m = await mountCard((win) => win.localStorage.setItem(SPOT_KEY, JSON.stringify({ left: 5000, top: 5000 })));
  // The window is 1024×768 and the card's box is 320×120 (the stubbed box), so the spot
  // pins inside it: 1024−320 = 704, 768−120 = 648.
  expect(m.card.style.left).toBe('704px');
  expect(m.card.style.top).toBe('648px');
  // A smaller window pulls it back again: 800−320 = 480, 600−120 = 480.
  Object.defineProperty(m.win, 'innerWidth', { configurable: true, value: 800 });
  Object.defineProperty(m.win, 'innerHeight', { configurable: true, value: 600 });
  await act(async () => {
    m.win.dispatchEvent(new m.win.Event('resize'));
  });
  expect(m.card.style.left).toBe('480px');
  expect(m.card.style.top).toBe('480px');
});

test('a broken save reads as no spot — the default corner, never a crash', async () => {
  const m = await mountCard((win) => win.localStorage.setItem(SPOT_KEY, '{"left": nope'));
  expect(m.card.style.left).toBe('');
  expect(m.card.className).toContain('right-4');
  expect(m.card.className).toContain('bottom-4');
});
