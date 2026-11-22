/**
 * A streaming message paints each render's text in that render's commit
 * (KRTX-4939). Streamdown 1.6.11 committed its streaming blocks inside a
 * transition, which React abandons whenever another update lands first, so an
 * answer that grows every ~32 ms showed nothing until the stream stopped, then
 * all of it at once. `patches/streamdown@1.6.11.patch` drops the transition.
 *
 * Each render is a `flushSync` with no `act`: `act` would flush a pending
 * transition and hide the bug. Runs against `happy-dom`.
 */
import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import { IntlTestProvider } from '../test-utils/intl';
import { UnifiedMarkdown } from './unified-markdown';

const win = new Window();
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;

function streamingRoot() {
  const host = document.createElement('div');
  const root = createRoot(host);
  const paint = (content: string, isStreaming = true) =>
    flushSync(() =>
      root.render(
        <IntlTestProvider locale="en" onError={() => {}}>
          <UnifiedMarkdown trust="agent" content={content} isStreaming={isStreaming} />
        </IntlTestProvider>,
      ),
    );
  const text = () => (host.querySelector('.kortix-markdown')?.textContent ?? '').replace(/\s+/g, ' ').trim();
  // A paragraph renders as a `div.leading-relaxed` (`MARKDOWN_COMPONENTS.p`).
  const paragraphs = () => [...host.querySelectorAll('.leading-relaxed')].map((p) => p.textContent);
  return { root, paint, text, paragraphs };
}

describe('UnifiedMarkdown while streaming', () => {
  test('the first streamed text shows in its own commit', () => {
    const m = streamingRoot();
    m.paint('Counting: 1, 2, 3');
    expect(m.text()).toBe('Counting: 1, 2, 3');
    flushSync(() => m.root.unmount());
  });

  test('text that grows on every render shows each step, not only after the stream ends', () => {
    const m = streamingRoot();
    let content = 'Numbers:';
    for (let n = 1; n <= 40; n++) {
      content += ` ${n},`;
      m.paint(content);
      expect(m.text()).toBe(content);
    }
    flushSync(() => m.root.unmount());
  });

  test('a new paragraph shows as soon as it streams, and the settled render keeps every block', () => {
    const m = streamingRoot();
    m.paint('First paragraph.');
    m.paint('First paragraph.\n\nSecond');
    expect(m.paragraphs()).toEqual(['First paragraph.', 'Second']);
    m.paint('First paragraph.\n\nSecond paragraph.', false);
    expect(m.paragraphs()).toEqual(['First paragraph.', 'Second paragraph.']);
    flushSync(() => m.root.unmount());
  });
});
