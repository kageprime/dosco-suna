import { afterEach, expect, jest, test } from 'bun:test';
import { Window } from 'happy-dom';
import type React from 'react';
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { BootScreen } from '../src/boot-screen';

const window = new Window();
Object.defineProperties(globalThis, {
  window: { value: window, configurable: true },
  document: { value: window.document, configurable: true },
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
});

async function mount(element: React.ReactElement): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(element));
  return host;
}

test('the failed boot screen renders the reason and a retry button that calls back', async () => {
  const onRetry = jest.fn();
  const host = await mount(
    <BootScreen stage="starting" failed reason="The sandbox never came up." onRetry={onRetry} />,
  );
  expect(host.textContent).toContain('The sandbox never came up.');
  const button = host.querySelector<HTMLButtonElement>('button');
  expect(button?.textContent).toBe('Try again');
  await act(async () => button?.click());
  expect(onRetry).toHaveBeenCalledTimes(1);
});

test('a boot in progress shows the stage label and no retry control', async () => {
  const onRetry = jest.fn();
  const host = await mount(<BootScreen stage="provisioning" onRetry={onRetry} />);
  expect(host.textContent).toContain('Provisioning sandbox…');
  expect(host.querySelector('button')).toBeNull();
  expect(onRetry).not.toHaveBeenCalled();
});
