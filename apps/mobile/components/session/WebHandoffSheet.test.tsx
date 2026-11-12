/**
 * Characterization: both hand-off sheets draw the same body — a title, one
 * muted line, then the two pills (a primary `lg` and a `secondary` `lg` "Not
 * now", both `rounded-full`) — and Continue still closes the sheet before the
 * hand-off runs (`useHandoffDismiss`, Paper board 08's close-then-open rule).
 * The assertions pass before and after the shared `HandoffBody` extraction,
 * so the restructure cannot drift the body or the dismiss dance.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
// The real close-then slot, re-exported by the sheet module the sheets mock.
import { useCloseThen } from '@/components/kortix/use-close-then';
import type { SheetRef } from '@/components/kortix/sheet';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host =
  (name: string) =>
  ({ children, ...props }: HostProps) =>
    React.createElement(name, props, children);

let sheetProps: { onDismiss?: () => void } = {};
let closeCalls = 0;
mock.module('react-native', () => ({
  Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
  View: host('view'),
  Image: host('image'),
  StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => s },
}));
mock.module('@/components/kortix/sheet', () => ({
  // React 19 hands the ref to a function component as a prop.
  Sheet: function Sheet(props: { onDismiss?: () => void; children?: React.ReactNode; ref?: React.Ref<SheetRef> }) {
    sheetProps = props;
    React.useImperativeHandle(props.ref, () => ({ open: () => {}, close: () => { closeCalls++; } }));
    return React.createElement('sheet', null, props.children);
  },
  SheetBody: host('sheet-body'),
  useCloseThen,
}));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'light' }) }));
mock.module('react-native-svg', () => ({
  default: host('svg'),
  Svg: host('svg'),
  Circle: host('circle'),
  SvgUri: host('svg-uri'),
}));
mock.module('@/components/kortix/KortixLogo', () => ({ KortixLogo: host('kortix-logo') }));
mock.module('@/components/ui/skeleton', () => ({ Skeleton: host('skeleton') }));
mock.module('@/components/ui/button', () => ({ Button: host('button') }));
mock.module('@/components/ui/icon', () => ({ Icon: ({ as, ...props }: HostProps & { as?: unknown }) => React.createElement('icon', props) }));
mock.module('@/components/ui/text', () => ({ Text: host('text'), TextClassContext: React.Fragment }));
mock.module('@/lib/icons', () => ({
  ArrowUpRightIcon: host('icon-arrow-up-right'),
  CheckIcon: host('icon-check'),
  PlugIcon: host('icon-plug'),
}));
mock.module('@/lib/utils/theme', () => ({
  THEME: {
    light: { mutedForeground: '#666', secondary: '#eee', popover: '#fff', background: '#fff', border: '#ddd' },
    dark: { mutedForeground: '#999', secondary: '#111', popover: '#000', background: '#000', border: '#222' },
  },
  withAlpha: (c: string, a: number) => `${c}@${a}`,
}));
mock.module('@/lib/haptics', () => ({ haptics: { tap: () => {} } }));

let WebHandoffSheet: typeof import('./WebHandoffSheet').WebHandoffSheet;
let HandoffSheetBody: typeof import('./connector-handshake').HandoffSheetBody;
beforeAll(async () => {
  ({ WebHandoffSheet } = await import('./WebHandoffSheet'));
  ({ HandoffSheetBody } = await import('./connector-handshake'));
});

let tree: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
  sheetProps = {};
  closeCalls = 0;
});

const render = async (element: React.ReactElement) => {
  await act(async () => {
    tree = create(element);
  });
  return tree!;
};

const texts = (root: ReactTestRenderer, variant: string) =>
  root.root.findAll(({ type, props }: ReactTestInstance) => type === 'text' && props.variant === variant) as ReactTestInstance[];
const buttons = (root: ReactTestRenderer) => root.root.findAll(({ type }: ReactTestInstance) => type === 'button') as ReactTestInstance[];

/** The body's stack: one large title, one muted line, the two `lg` pills. */
const pillLabel = (b: ReactTestInstance) => {
  const t = b.findAll(({ type }: ReactTestInstance) => type === 'text')[0];
  return t ? String(t.props.children) : '';
};
const bodyStack = (root: ReactTestRenderer) => ({
  title: texts(root, 'large').map((t) => t.props.children)[0],
  line: texts(root, 'muted').map((t) => t.props.children)[0],
  pills: buttons(root).map((b) => `${b.props.variant ?? 'default'}:${pillLabel(b)}`),
});

