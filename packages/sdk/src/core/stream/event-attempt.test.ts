import { afterEach, expect, jest, spyOn, test } from 'bun:test';
import { abortableDelay } from './event-attempt';
import type { EventStreamTimers } from './event-stream';

const timers: EventStreamTimers = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('elapsed reconnect backoffs release every abort listener on the lifetime signal', async () => {
  jest.useFakeTimers();
  const controller = new AbortController();
  const add = spyOn(controller.signal, 'addEventListener');
  const remove = spyOn(controller.signal, 'removeEventListener');
  for (let i = 0; i < 20; i++) {
    const wait = abortableDelay(timers, controller.signal, 1000);
    jest.advanceTimersByTime(1000);
    await wait;
  }
  expect(add).toHaveBeenCalledTimes(20);
  expect(remove).toHaveBeenCalledTimes(20);
  for (let i = 0; i < 20; i++) {
    expect(remove.mock.calls[i]?.[1]).toBe(add.mock.calls[i]?.[1]);
  }
  controller.abort();
  expect(remove).toHaveBeenCalledTimes(20);
});

test('an already aborted signal resolves without scheduling a backoff', async () => {
  jest.useFakeTimers();
  const controller = new AbortController();
  controller.abort();
  const schedule = spyOn(timers, 'setTimeout');
  let settled = false;
  const wait = abortableDelay(timers, controller.signal, 30_000).then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(true);
  expect(schedule).not.toHaveBeenCalled();
  await wait;
});

test('abort during backoff resolves and clears its timer exactly once', async () => {
  jest.useFakeTimers();
  const controller = new AbortController();
  const clear = spyOn(timers, 'clearTimeout');
  const remove = spyOn(controller.signal, 'removeEventListener');
  const wait = abortableDelay(timers, controller.signal, 30_000);
  controller.abort();
  await expect(wait).resolves.toBeUndefined();
  expect(clear).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(30_000);
  expect(clear).toHaveBeenCalledTimes(1);
});

test('elapsed backoff resolves before close and does not clean up twice', async () => {
  jest.useFakeTimers();
  const controller = new AbortController();
  const clear = spyOn(timers, 'clearTimeout');
  const wait = abortableDelay(timers, controller.signal, 0);
  jest.advanceTimersByTime(0);
  await expect(wait).resolves.toBeUndefined();
  expect(clear).toHaveBeenCalledTimes(1);
  controller.abort();
  expect(clear).toHaveBeenCalledTimes(1);
});

test('backoff stays pending until its requested deadline', async () => {
  jest.useFakeTimers();
  const controller = new AbortController();
  let settled = false;
  const wait = abortableDelay(timers, controller.signal, 1000).then(() => { settled = true; });
  jest.advanceTimersByTime(999);
  await Promise.resolve();
  expect(settled).toBe(false);
  jest.advanceTimersByTime(1);
  await wait;
  expect(settled).toBe(true);
});
