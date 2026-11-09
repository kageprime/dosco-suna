/**
 * KRTX-4450 regression — the composer's question lock.
 *
 * A question docks on the composer from two sources: a live `question` tool
 * call this session's runtime holds the turn on, and a PARKED ask (a hidden
 * worker's question surfaced here) that the asks API reports while this
 * session is idle — a parked ask no longer holds the turn. The lock that
 * reroutes a typed answer into the question used to gate on the session being
 * busy, so for a parked ask on an idle session the lock dropped: the typed
 * answer left as a NEW prompt, the question card stayed open, and the session
 * started an unrelated turn on top of the ask.
 *
 * The rendered-markup assertions here mount the real SessionChat on
 * happy-dom (the floating-panel-motion pattern) with the composer mocked to
 * capture its props — the same host-wire seam session-chat.test.tsx pins.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const win = new Window({ width: 1440, height: 900 });
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.getComputedStyle = win.getComputedStyle.bind(win);
globals.requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(0), 0);
globals.cancelAnimationFrame = (id: number) => clearTimeout(id);
for (const key of Object.getOwnPropertyNames(win)) {
  if (/^[A-Z]/.test(key) && !(key in globals)) globals[key] = Reflect.get(win, key);
}
globals.customElements = win.customElements;
globals.HTMLElement = win.HTMLElement;
// useAutoScroll's layout observers (no layout runs in this test, but the hook
// attaches them on mount).
if (!globals.ResizeObserver) {
  globals.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

import type { SessionAsk } from '@kortix/sdk';
/** Parked asks the asks API reports for this session; each test seeds its own. */
let parkedAsks: SessionAsk[] = [];

const realSdk = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...realSdk,
  useSessionTurnOutcome: () => ({}),
  useSessionMessages: () => [],
  useSessionSync: () => ({
    messages: [],
    freshness: 'fresh',
    isLoading: false,
    hasOlder: false,
    isLoadingOlder: false,
    loadOlder: async () => {},
  }),
  useRuntimeReady: () => true,
  useRuntimeSession: () => ({ data: { id: 'session-fixture' }, isFetched: true }),
  useRuntimeAgents: () => ({ data: [{ name: 'build' }] }),
  useRuntimeCommands: () => ({ data: [] }),
  useRuntimeProviders: () => ({ data: [], isLoading: false }),
  useRuntimeSessions: () => ({ data: [] }),
  useRuntimeConfig: () => ({ data: {} }),
  useProjectConfig: () => ({}),
  useSessionPrompts: () => ({ prompts: [] }),
  useSessionMessageAuthors: () => ({ data: undefined }),
  useFeatureFlag: () => ({ enabled: true, isLoading: false }),
  useSessionWorking: () => ({ state: 'idle', turnId: null, serverOpenTurnToken: null }),
  useSessionNeedsYou: () => ({ needsYou: parkedAsks.length > 0, asks: parkedAsks }),
}));
mock.module('../header/session-site-header', () => ({
  SessionSiteHeader: () => null,
}));
mock.module('../prompts/session-approval-prompt', () => ({
  SessionApprovalPrompt: () => null,
}));
mock.module('../prompts/session-permission-prompt', () => ({
  SessionPermissionPrompt: () => null,
}));
/** The props the last render handed the composer — the host-wire observables. */
let composerProps: Record<string, unknown> | undefined;
mock.module('../composer/composer', () => ({
  COMPOSER_SHELL_CLASS: '',
  Composer: (props: Record<string, unknown>) => {
    composerProps = props;
    return (
      <div>
        {props.aboveSlot as React.ReactNode}
        {props.inputSlot as React.ReactNode}
      </div>
    );
  },
}));

const { SessionChat } = await import('./session-chat');
const { IntlTestProvider } = await import('../../test-utils/intl');
const { defaultUiMessages: enMessages } = await import('../../i18n');
const { TestUiHost } = await import('../../test-utils/ui-host');
const { SidebarProvider } = await import('../../primitives/sidebar');

const ROUTE = { id: 'project-fixture', sessionId: 'project-session-fixture' };

/** A worker's parked question ask, surfaced on this (idle) session. */
const parkedQuestionAsk = (requestId: string): SessionAsk =>
  ({
    id: `ask-${requestId}`,
    kind: 'question',
    session_id: 'worker-session-fixture',
    surface_session_id: 'project-session-fixture',
    session_title: 'synthetic workflow',
    request_id: requestId,
    title: 'synthetic question',
    asked_at: new Date(2000).toISOString(),
    expires_at: null,
    question: {
      questions: [
        {
          question: 'Which motion should the plan follow?',
          header: 'Motion',
          options: [{ label: 'Sales-led', description: 'Demos and pilots' }],
        },
      ],
    },
  }) as never;

async function renderChat(): Promise<Root> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const root = createRoot(document.createElement('div'));
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <IntlTestProvider locale="en" messages={enMessages} onError={() => {}}>
          <TestUiHost params={ROUTE} viewerId="viewer-1">
            <SidebarProvider>
              <SessionChat
                sessionId="session-fixture"
                projectId="project-fixture"
                projectSessionId="project-session-fixture"
              />
            </SidebarProvider>
          </TestUiHost>
        </IntlTestProvider>
      </QueryClientProvider>,
    );
  });
  // The question dock sets its state in an effect; one more flush lands the
  // composer re-render that carries the lock.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return root;
}

afterEach(() => {
  parkedAsks = [];
  composerProps = undefined;
});

describe('SessionChat composer question lock (KRTX-4450)', () => {
  test('a parked ask locks the composer into answer mode on an idle session', async () => {
    parkedAsks = [parkedQuestionAsk('req-parked')];
    const root = await renderChat();
    try {
      expect(composerProps).toBeDefined();
      // Idle session (working.state is 'idle' above): the lock must still hold,
      // so a typed answer reroutes into the question instead of leaving as a prompt.
      expect(composerProps?.lockForQuestion).toBe(true);
      // The docked card is the parked ask's question, so the send button steps it.
      expect(composerProps?.questionActive).toBe(true);
    } finally {
      await act(async () => root.unmount());
    }
  });

  test('a live runtime question locks the composer', async () => {
    const store = realSdk.useRuntimePendingStore;
    act(() => {
      store.getState().addQuestion({
        id: 'req-live',
        sessionID: 'session-fixture',
        questions: [
          { question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes' }] },
        ],
      } as never);
    });
    const root = await renderChat();
    try {
      expect(composerProps?.lockForQuestion).toBe(true);
    } finally {
      await act(async () => root.unmount());
      act(() => store.getState().clear());
    }
  });

  test('with no question the composer stays unlocked so a message reaches the agent', async () => {
    const root = await renderChat();
    try {
      expect(composerProps?.lockForQuestion).toBe(false);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