describe('the hand-off sheets draw one body', () => {
  const run = { calls: 0 };
  const cancel = { calls: 0 };

  afterEach(() => {
    run.calls = 0;
    cancel.calls = 0;
  });

  test('the web hand-off sheet: title, muted line, Continue + Not now pills', async () => {
    await render(
      React.createElement(WebHandoffSheet, {
        title: 'Continue on the web',
        line: 'Connectors live on kortix.com.',
        run: () => {
          run.calls++;
        },
        onCancel: () => {
          cancel.calls++;
        },
      }),
    );
    expect(bodyStack(tree!)).toEqual({
      title: 'Continue on the web',
      line: 'Connectors live on kortix.com.',
      pills: ['default:Continue', 'secondary:Not now'],
    });
  });

  test('Continue closes the sheet first; the hand-off runs only from the dismiss', async () => {
    await render(
      React.createElement(WebHandoffSheet, {
        title: 'Continue on the web',
        line: 'Connectors live on kortix.com.',
        run: () => {
          run.calls++;
        },
        onCancel: () => {
          cancel.calls++;
        },
      }),
    );
    const [continuePill] = buttons(tree!);
    await act(async () => {
      continuePill.props.onPress?.();
    });
    // Close-then-open: the sheet closed, the hand-off has not run yet.
    expect(closeCalls).toBe(1);
    expect(run.calls).toBe(0);
    await act(async () => {
      sheetProps.onDismiss?.();
    });
    expect(run.calls).toBe(1);
    expect(cancel.calls).toBe(0);
  });

  test('Not now closes without running the hand-off, and the caller may come back', async () => {
    await render(
      React.createElement(WebHandoffSheet, {
        title: 'Continue on the web',
        line: 'Connectors live on kortix.com.',
        run: () => {
          run.calls++;
        },
        onCancel: () => {
          cancel.calls++;
        },
      }),
    );
    const notNow = buttons(tree!).at(-1)!;
    await act(async () => {
      notNow.props.onPress?.();
    });
    expect(closeCalls).toBe(1);
    await act(async () => {
      sheetProps.onDismiss?.();
    });
    expect(run.calls).toBe(0);
    expect(cancel.calls).toBe(1);
  });

  test('the connector hand-off sheet draws the same body with the handshake leading', async () => {
    await render(
      React.createElement(HandoffSheetBody, {
        name: 'GitHub',
        iconUrl: null,
        title: 'Connect GitHub',
        body: 'A browser opens to finish.',
        action: 'Continue to GitHub',
        onContinue: () => {},
        onClose: () => {},
      }),
    );
    const stack = bodyStack(tree!);
    // Same body stack as the web sheet: one title, one muted line, the two pills.
    expect(stack.title).toBe('Connect GitHub');
    expect(stack.line).toBe('A browser opens to finish.');
    expect(stack.pills.at(-2)).toContain('default');
    expect(stack.pills.at(-1)).toBe('secondary:Not now');
    // The handshake leads (Kortix · · · App), then the title reads as a header.
    expect(tree!.root.findAll(({ type }: { type: unknown }) => type === 'kortix-logo')).toHaveLength(1);
    const title = texts(tree!, 'large')[0];
    expect(title.props.accessibilityRole).toBe('header');
    // The connector hand-off's Continue carries the leaves-the-app arrow.
    const continuePill = buttons(tree!).at(-2)!;
    expect(continuePill.props.variant).toBeUndefined();
    expect(continuePill.findAll(({ type }: { type: unknown }) => type === 'icon')).toHaveLength(1);
  });

  test('the web sheet takes the shared body settled values (declared deltas, see the PR)', async () => {
    await render(
      React.createElement(WebHandoffSheet, {
        title: 'Continue on the web',
        line: 'Connectors live on kortix.com.',
        run: () => {},
      }),
    );
    // The one body's stack, settled by the dedupe on the connector stack's
    // values: a header title, an inset muted line, the pills on the composer's
    // 8pt step (the web sheet's old `mt-6`/`gap: 10` was the drift).
    const title = texts(tree!, 'large')[0];
    expect(title.props.accessibilityRole).toBe('header');
    const line = texts(tree!, 'muted')[0];
    expect(line.props.className).toBe('mt-2 px-4 text-center leading-5');
    const stack = tree!.root.findAll(
      ({ type, props }: { type: unknown; props: { className?: string } }) =>
        type === 'view' && String(props.className ?? '').includes('mt-8 w-full gap-2'),
    );
    expect(stack).toHaveLength(1);
  });
});
