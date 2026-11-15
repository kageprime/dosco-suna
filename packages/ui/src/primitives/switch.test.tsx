/**
 * A disabled Switch reads as unavailable and does not move under the pointer.
 * A trigger page showed finished one-shots with a disabled switch that looked
 * exactly like an enabled off switch, and whose thumb still grew on hover.
 *
 * Rendered with `createRoot` on happy-dom (the floating-panel-motion.test.tsx
 * setup); motion skips its animations, so the thumb's width is the target
 * size on the frame after the pointer event.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Container, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const win = new Window({ width: 1440, height: 900 });
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.getComputedStyle = win.getComputedStyle.bind(win);
globals.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
globals.cancelAnimationFrame = (id: number) => clearTimeout(id);
for (const key of Object.getOwnPropertyNames(win)) {
  if (/^[A-Z]/.test(key) && !(key in globals)) globals[key] = Reflect.get(win, key);
}
for (const key of ['Event', 'CustomEvent', 'FocusEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent']) {
  globals[key] = Reflect.get(win, key);
}

const { LazyMotion, MotionGlobalConfig, domMax } = await import('motion/react');
MotionGlobalConfig.skipAnimations = true;
const { Switch } = await import('./switch');

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => {
      root.unmount();
    });
  }
  win.document.body.innerHTML = '';
});

async function mount(element: React.ReactElement) {
  const host = win.document.createElement('div');
  win.document.body.appendChild(host);
  const root = createRoot(host as unknown as Container);
  roots.push(root);
  await act(async () => {
    root.render(<LazyMotion features={domMax}>{element}</LazyMotion>);
  });
  const control = win.document.querySelector('[role="switch"]') as unknown as HTMLButtonElement;
  expect(control).not.toBeNull();
  const thumb = control.querySelector('span') as unknown as HTMLElement;
  expect(thumb).not.toBeNull();
  return { control, thumb };
}

/**
 * A mouse press. happy-dom's `pointerover` does not reach React's
 * onPointerEnter, so the press path stands in for hover: both go through the
 * same `disabled` gate (`isPressed` / `isHovered` in switch.tsx).
 */
async function press(control: HTMLButtonElement) {
  await act(async () => {
    control.dispatchEvent(
      new win.PointerEvent('pointerdown', { pointerType: 'mouse', bubbles: true, button: 0, pointerId: 1 }) as unknown as Event,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe('Switch — disabled', () => {
  test('a disabled switch carries the disabled attribute and its half-opacity class', async () => {
    const { control } = await mount(<Switch aria-label="Resume" disabled />);
    expect(control.hasAttribute('disabled')).toBe(true);
    expect(control.getAttribute('class')?.split(/\s+/)).toContain('disabled:opacity-50');
    // The off-track hover tint applies to an enabled switch only.
    expect(control.getAttribute('class')).toContain('data-[state=unchecked]:enabled:hover:bg-foreground/15');
  });

  test('a press reshapes the thumb of an enabled switch', async () => {
    const { control, thumb } = await mount(<Switch aria-label="Resume" />);
    const rest = thumb.style.cssText;
    await press(control);
    // Not vacuous: the enabled thumb does move, so the disabled case below is a real check.
    expect(thumb.style.cssText).not.toBe(rest);
  });

  test('a press does not reshape the thumb of a disabled switch', async () => {
    const { control, thumb } = await mount(<Switch aria-label="Resume" disabled />);
    const rest = thumb.style.cssText;
    await press(control);
    expect(thumb.style.cssText).toBe(rest);
  });
});
