import { afterEach, expect, jest, spyOn, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useNow } from './use-now';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const START = new Date('2026-11-08T10:00:00.000Z').getTime();

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  jest.useRealTimers();
});

async function mount(seen: number[], intervalMs?: number, active?: boolean) {
  function Probe() {
    seen.push(useNow(intervalMs, active));
    return null;
  }
  await act(async () => {
    renderer = create(React.createElement(Probe));
  });
}

test('inactive: no tick while inactive — the initial render is the only one', async () => {
  jest.useFakeTimers({ now: START });
  const seen: number[] = [];
  await mount(seen, 10, false);
  await act(async () => {
    jest.advanceTimersByTime(100);
  });
  expect(seen).toEqual([START]);
});

test('one tick per interval: a 10 ms clock ticks once per 10 ms', async () => {
  jest.useFakeTimers({ now: START });
  const seen: number[] = [];
  await mount(seen, 10, true);
  expect(seen).toEqual([START]);
  await act(async () => {
    jest.advanceTimersByTime(10);
  });
  await act(async () => {
    jest.advanceTimersByTime(10);
  });
  await act(async () => {
    jest.advanceTimersByTime(10);
  });
  expect(seen.length).toBe(4);
  for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
});

test('the default interval is one second', async () => {
  jest.useFakeTimers({ now: START });
  const seen: number[] = [];
  await mount(seen);
  await act(async () => {
    jest.advanceTimersByTime(999);
  });
  expect(seen).toEqual([START]);
  await act(async () => {
    jest.advanceTimersByTime(1);
  });
  expect(seen.length).toBe(2);
});

test('no interval left running on unmount', async () => {
  jest.useFakeTimers({ now: START });
  const seen: number[] = [];
  await mount(seen, 10, true);
  await act(async () => {
    jest.advanceTimersByTime(10);
  });
  expect(seen.length).toBe(2);
  // React ignores a setState after unmount, so a leaked interval is invisible
  // in the render count — assert the cleanup actually cleared the timer.
  const clearSpy = spyOn(globalThis, 'clearInterval');
  try {
    await act(async () => {
      renderer?.unmount();
    });
    expect(clearSpy).toHaveBeenCalled();
  } finally {
    clearSpy.mockRestore();
  }
});
