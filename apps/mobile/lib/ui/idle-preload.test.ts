import { describe, expect, test } from 'bun:test';
import { preloadWhenIdle, type IdleScheduler } from './idle-preload';

// A manual scheduler: the test decides when the delay ends and when the JS
// thread is idle.
function manualScheduler() {
  const timeouts = new Map<number, () => void>();
  const idles = new Map<number, () => void>();
  let id = 0;
  const scheduler: IdleScheduler = {
    setTimeout: (callback) => (timeouts.set(++id, callback), id),
    clearTimeout: (handle) => void timeouts.delete(handle as number),
    requestIdleCallback: (callback) => (idles.set(++id, callback), id),
    cancelIdleCallback: (handle) => void idles.delete(handle as number),
  };
  const run = (queue: Map<number, () => void>) => {
    const [key, callback] = [...queue.entries()][0] ?? [];
    if (key === undefined || !callback) return false;
    queue.delete(key);
    callback();
    return true;
  };
  return {
    scheduler,
    endDelay: () => run(timeouts),
    idle: () => run(idles),
    pending: () => timeouts.size + idles.size,
  };
}

describe('preloadWhenIdle', () => {
  test('nothing loads before the delay; then one module per idle slice, in order', () => {
    const clock = manualScheduler();
    const loaded: string[] = [];
    preloadWhenIdle(['a', 'b', 'c'].map((name) => () => loaded.push(name)), 1_500, clock.scheduler);

    expect(loaded).toEqual([]);
    clock.endDelay();
    expect(loaded).toEqual([]);
    clock.idle();
    expect(loaded).toEqual(['a']);
    clock.idle();
    expect(loaded).toEqual(['a', 'b']);
    clock.idle();
    expect(loaded).toEqual(['a', 'b', 'c']);
    expect(clock.pending()).toBe(0);
  });

  test('a loader that throws is skipped and the rest still load', () => {
    const clock = manualScheduler();
    const loaded: string[] = [];
    const loaders = [
      () => loaded.push('a'),
      () => {
        throw new Error('module failed');
      },
      () => loaded.push('c'),
    ];
    preloadWhenIdle(loaders, 0, clock.scheduler);
    clock.endDelay();
    while (clock.idle());
    expect(loaded).toEqual(['a', 'c']);
  });

  test('cancel stops the loaders not yet run, before or during the idle slices', () => {
    const before = manualScheduler();
    const loadedBefore: string[] = [];
    preloadWhenIdle([() => loadedBefore.push('a')], 1_500, before.scheduler)();
    expect(before.pending()).toBe(0);
    expect(loadedBefore).toEqual([]);

    const during = manualScheduler();
    const loadedDuring: string[] = [];
    const cancel = preloadWhenIdle(['a', 'b'].map((name) => () => loadedDuring.push(name)), 0, during.scheduler);
    during.endDelay();
    during.idle();
    cancel();
    expect(during.pending()).toBe(0);
    expect(loadedDuring).toEqual(['a']);
  });
});
