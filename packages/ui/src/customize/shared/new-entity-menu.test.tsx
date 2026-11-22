/**
 * New → Set up manually opens the page's own dialog. The menu unmounts the row
 * it closes on, so a dialog that remembered that row as its return target
 * dropped focus to <body> on Cancel or Escape. NewEntityMenu focuses its New
 * button before it runs the row, so the dialog returns focus there.
 *
 * Rendered with `createRoot` on happy-dom (the floating-panel-motion.test.tsx
 * setup), driven with real clicks and key presses.
 *
 * Base UI moves focus on happy-dom's own window timers, which a fake global
 * clock does not drive. Each step waits for its observable result (`until`),
 * never a fixed delay: a fixed 30 ms wait lost the race on a cold first test.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act, useState } from 'react';
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

const { NewEntityMenu } = await import('./new-entity-menu');
const { Dialog, DialogClose, DialogContent, DialogTitle } = await import('../../primitives/dialog');

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => {
      root.unmount();
    });
  }
  win.document.body.innerHTML = '';
});

/**
 * A page whose manual row opens a dialog it owns. `autoFocus`: the field takes
 * focus as the dialog mounts (the New skill dialog); without it focus moves to
 * the dialog itself (the New trigger dialog).
 */
function Page({ autoFocus }: { autoFocus: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <NewEntityMenu label="New trigger" onChat={() => {}} manual={{ onSelect: () => setOpen(true) }} />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>New trigger</DialogTitle>
          <input aria-label="Instruction" autoFocus={autoFocus} />
          <DialogClose>Cancel</DialogClose>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Yields until `done()` holds, at most 2 s; the assertions after it report a miss. */
async function until(done: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
}
const active = () => win.document.activeElement as unknown as HTMLElement | null;
/** A readable name for the focused element, so a failure says where focus went. */
const describeFocus = () => {
  const el = active();
  return el ? `${el.tagName.toLowerCase()}:${el.getAttribute('aria-haspopup') ? 'menu-trigger:' : ''}${el.textContent?.trim()}` : 'null';
};

async function openDialog(autoFocus: boolean) {
  const host = win.document.createElement('div');
  win.document.body.appendChild(host);
  const root = createRoot(host as unknown as Container);
  roots.push(root);
  await act(async () => {
    root.render(<Page autoFocus={autoFocus} />);
  });
  const trigger = win.document.querySelector('button[aria-haspopup="menu"]') as unknown as HTMLButtonElement;
  expect(trigger).not.toBeNull();
  await act(async () => {
    trigger.focus();
    trigger.click();
    await until(() => win.document.querySelector('[role="menuitem"]') !== null);
  });
  const item = [...win.document.querySelectorAll('[role="menuitem"]')].find((el) =>
    el.textContent?.includes('Set up manually'),
  ) as unknown as HTMLElement | undefined;
  expect(item).toBeDefined();
  await act(async () => {
    item!.focus();
    item!.click();
    await until(() => win.document.querySelector('[role="dialog"]')?.contains(win.document.activeElement) === true);
  });
  // Not vacuous: the dialog is open and holds focus.
  const dialog = win.document.querySelector('[role="dialog"]') as unknown as HTMLElement | null;
  expect(dialog).not.toBeNull();
  expect(dialog!.contains(active())).toBe(true);
  return { trigger, dialog: dialog! };
}

describe.each([false, true])('NewEntityMenu — closing the manual dialog returns focus (autoFocus field: %p)', (autoFocus) => {
  test('Cancel returns focus to the New button', async () => {
    const { trigger } = await openDialog(autoFocus);
    const cancel = [...win.document.querySelectorAll('button')].find((el) => el.textContent === 'Cancel') as unknown as HTMLButtonElement;
    await act(async () => {
      cancel.click();
      await until(() => win.document.querySelector('[role="dialog"]') === null && active() === trigger);
    });
    expect(win.document.querySelector('[role="dialog"]')).toBeNull();
    expect(describeFocus()).toBe('button:menu-trigger:New trigger');
    expect(active()).toBe(trigger);
  });

  test('Escape returns focus to the New button', async () => {
    const { trigger } = await openDialog(autoFocus);
    await act(async () => {
      active()!.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as Event);
      await until(() => win.document.querySelector('[role="dialog"]') === null && active() === trigger);
    });
    expect(win.document.querySelector('[role="dialog"]')).toBeNull();
    expect(describeFocus()).toBe('button:menu-trigger:New trigger');
    expect(active()).toBe(trigger);
  });
});
