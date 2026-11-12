/**
 * `useAnswerStreaming`: the busy row hides while the answer's words arrive and
 * returns when the open block closes or the text stops growing. Runs the hook
 * against `happy-dom` with a fake clock (the `streaming-cadence-hook` pattern).
 */
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
const win = new Window();
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;

const { ANSWER_QUIET_AFTER_MS, useAnswerStreaming } = await import('./answer-streaming');

const STALL_MS = ANSWER_QUIET_AFTER_MS;
let root: Root | null = null;
let latest = false;
const report = (value: boolean) => {
  latest = value;
};

function Probe({ text, onValue }: { text: string | undefined; onValue: (value: boolean) => void }) {
  onValue(useAnswerStreaming(text, STALL_MS));
  return null;
}

function render(text: string | undefined) {
  act(() => {
    if (!root) root = createRoot(document.createElement('div') as unknown as Element);
    root.render(<Probe text={text} onValue={report} />);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  jest.useRealTimers();
});

describe('useAnswerStreaming', () => {
  test('no open text block: the busy row shows', () => {
    render(undefined);
    expect(latest).toBe(false);
  });

  test('an open block with only whitespace: the busy row shows', () => {
    render('  \n');
    expect(latest).toBe(false);
  });

  test('words arriving: the busy row hides', () => {
    render('Platinum is our');
    expect(latest).toBe(true);
    render('Platinum is our primary provider');
    expect(latest).toBe(true);
  });

  test('the block closes: the busy row returns at once', () => {
    render('Platinum is our primary provider.');
    render(undefined);
    expect(latest).toBe(false);
  });

  test('text silent for the stall window: the busy row returns', () => {
    render('Platinum is our');
    act(() => jest.advanceTimersByTime(STALL_MS - 1));
    expect(latest).toBe(true);
    act(() => jest.advanceTimersByTime(1));
    expect(latest).toBe(false);
  });

  test('growth after a stall hides the row again and restarts the window', () => {
    render('Platinum is our');
    act(() => jest.advanceTimersByTime(STALL_MS));
    expect(latest).toBe(false);
    render('Platinum is our primary');
    expect(latest).toBe(true);
    act(() => jest.advanceTimersByTime(STALL_MS - 1));
    expect(latest).toBe(true);
  });

  test('a later block that passes the stalled text does not flash the row', () => {
    render('Platinum is our');
    act(() => jest.advanceTimersByTime(STALL_MS));
    expect(latest).toBe(false);
    render(undefined);
    // A new block grows through the stalled block's length with other words.
    render('Second block ab');
    expect('Second block ab'.length).toBe('Platinum is our'.length);
    expect(latest).toBe(true);
  });

  test('the quiet window is 3 s', () => {
    expect(ANSWER_QUIET_AFTER_MS).toBe(3_000);
  });

  test('steady growth never trips the stall', () => {
    let text = 'a';
    render(text);
    for (let i = 0; i < 10; i++) {
      act(() => jest.advanceTimersByTime(STALL_MS / 2));
      text += ' word';
      render(text);
    }
    expect(latest).toBe(true);
  });
});
