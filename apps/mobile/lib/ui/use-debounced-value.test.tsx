/**
 * The shared search debounce hook: the value lags by `delayMs`, a change inside
 * the window restarts the timer, and unmount clears it. The clock is a manual
 * fake, as `use-field-refocus.test.tsx`.
 */
import { afterEach, expect, test } from 'bun:test';
import React from 'react';
import { type ReactTestRenderer, act, create } from 'react-test-renderer';

const { useDebouncedValue } = await import('./use-debounced-value');
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let tree: ReactTestRenderer | undefined;
afterEach(() => {
  if (tree) act(() => tree?.unmount());
  tree = undefined;
});

test('the value lags by delayMs, a change inside the window restarts the timer, unmount clears it', () => {
  const timers = new Map<number, { at: () => void; delayMs: number }>();
  let nextTimer = 0;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  /** The one pending timer: the hook keeps at most one alive. */
  const pending = () => {
    expect(timers.size).toBe(1);
    return [...timers.entries()][0]!;
  };
  function Field({ value, delayMs }: { value: string; delayMs: number }) {
    const debounced = useDebouncedValue(value, delayMs);
    return React.createElement('value', { text: debounced });
  }
  try {
    globalThis.setTimeout = ((callback: () => void, delayMs?: number) => {
      const id = ++nextTimer;
      timers.set(id, { at: callback, delayMs: delayMs ?? 0 });
      return id;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => {
      timers.delete(id);
    }) as unknown as typeof clearTimeout;

    act(() => {
      tree = create(<Field value="a" delayMs={250} />);
    });
    const text = () =>
      tree!.root.findAll((n) => String(n.type) === 'value')[0]!.props.text as string;
    expect(text()).toBe('a');
    const [firstId, first] = pending();
    expect(first.delayMs).toBe(250);

    act(() => tree!.update(<Field value="b" delayMs={250} />));
    // Still the old value: nothing fired yet; the restart replaced the timer.
    expect(text()).toBe('a');
    const [secondId] = pending();
    act(() => timers.get(secondId)!.at());
    expect(text()).toBe('b');

    // A change inside the window restarts the timer: one pending timer, the latest value wins.
    act(() => tree!.update(<Field value="c" delayMs={250} />));
    act(() => tree!.update(<Field value="d" delayMs={250} />));
    // The window is still open: the old value, one pending timer.
    expect(text()).toBe('b');
    expect(timers.size).toBe(1);
    const [lastId] = pending();
    act(() => timers.get(lastId)!.at());
    expect(text()).toBe('d');
    // The restarted timers never fired: only the last value landed.
    expect(timers.has(firstId)).toBe(false);
    expect(timers.has(secondId)).toBe(false);

    act(() => tree!.unmount());
    tree = undefined;
    expect(timers.size).toBe(0);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
