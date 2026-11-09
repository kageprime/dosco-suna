import { afterEach, expect, jest, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { type ThemeChoice, useTheme } from '../src/theme';

const window = new Window();
Object.defineProperties(globalThis, {
  window: { value: window, configurable: true },
  document: { value: window.document, configurable: true },
  localStorage: { value: window.localStorage, configurable: true },
  navigator: { value: window.navigator, configurable: true },
  getComputedStyle: { value: window.getComputedStyle.bind(window), configurable: true },
  requestAnimationFrame: { value: window.requestAnimationFrame.bind(window), configurable: true },
  cancelAnimationFrame: { value: window.cancelAnimationFrame.bind(window), configurable: true },
  IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true },
});

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  window.localStorage.clear();
});

const KEY = 'wl-shared_theme_test';

/** Mounts a probe that reads the hook and a button that flips the choice. */
async function mountProbe(
  defaultChoice: ThemeChoice,
): Promise<{ label: HTMLElement; flip: HTMLButtonElement }> {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  function Probe() {
    const { choice, setChoice } = useTheme({ key: KEY, defaultChoice });
    return (
      <div>
        <span data-choice>{choice}</span>
        <button type="button" onClick={() => setChoice('dark')}>flip</button>
      </div>
    );
  }
  await act(async () => root?.render(<Probe />));
  const label = host.querySelector<HTMLElement>('[data-choice]');
  const flip = host.querySelector<HTMLButtonElement>('button');
  if (!label || !flip) throw new Error('probe did not render');
  return { label, flip };
}

test('the stored choice wins over the default once the effect runs', async () => {
  window.localStorage.setItem(KEY, 'dark');
  const { label } = await mountProbe('light');
  await act(async () => {});
  expect(label.textContent).toBe('dark');
});

test('no stored choice falls back to the default, including the system setting', async () => {
  const { label } = await mountProbe('system');
  await act(async () => {});
  expect(label.textContent).toBe('system');
});

test('setChoice persists to storage and toggles the dark class', async () => {
  const { label, flip } = await mountProbe('system');
  await act(async () => flip.click());
  expect(window.localStorage.getItem(KEY)).toBe('dark');
  expect(label.textContent).toBe('dark');
  expect(document.documentElement.classList.contains('dark')).toBe(true);
});
