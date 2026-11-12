import type { SessionAsk, SessionAskAnswer } from '@kortix/sdk';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

type Variables = { askId: string; answer: SessionAskAnswer };
type Callbacks = { onSuccess?: () => void; onError?: (cause: unknown) => void; onSettled?: () => void };

/** Every `mutate` the card makes; each test settles them by hand. */
const calls: { variables: Variables; callbacks: Callbacks }[] = [];
const toasts: { kind: 'success' | 'error'; message: string; description?: string }[] = [];

const realSdk = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...realSdk,
  useAnswerSessionAsk: () => ({
    mutate: (variables: Variables, callbacks: Callbacks) => calls.push({ variables, callbacks }),
  }),
}));
const realToast = await import('../../primitives/toast');
mock.module('../../primitives/toast', () => ({
  ...realToast,
  successToast: (message: string, options?: { description?: string }) =>
    toasts.push({ kind: 'success', message, description: options?.description }),
  errorToast: (message: string) => toasts.push({ kind: 'error', message }),
}));

const { SessionAccessNotice, SessionAccessPrompt, accessAsksOnScreen } = await import('./session-access-prompt');

function accessAsk(id: string, overrides: Partial<SessionAsk> = {}): SessionAsk {
  return {
    id: `access:${id}`,
    kind: 'access',
    session_id: 'session-my-kortix',
    surface_session_id: 'session-my-kortix',
    request_id: id,
    title: 'A colleague for "Invoice check" needs connector gmail and secret STRIPE_KEY',
    asked_at: '2026-11-09T10:00:00.000Z',
    expires_at: '2026-11-10T10:00:00.000Z',
    access: { colleague: 'Invoice check', connectors: ['gmail'], secrets: ['STRIPE_KEY'] },
    ...overrides,
  } as SessionAsk;
}

const permissionAsk = {
  ...accessAsk('perm'),
  id: 'permission:perm',
  kind: 'permission',
  access: undefined,
  permission: { tool: 'bash', permission: 'bash', patterns: ['ls'], args: {} },
} as SessionAsk;

function text(node: ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(text).join('');
}

function button(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  const found = renderer.root.findAllByType('button').find((node) => text(node) === label);
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}

afterEach(() => {
  calls.length = 0;
  toasts.length = 0;
});

describe('SessionAccessNotice', () => {
  test('names who asks and the task, lists each connector and secret with its kind, and offers Deny and Allow', () => {
    const html = renderToStaticMarkup(
      <SessionAccessNotice
        asks={[accessAsk('a1', { access: { colleague: 'Invoice check', connectors: ['gmail', 'slack'], secrets: ['STRIPE_KEY'] } })]}
        current={null}
        deciding={null}
        onSelect={() => undefined}
        onDecide={() => undefined}
      />,
    );

    expect(html).toContain('My Kortix asks to give a colleague access');
    expect(html).toContain('Invoice check');
    expect(html).toContain('>gmail</code>');
    expect(html).toContain('>slack</code>');
    expect(html).toContain('>STRIPE_KEY</code>');
    expect(html.match(/>Connector</g)?.length).toBe(2);
    expect(html.match(/>Secret</g)?.length).toBe(1);
    expect(html).toContain('The colleague gets only these, for this one task.');
    expect(html).toContain('>Deny<');
    expect(html).toContain('>Allow<');
    // One ask: no pager.
    expect(html).not.toContain('1 / 1');
  });

  test('several asks show one at a time behind a pager', () => {
    const html = renderToStaticMarkup(
      <SessionAccessNotice
        asks={[accessAsk('a1'), accessAsk('a2', { access: { colleague: 'Payroll run', connectors: [], secrets: ['PAYROLL_KEY'] } })]}
        current="access:a2"
        deciding={null}
        onSelect={() => undefined}
        onDecide={() => undefined}
      />,
    );

    expect(html).toContain('2 / 2');
    expect(html).toContain('Payroll run');
    expect(html).toContain('>PAYROLL_KEY</code>');
    expect(html).not.toContain('Invoice check');
    expect(html).not.toContain('>Connector<');
  });

  test('draws nothing for an ask that is not an access ask', () => {
    const html = renderToStaticMarkup(
      <SessionAccessNotice asks={[permissionAsk]} current={null} deciding={null} onSelect={() => undefined} onDecide={() => undefined} />,
    );
    expect(html).toBe('');
  });
});

describe('accessAsksOnScreen', () => {
  test('keeps the ask being decided after the cache drops it, in asked order', () => {
    const first = accessAsk('a1');
    const second = accessAsk('a2', { asked_at: '2026-11-09T11:00:00.000Z' });
    expect(accessAsksOnScreen([second, permissionAsk], first).map((ask) => ask.id)).toEqual(['access:a1', 'access:a2']);
    expect(accessAsksOnScreen([first, second], first).map((ask) => ask.id)).toEqual(['access:a1', 'access:a2']);
    expect(accessAsksOnScreen([permissionAsk], null)).toEqual([]);
  });
});

describe('SessionAccessPrompt', () => {
  for (const [label, decision] of [['Allow', 'allow'], ['Deny', 'deny']] as const) {
    test(`${label} sends { decision: '${decision}' }, keeps the card with both buttons off until it settles`, async () => {
      const docked: boolean[] = [];
      // Stable, as session-chat passes its state setter: a new callback re-runs the docking effects.
      const onDockedChange = (value: boolean) => docked.push(value);
      const ask = accessAsk('a1');
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<SessionAccessPrompt projectId="project-1" asks={[ask]} onDockedChange={onDockedChange} />);
      });

      await act(async () => {
        button(renderer, label).props.onClick();
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].variables).toEqual({ askId: 'access:a1', answer: { decision } });

      // The hook drops the ask from the cache at once; the card holds it, both buttons off.
      await act(async () => {
        renderer.update(<SessionAccessPrompt projectId="project-1" asks={[]} onDockedChange={onDockedChange} />);
      });
      expect(button(renderer, 'Allow').props.disabled).toBe(true);
      expect(button(renderer, 'Deny').props.disabled).toBe(true);
      // A second click while the first runs sends nothing.
      await act(async () => {
        button(renderer, 'Allow').props.onClick();
      });
      expect(calls).toHaveLength(1);

      await act(async () => {
        calls[0].callbacks.onSuccess?.();
        calls[0].callbacks.onSettled?.();
      });
      expect(toasts).toEqual([
        decision === 'allow'
          ? { kind: 'success', message: 'Access allowed', description: 'My Kortix starts the colleague.' }
          : { kind: 'success', message: 'Access denied', description: 'My Kortix gets your answer.' },
      ]);
      expect(renderer.root.findAllByType('button')).toHaveLength(0);
      expect(docked).toEqual([true, false]);
      await act(async () => renderer.unmount());
    });
  }

  test('a refusal shows the API error text and the card answers again', async () => {
    const ask = accessAsk('a1');
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<SessionAccessPrompt projectId="project-1" asks={[ask]} />);
    });
    await act(async () => {
      button(renderer, 'Allow').props.onClick();
    });
    const refusal = 'No agent of this workspace has secret STRIPE_KEY. Only a workspace manager can allow it.';
    await act(async () => {
      calls[0].callbacks.onError?.(new Error(refusal));
      calls[0].callbacks.onSettled?.();
    });
    expect(toasts).toEqual([{ kind: 'error', message: refusal }]);
    expect(button(renderer, 'Allow').props.disabled).toBe(false);
    expect(button(renderer, 'Deny').props.disabled).toBe(false);
    await act(async () => renderer.unmount());
  });
});
