import { afterEach, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, useState } from 'react';
import type { CapturePolicy } from '@kortix/sdk';
import { applyToPrivacy, includedView, type ExclusionChange } from './exclusions-model';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
const win = new Window();
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.location = win.location;
globals.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
globals.cancelAnimationFrame = (id: number) => clearTimeout(id);
globals.getComputedStyle = win.getComputedStyle.bind(win);
for (const key of Object.getOwnPropertyNames(win)) {
  if (/^[A-Z]/.test(key) && (!(key in globals) || key.endsWith('Event'))) {
    globals[key] = Reflect.get(win, key);
  }
}
// After the window exists: react-dom decides at load whether the DOM fires
// `input` events, and without them a typed search never reaches React.
const { createRoot } = await import('react-dom/client');

const { IncludedEditor } = await import('./exclusions-editor');
const container = document.createElement('div');
document.body.append(container);
let root = createRoot(container);
const changed = mock((_change: ExclusionChange) => {});
const privacy: CapturePolicy['privacy'] = {
  redact_pii: false, excluded_bundle_ids: [], excluded_domains: [], exclusion_groups: [],
  exclude_private_browsing: false, included_bundle_ids: ['com.example.already'], included_domains: ['kept.example'],
};
function Editor() {
  const [value, setValue] = useState(privacy);
  return <IncludedEditor view={includedView(value)}
    onChange={(change) => { changed(change); setValue((current) => applyToPrivacy(current, change)); }} />;
}
afterEach(async () => {
  await act(async () => root.unmount());
  container.replaceChildren();
  root = createRoot(container);
  changed.mockClear();
});
const input = () => {
  const node = document.body.querySelector('input');
  if (!(node instanceof HTMLInputElement)) throw new Error('missing the search input');
  return node;
};
const type = async (text: string) => {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (!set) throw new Error('the value property has no setter');
    set.call(input(), text);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const pressEnter = async () => {
  await act(() => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
};
const pickTab = async (label: string) => {
  const tab: Element | undefined = [...document.body.querySelectorAll('[role="tab"]')].find((t) => t.textContent === label);
  if (!(tab instanceof HTMLElement)) throw new Error(`missing the ${label} tab`);
  await act(() => tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })));
};

test('a typed app joins the included list with one include-app change', async () => {
  await act(() => root.render(<Editor />));
  await type('com.example.new');
  await pressEnter();
  expect(changed.mock.calls).toEqual([[{ kind: 'include-app', id: 'com.example.new', on: true }]]);
  // The row appears named by its id, the input clears for the next entry.
  const rows = [...document.body.querySelectorAll('li p')].map((p) => p.textContent);
  expect(rows).toContain('com.example.new');
  expect(input().value).toBe('');
});

test('a typed website on the websites tab emits one include-domain change', async () => {
  await act(() => root.render(<Editor />));
  await pickTab('Websites');
  await type('notion.example');
  await pressEnter();
  expect(changed.mock.calls).toEqual([[{ kind: 'include-domain', id: 'notion.example', on: true }]]);
  const rows = [...document.body.querySelectorAll('li p')].map((p) => p.textContent);
  expect(rows).toContain('notion.example');
});

test('a website already included is not added again', async () => {
  await act(() => root.render(<Editor />));
  await pickTab('Websites');
  await type('kept.example');
  await pressEnter();
  expect(changed.mock.calls).toEqual([]);
  // The add button stays hidden: nothing to add.
  expect([...document.body.querySelectorAll('button')].some((b) => b.textContent?.includes('kept.example'))).toBe(false);
});

test('the add button emits the same include change as Enter', async () => {
  await act(() => root.render(<Editor />));
  await type('added.example');
  const add = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes('added.example'));
  if (!(add instanceof HTMLElement)) throw new Error('missing the add button');
  await act(() => add.click());
  expect(changed.mock.calls).toEqual([[{ kind: 'include-app', id: 'added.example', on: true }]]);
});
