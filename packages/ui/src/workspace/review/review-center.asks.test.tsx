import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlTestProvider } from '../../test-utils/intl';
import { TestUiHost } from '../../test-utils/ui-host';
import type { SessionAsk } from '@kortix/sdk';

const win = new Window();
Object.assign(globalThis, {
  window: win,
  document: win.document,
  navigator: win.navigator,
  MutationObserver: win.MutationObserver,
  KeyboardEvent: win.KeyboardEvent,
  getComputedStyle: win.getComputedStyle.bind(win),
  requestAnimationFrame: win.requestAnimationFrame.bind(win),
  cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  HTMLElement: win.HTMLElement,
  Element: win.Element,
  Node: win.Node,
  ShadowRoot: win.ShadowRoot,
});
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
});
win.HTMLElement.prototype.getBoundingClientRect = () => new win.DOMRect(0, 0, 1200, 900);
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
  unobserve() {}
} as typeof ResizeObserver;
const { ReviewCenter } = await import('./review-center');
const ask: SessionAsk = {
  id: 'question:synthetic',
  kind: 'question',
  session_id: 'synthetic-session',
  surface_session_id: 'synthetic-session',
  session_title: 'Test session',
  request_id: 'synthetic-request',
  title: 'Which report should I prepare?',
  asked_at: '2026-11-12T00:00:00Z',
  expires_at: null,
};

test('an open question appears in Needs you when there are no review items', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let selected = '';
  try {
    await act(async () =>
      root.render(
        <IntlTestProvider>
          <TestUiHost>
            <ReviewCenter
              initialItems={[]}
              sessionAsks={[ask]}
              onSelectAsk={(id) => {
                selected = id;
              }}
              needsYouDeck={() => <div>1 waits on you</div>}
            />
          </TestUiHost>
        </IntlTestProvider>,
      ),
    );
    const rows = host.querySelectorAll('[data-testid="review-ask-row"]');
    expect(rows.length).toBe(1);
    expect(rows[0]?.textContent).toContain(ask.title);
    expect(host.textContent?.includes('Nothing here')).toBe(false);
    await act(async () => (rows[0] as HTMLButtonElement).click());
    expect(selected).toBe(ask.id);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

test('open asks do not hide pagination for review items', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let loaded = false;
  try {
    await act(async () =>
      root.render(
        <IntlTestProvider>
          <TestUiHost>
            <ReviewCenter
              initialItems={[]}
              sessionAsks={[ask]}
              loadMore={{
                onLoadMore: () => {
                  loaded = true;
                },
                isLoading: false,
                isError: false,
              }}
            />
          </TestUiHost>
        </IntlTestProvider>,
      ),
    );
    const loadMore = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Load more'),
    );
    expect(!!loadMore).toBe(true);
    await act(async () => loadMore?.click());
    expect(loaded).toBe(true);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

test('the session filter counts questions without review items', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <IntlTestProvider>
          <TestUiHost>
            <ReviewCenter initialItems={[]} sessionAsks={[ask]} />
          </TestUiHost>
        </IntlTestProvider>,
      ),
    );
    await act(async () =>
      (host.querySelector('button[aria-label="Filter"]') as HTMLButtonElement)?.click(),
    );
    const session = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
      (item) => item.textContent?.trim() === 'Session',
    );
    expect(!!session).toBe(true);
    await act(async () => {
      session?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
    });
    const options = Array.from(document.querySelectorAll('[role="menuitemradio"]'));
    expect(
      options.find((option) => option.textContent?.includes('All sessions'))?.textContent,
    ).toContain('1');
    expect(
      options.find((option) => option.textContent?.includes('Test session'))?.textContent,
    ).toContain('1');
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
