import { afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { SurfaceTabs } from '../surfaces/surface-tabs';
import { TopicTabs } from './topic-tabs';

const win = new Window();
Object.defineProperties(globalThis, {
  window: { value: win, configurable: true },
  document: { value: win.document, configurable: true },
  navigator: { value: win.navigator, configurable: true },
  KeyboardEvent: { value: win.KeyboardEvent, configurable: true },
  IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true },
});
let root: Root;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ''; });
const tabs = ['one', 'two', 'three'].map((id) => ({ id, title: id, description: 'Run `kortix` now', body: ['Use `start` safely', 'Second sentence'] }));

for (const surface of [true, false]) {
  test(`${surface ? 'surface' : 'topic'} tabs retain selection, wrapping, focus and panel boundaries`, () => {
    const panels = tabs.map((tab) => <strong key={tab.id}>{tab.id} server panel</strong>);
    const element = surface ? <SurfaceTabs title="Heading" titleMuted="Muted" tabs={tabs} panels={panels} /> : <TopicTabs topics={{ title: 'Heading', titleMuted: 'Muted', tabs }} panels={{ one: () => panels[0], two: () => panels[1], three: () => panels[2] }} label="Heading" />;
    const html = renderToStaticMarkup(element);
    expect(html).toContain('one server panel');
    const host = document.createElement('div');
    document.body.appendChild(host);
    act(() => { root = createRoot(host); root.render(element); });
    const buttons = [...document.querySelectorAll('button')];
    const list = document.querySelector('[role="tablist"]');
    if (!list) throw new Error('missing tablist');
    const check = (index: number) => {
      buttons.forEach((button, i) => {
        expect(button.getAttribute('aria-selected')).toBe(String(i === index));
        expect(button.tabIndex).toBe(i === index ? 0 : -1);
      });
      const panel = document.querySelector('[role="tabpanel"]');
      expect(panel?.id).toBe(`${surface ? 'surface' : 'topic'}-panel`);
      expect(panel?.getAttribute('aria-labelledby')).toBe(`${surface ? 'surface' : 'topic'}-tab-${tabs[index].id}`);
      expect(panel?.textContent).toContain(`${tabs[index].id} server panel`);
    };
    check(0);
    if (surface) expect(document.querySelectorAll('code')).toHaveLength(4);
    act(() => buttons[2].click());
    check(2);
    for (const [key, index] of [['ArrowRight', 0], ['ArrowLeft', 2], ['ArrowDown', 0], ['ArrowUp', 2]] as const) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      act(() => list.dispatchEvent(event));
      check(index);
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement?.id).toBe(buttons[index].id);
    }
    act(() => list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    check(2);
  });
}
