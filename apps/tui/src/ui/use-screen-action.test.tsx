import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act } from 'react';

import type { TestRendererSetup } from '@opentui/core/testing';
import { testRender } from '@opentui/react/test-utils';

import { useScreenAction, type ScreenToast } from './use-screen-action.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let active: TestRendererSetup | null = null;
afterEach(() => {
  active?.renderer.destroy();
  active = null;
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The hook's handles, captured by the probe at render time. */
const probe = {
  run: (label: string, work: () => Promise<unknown>, done?: string) => {},
  refresh: (label: string, work: () => Promise<unknown>) => {},
};

function HookProbe({ onToast }: { onToast: ScreenToast }) {
  const { busy, run, refresh } = useScreenAction(onToast);
  probe.run = run;
  probe.refresh = refresh;
  return <text>{busy ?? 'idle'}</text>;
}

async function renderProbe(onToast: ScreenToast) {
  active = await testRender(<HookProbe onToast={onToast} />, { width: 40, height: 6 });
  await active.renderOnce();
  return active;
}

const frame = async () => {
  await active!.renderOnce();
  return active!.captureCharFrame();
};

describe('useScreenAction', () => {
  test('sets the busy line, toasts the string the work returns, then clears it', async () => {
    const onToast = mock(() => {});
    await renderProbe(onToast);
    let resolveWork!: (value: unknown) => void;
    await act(async () => {
      probe.run('saving…', () => new Promise((resolve) => (resolveWork = resolve)));
    });
    expect(await frame()).toContain('saving…');

    await act(async () => {
      resolveWork('Saved.');
      await settle();
    });
    expect(await frame()).toContain('idle');
    expect(onToast).toHaveBeenCalledWith('Saved.');
    expect(onToast).toHaveBeenCalledTimes(1);
  });

  test('toasts the done phrase, not the work result, when one is given', async () => {
    const onToast = mock(() => {});
    await renderProbe(onToast);
    await act(async () => {
      probe.run('saving…', async () => 'ignored', 'Renamed.');
      await settle();
    });
    expect(onToast).toHaveBeenCalledWith('Renamed.');
    expect(onToast).toHaveBeenCalledTimes(1);
  });

  test('on a rejection the error message reaches the toast as an error, and the line clears', async () => {
    const onToast = mock(() => {});
    await renderProbe(onToast);
    let rejectWork!: (error: unknown) => void;
    await act(async () => {
      probe.run('saving…', () => new Promise((_, reject) => (rejectWork = reject)));
    });
    expect(await frame()).toContain('saving…');

    await act(async () => {
      rejectWork(new Error('quota exceeded'));
      await settle();
    });
    expect(await frame()).toContain('idle');
    expect(onToast).toHaveBeenCalledWith('quota exceeded', 'error');
    expect(onToast).toHaveBeenCalledTimes(1);
  });

  test('a work that throws a non-Error toasts the fallback text', async () => {
    const onToast = mock(() => {});
    await renderProbe(onToast);
    await act(async () => {
      probe.run('saving…', async () => Promise.reject(42));
      await settle();
    });
    expect(onToast).toHaveBeenCalledWith('Unknown error', 'error');
  });

  test('a refetch toasts nothing: its result is not a string', async () => {
    const onToast = mock(() => {});
    await renderProbe(onToast);
    await act(async () => {
      probe.refresh('refreshing…', async () => ({ data: 'row' }));
      await settle();
    });
    expect(onToast).not.toHaveBeenCalled();
    expect(await frame()).toContain('idle');
  });

  test('runs are not serialised: the last label wins and the first settle clears the line', async () => {
    const onToast = mock(() => {});
    await renderProbe(onToast);
    let resolveA!: (value: unknown) => void;
    let resolveB!: (value: unknown) => void;
    const workA = () => new Promise((resolve) => (resolveA = resolve));
    const workB = () => new Promise((resolve) => (resolveB = resolve));

    await act(async () => {
      probe.run('first…', workA);
      probe.run('second…', workB);
    });
    expect(await frame()).toContain('second…');

    await act(async () => {
      resolveA('A done.');
      await settle();
    });
    // One busy line, not a count: the first run's settle clears it while the
    // second is still in flight — the same line the hand-rolled blocks drew.
    expect(await frame()).toContain('idle');
    expect(onToast).toHaveBeenCalledWith('A done.');

    await act(async () => {
      resolveB('B done.');
      await settle();
    });
    expect(onToast).toHaveBeenCalledWith('B done.');
  });
});
