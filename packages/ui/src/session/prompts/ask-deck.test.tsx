import type { ComponentProps } from 'react';
import type { SessionAsk, SessionAskAnswer } from '@kortix/sdk';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
// The deck card listens for its keys on `window`.
const win = new Window();
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;

/** Every answer the deck sends, after its Undo window or on leaving the page. */
const sent: { askId: string; answer: SessionAskAnswer }[] = [];
const undoMessages: string[] = [];
const undoAction: { current?: () => void } = {};
let asks: SessionAsk[] = [];

const realSdk = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...realSdk,
  useSessionAsks: () => ({ data: { asks, total: asks.length }, isLoading: false, isError: false, refetch: async () => undefined }),
  useAnswerSessionAsk: () => ({
    mutateAsync: async (variables: { askId: string; answer: SessionAskAnswer }) => {
      sent.push(variables);
      return { ok: true, delivery: 'message' };
    },
  }),
}));
const realToast = await import('../../primitives/toast');
mock.module('../../primitives/toast', () => ({
  ...realToast,
  undoToast: (message: string, options: { onUndo: () => void }) => {
    undoMessages.push(message);
    undoAction.current = options.onUndo;
  },
}));

const { AskDeck } = await import('./ask-deck');

const accessAsk = {
  id: 'access:a1',
  kind: 'access',
  session_id: 'session-my-kortix',
  surface_session_id: 'session-my-kortix',
  request_id: 'a1',
  title: 'A colleague for "Invoice check" needs connector gmail and secret STRIPE_KEY',
  asked_at: '2026-11-09T10:00:00.000Z',
  expires_at: '2026-11-10T10:00:00.000Z',
  access: { colleague: 'Invoice check', connectors: ['gmail'], secrets: ['STRIPE_KEY'] },
} as SessionAsk;

function text(node: ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(text).join('');
}

async function mountDeck(props: Omit<ComponentProps<typeof AskDeck>, 'projectId'> = {}): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={new QueryClient()}>
        <AskDeck projectId="project-1" {...props} />
      </QueryClientProvider>,
    );
  });
  return renderer;
}

afterEach(() => {
  sent.length = 0;
  undoMessages.length = 0;
  undoAction.current = undefined;
  asks = [];
});

describe('AskDeck access asks', () => {
  for (const [label, decision, toast] of [['Allow', 'allow', 'Allowed'], ['Deny', 'deny', 'Denied']] as const) {
    test(`${label} draws the access card and sends { decision: '${decision}' }, never a permission reply`, async () => {
      asks = [accessAsk];
      const renderer = await mountDeck();
      const card = text(renderer.root);
      expect(card).toContain('My Kortix asks to give a colleague access');
      expect(card).toContain('Invoice check');
      expect(card).toContain('gmail');
      expect(card).toContain('STRIPE_KEY');
      // Not the permission card: no "Allow once" / "Allow for session".
      expect(card).not.toContain('Allow once');

      const choice = renderer.root.findAllByType('button').find((node) => text(node) === label);
      if (!choice) throw new Error(`Missing ${label}`);
      await act(async () => {
        choice.props.onClick();
      });
      expect(undoMessages).toEqual([toast]);
      // Leaving the deck sends what waits for its Undo window.
      await act(async () => renderer.unmount());
      expect(sent).toEqual([{ askId: 'access:a1', answer: { decision } }]);
    });
  }

  test('a kind the deck does not know is left out, not drawn as an empty card', async () => {
    asks = [{ ...accessAsk, id: 'future:f1', kind: 'future' } as unknown as SessionAsk];
    const renderer = await mountDeck();
    expect(text(renderer.root)).toContain('Nothing waits on you');
    await act(async () => renderer.unmount());
  });
});

test('selecting an inbox ask opens its card instead of the oldest card', async () => {
  asks = [accessAsk, {
    ...accessAsk,
    id: 'access:a2',
    asked_at: '2026-11-09T11:00:00.000Z',
    access: { colleague: 'Report check', connectors: [], secrets: [] },
  }];
  const renderer = await mountDeck({ selectedAskId: 'access:a2' });
  try {
    expect(text(renderer.root)).toContain('Report check');
    expect(text(renderer.root)).not.toContain('Invoice check');
  } finally {
    await act(async () => renderer.unmount());
  }
});

test('a staged answer hides its inbox row until Undo restores it', async () => {
  asks = [accessAsk];
  let hidden: ReadonlySet<string> = new Set();
  const renderer = await mountDeck({ onHiddenAskIdsChange: (ids) => { hidden = ids; } });
  try {
    const allow = renderer.root.findAllByType('button').find((node) => text(node) === 'Allow');
    if (!allow) throw new Error('Missing Allow');
    await act(async () => allow.props.onClick());
    expect(hidden.has(accessAsk.id)).toBe(true);
    expect(text(renderer.root)).not.toContain('Invoice check');
    await act(async () => undoAction.current?.());
    expect(hidden.has(accessAsk.id)).toBe(false);
    expect(text(renderer.root)).toContain('Invoice check');
    expect(sent).toEqual([]);
  } finally {
    await act(async () => renderer.unmount());
  }
});

test('the inbox highlight follows the default card and Skip', async () => {
  asks = [accessAsk, {
    ...accessAsk, id: 'access:a2', asked_at: '2026-11-09T11:00:00.000Z',
    access: { colleague: 'Report check', connectors: [], secrets: [] },
  }];
  const current: { id?: string | null } = {};
  const renderer = await mountDeck({ onCurrentAskChange: (id) => { current.id = id; } });
  try {
    expect(current.id).toBe(accessAsk.id);
    const skip = renderer.root.findAllByType('button').find((node) => text(node).startsWith('Skip'));
    if (!skip) throw new Error('Missing Skip');
    await act(async () => skip.props.onClick());
    expect(current.id).toBe('access:a2');
    expect(text(renderer.root)).toContain('Report check');
  } finally {
    await act(async () => renderer.unmount());
  }
});
