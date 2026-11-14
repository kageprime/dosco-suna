import { afterEach, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, StrictMode, useEffect } from 'react';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
const win = new Window({ url: 'http://localhost/workspaces/p1' });
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
for (const key of Object.getOwnPropertyNames(win)) {
  if (/^[A-Z]/.test(key) && (!(key in globals) || key.endsWith('Event'))) {
    globals[key] = Reflect.get(win, key);
  }
}
const { createRoot } = await import('react-dom/client');

const realNav = await import('next/navigation');
let pathname = '/workspaces/p1';
mock.module('next/navigation', () => ({ ...realNav, usePathname: () => pathname }));
const { useComposerPrefillStore } = await import('@kortix/ui/internal/stores/composer-prefill-store');
const { useHomeTypingBuffer } = await import('./use-home-typing-buffer');

const consumed: unknown[] = [];

/** Stands in for `ProjectHome`: a child that consumes the store in a passive effect. */
function Home() {
  const pending = useComposerPrefillStore((s) => s.prefillByProject.p1);
  useEffect(() => {
    if (!pending) return;
    // As the real hosts do: apply what `consume` returns, not the render snapshot.
    const taken = useComposerPrefillStore.getState().consume('p1');
    if (taken) consumed.push(taken);
  }, [pending]);
  return null;
}

function Boundary({ home = true, user = 'u1' }: { home?: boolean; user?: string | null }) {
  useHomeTypingBuffer(user);
  return home ? <Home /> : null;
}

const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container as unknown as Element);

function press(key: string, target: EventTarget = document.body) {
  act(() => {
    target.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }) as unknown as Event);
  });
}

afterEach(() => {
  act(() => root.render(null));
  consumed.length = 0;
  pathname = '/workspaces/p1';
  useComposerPrefillStore.setState({ prefillByProject: {} });
});

test('keys typed before the editor exists are stored for the home composer', () => {
  act(() => root.render(<Boundary />));
  press('h');
  press('i');
  expect(consumed.at(-1)).toEqual({ text: 'hi', restoreDraft: true });
});

test('a prompt handed over before mount wins, even after the child consumed it first', () => {
  useComposerPrefillStore.getState().setPrefill('p1', 'Quick Entry prompt', { submit: true });
  act(() => root.render(<Boundary />));
  expect(consumed).toEqual([{ text: 'Quick Entry prompt', submit: true }]);
  press('x');
  expect(useComposerPrefillStore.getState().prefillByProject.p1).toBeUndefined();
  expect(consumed).toHaveLength(1);
});

test('a focused control keeps its keys', () => {
  act(() => root.render(<Boundary />));
  const button = document.createElement('button');
  document.body.appendChild(button);
  const event = new win.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
  act(() => {
    button.dispatchEvent(event as unknown as Event);
  });
  expect(event.defaultPrevented).toBe(false);
  expect(consumed).toHaveLength(0);
  button.remove();
});

test('a body key is taken: Space does not scroll the page', () => {
  act(() => root.render(<Boundary />));
  const event = new win.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
  act(() => {
    document.body.dispatchEvent(event as unknown as Event);
  });
  expect(event.defaultPrevented).toBe(true);
  expect(consumed.at(-1)).toEqual({ text: ' ', restoreDraft: true });
});

test('StrictMode re-running the effect keeps the handover', () => {
  useComposerPrefillStore.getState().setPrefill('p1', 'Quick Entry prompt', { submit: true });
  act(() =>
    root.render(
      <StrictMode>
        <Boundary />
      </StrictMode>,
    ),
  );
  press('x');
  expect(useComposerPrefillStore.getState().prefillByProject.p1).toBeUndefined();
  // StrictMode also replays the stand-in's effect, whose second consume finds nothing.
  expect(consumed).toEqual([{ text: 'Quick Entry prompt', submit: true }]);
});

test('home redirecting to the chat route keeps the keys for the chat composer', () => {
  act(() => root.render(<Boundary home={false} />));
  press('h');
  press('i');
  pathname = '/workspaces/p1/chat';
  act(() => root.render(<Boundary home={false} />));
  // The chat composer is still loading: keys typed now join the buffer.
  press('!');
  expect(useComposerPrefillStore.getState().prefillByProject.p1).toEqual({ text: 'hi!', restoreDraft: true });
});

test('another account signing in on the same tab never receives the buffer', () => {
  act(() => root.render(<Boundary home={false} user="u1" />));
  press('s');
  press('e');
  act(() => root.render(<Boundary home={false} user={null} />));
  act(() => root.render(<Boundary home={false} user="u2" />));
  expect(useComposerPrefillStore.getState().prefillByProject.p1).toBeUndefined();
});

test('the session resolving on a hard load keeps the buffer', () => {
  act(() => root.render(<Boundary home={false} user={null} />));
  press('h');
  act(() => root.render(<Boundary home={false} user="u1" />));
  press('i');
  expect(useComposerPrefillStore.getState().prefillByProject.p1).toEqual({ text: 'hi', restoreDraft: true });
});

test('the auth bootstrap flickering to null and back keeps the buffer', () => {
  act(() => root.render(<Boundary home={false} user="u1" />));
  press('h');
  act(() => root.render(<Boundary home={false} user={null} />));
  act(() => root.render(<Boundary home={false} user="u1" />));
  press('i');
  expect(useComposerPrefillStore.getState().prefillByProject.p1).toEqual({ text: 'hi', restoreDraft: true });
});

test('a home mounting for the next account in the same commit gets nothing', () => {
  act(() => root.render(<Boundary home={false} user="u1" />));
  press('s');
  press('e');
  // The next account's home renders while the entry still exists; the hook's
  // layout effect drops it before the home's passive consume runs.
  act(() => root.render(<Boundary home user="u2" />));
  expect(consumed).toEqual([]);
  expect(useComposerPrefillStore.getState().prefillByProject.p1).toBeUndefined();
});

test('a buffer left behind by an earlier mount never reaches the next one', () => {
  act(() => root.render(<Boundary home={false} user="u1" />));
  press('s');
  // Leave every workspace page: the buffer unmounts with its entry still stored.
  act(() => root.render(null));
  // Another account opens the workspace home later in the same tab.
  act(() => root.render(<Boundary user="u2" />));
  expect(consumed).toEqual([]);
  expect(useComposerPrefillStore.getState().prefillByProject.p1).toBeUndefined();
});

test('a prompt handed over by another surface survives the mount', () => {
  useComposerPrefillStore.getState().setPrefill('p1', 'Quick Entry prompt', { submit: true });
  act(() => root.render(<Boundary />));
  expect(consumed).toEqual([{ text: 'Quick Entry prompt', submit: true }]);
});

test('an account change also drops a handed-over prompt and the buffer text', () => {
  act(() => root.render(<Boundary home={false} user="u1" />));
  press('s');
  useComposerPrefillStore.getState().setPrefill('p2', 'quick entry prompt', { submit: true });
  act(() => root.render(<Boundary home={false} user="u2" />));
  expect(useComposerPrefillStore.getState().prefillByProject).toEqual({});
  // The next account's keys start a fresh buffer: nothing of "s" survives.
  press('x');
  expect(useComposerPrefillStore.getState().prefillByProject.p1).toEqual({ text: 'x', restoreDraft: true });
});
