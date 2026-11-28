/**
 * `useSlowPreview` gives EVERY pending cycle of one frame its own grace period.
 *
 * The defect: the hook latched `slow = true` after one slow load and never
 * cleared it. Refresh (`reloadFrame`) puts the SAME frame key back to
 * `'loading'` without a remount, so every later reload of that App painted the
 * spinner at once — the flash `PREVIEW_SPINNER_DELAY_MS` exists to prevent.
 *
 * react-test-renderer drives the real hook through prop updates; fake timers
 * decide when the threshold passes.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { PREVIEW_SPINNER_DELAY_MS, useSlowPreview } from './app-preview';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function Probe({ pending }: { pending: boolean }) {
  return <i data-slow={useSlowPreview(pending)} />;
}

let renderer: ReactTestRenderer | null = null;
const render = (pending: boolean) =>
  act(() => {
    if (renderer) renderer.update(<Probe pending={pending} />);
    else renderer = create(<Probe pending={pending} />);
  });
const isSlow = () => renderer?.root.findByType('i').props['data-slow'] === true;
const advance = (ms: number) =>
  act(() => {
    jest.advanceTimersByTime(ms);
  });

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  jest.useRealTimers();
});

describe('useSlowPreview', () => {
  test('a reload after a slow load waits the full threshold again (Refresh)', () => {
    render(true);
    advance(PREVIEW_SPINNER_DELAY_MS);
    expect(isSlow()).toBe(true);

    render(false); // the frame loads (or fails)
    render(true); // reloadFrame: same key, same component, pending again

    expect(isSlow()).toBe(false);
    advance(PREVIEW_SPINNER_DELAY_MS - 1);
    expect(isSlow()).toBe(false);
    advance(1);
    expect(isSlow()).toBe(true);
  });

  test('a fast reload after a slow load never turns slow', () => {
    render(true);
    advance(PREVIEW_SPINNER_DELAY_MS);
    render(false);
    render(true);
    advance(PREVIEW_SPINNER_DELAY_MS - 1);
    render(false);
    advance(PREVIEW_SPINNER_DELAY_MS);
    expect(isSlow()).toBe(false);
  });
});
