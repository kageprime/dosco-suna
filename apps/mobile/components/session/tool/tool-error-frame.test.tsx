/**
 * Characterization for the `ToolError` card frame — KRTX-4758.
 *
 * Pins the exact frame the failed-tool row renders before the per-tool
 * frame vs. `ToolResultCard` unification: one bordered card (`borderWidth` 1,
 * `radiusMd`, the `resultFramePad` frame pad, `overflow` hidden), the neutral
 * border/popover tone, the row indent + `mt-1.5` seam, and a body scroll
 * capped at `outputMaxHeight`. Both `ToolError` branches (plain error,
 * validation issues) use the frame, and the card keeps its `mt-1.5` seam on
 * the detail surfaces (activity-sheet detail body), where the inline indent
 * is off. The frame chain stays real
 * (`shared/styles.ts`, `shared/surface.tsx`, `shared/result-card.tsx`); only
 * the render hosts are stubbed, so the assertions read the real style values.
 * Must pass unchanged before and after the refactor.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { mockGraph } from '@/lib/testing/mock-graph';
import React from 'react';
import { type ReactTestInstance, type ReactTestRenderer, act, create } from 'react-test-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { __DEV__?: boolean }).__DEV__ = false;

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host =
  (name: string) =>
  ({ children, ...props }: HostProps) =>
    React.createElement(name, props, children);
const none = () => null;

await mockGraph(
  ['components/session/tool/tool-error.tsx'],
  [
    // The frame chain under test stays real: the assertions below read its
    // real output.
    'components/session/tool/shared/styles',
    'components/session/tool/shared/surface',
    'components/session/tool/shared/result-card',
    'lib/session/activity',
    'lib/session/user-message',
  ],
  {
    'react-native': {
      View: host('view'),
      Pressable: host('pressable'),
      ScrollView: host('scroll-view'),
      Text: host('rn-text'),
      StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => s, hairlineWidth: 1 },
      Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios },
    },
    'react-native-css-interop': {
      jsx: host('jsx'),
      jsxs: host('jsx'),
      Fragment: 'frag',
      cssInterop: () => {},
      remapProps: () => {},
      useRGBA: () => '',
    },
    nativewind: { useColorScheme: () => ({ colorScheme: 'light' }) },
    'react-native-reanimated': {
      default: { View: host('animated-view') },
      Easing: { bezier: () => 'ease' },
      useAnimatedStyle: () => ({}),
      useSharedValue: (v: unknown) => ({ value: v }),
      withTiming: (v: unknown) => v,
    },
    'expo-clipboard': { setStringAsync: () => {} },
    // THEME is faked with distinct strings per token so the tone assertions
    // read which palette key the frame uses, not which hex it is.
    '@/lib/utils/theme': {
      THEME: {
        light: {
          background: 'bg',
          foreground: 'fg',
          popover: 'po',
          muted: 'mu',
          mutedForeground: 'mfg',
          border: 'bd',
          destructive: 'dest',
          success: 'ok',
          warning: 'w',
          primaryForeground: 'pf',
        },
        dark: {
          popover: 'po-d',
          mutedForeground: 'mfg-d',
          border: 'bd-d',
          destructive: 'dest-d',
          muted: 'mu-d',
        },
        accent: {
          blue: 'blue',
          yellow: 'yellow',
          orange: 'orange',
          green: 'green',
          purple: 'purple',
          red: 'red',
        },
      },
      MOTION: { duration: { normal: 150, fast: 100 }, easing: { inOut: [0.4, 0, 0.2, 1] } },
      withAlpha: (c: string, a?: number) => `alpha(${c},${a})`,
    },
    '@/lib/utils/mono-font': { MONO_FONT_FAMILY: 'mono' },
    '@/components/ui/button': { Button: host('button') },
    '@/components/ui/icon': { Icon: none },
    '@/components/ui/text': { Text: host('text') },
    '@/components/ui/badge': { Badge: host('badge') },
    '@/lib/icons': {
      CaretRightIcon: none,
      CheckIcon: none,
      CopyIcon: none,
      ProhibitIcon: host('prohibit'),
      WarningCircleIcon: host('warning-circle'),
    },
    '@/components/kortix/pressable-surface': { PressableSurface: host('pressable-surface') },
    '@/components/session/chain-of-thought': { DisclosureCaret: host('disclosure-caret') },
    // The store is a zustand module; the frame does not read it.
    '@/lib/session/disclosure-store': {
      disclosureKey: (kind: string, id: string) => `${kind}:${id}`,
      useDisclosureState: () => ({ open: false, toggle: () => {} }),
    },
  },
);

const ERROR = 'Sandbox command timed out';
const VALIDATION_ERROR = JSON.stringify([
  { code: 'invalid_type', message: 'Required', path: ['query', 'url'] },
]);

let mod: typeof import('./tool-error');
const { ToolDetailContext } = await import('./shared/surface');
beforeAll(async () => {
  mod = await import('./tool-error');
});

const flatStyle = (node: ReactTestInstance): Record<string, unknown> => {
  const style = node.props.style;
  if (!style) return {};
  const parts = Array.isArray(style) ? style : [style];
  return Object.assign({}, ...parts.filter((s): s is Record<string, unknown> => !!s));
};

const frames = (renderer: ReactTestRenderer): ReactTestInstance[] =>
  renderer.root.findAll(
    (node: ReactTestInstance) =>
      node.type === 'view' &&
      flatStyle(node).borderWidth === 1 &&
      flatStyle(node).borderRadius !== undefined,
  );

const scroller = (renderer: ReactTestRenderer): ReactTestInstance => {
  const [found] = renderer.root.findAll(
    (node: { type: unknown }) =>
      node.type === 'scroll-view' &&
      typeof flatStyle(node as ReactTestInstance).maxHeight === 'number',
  );
  if (!found) throw new Error('no capped body scroller');
  return found;
};

const texts = (renderer: ReactTestRenderer): string[] =>
  renderer.root
    .findAll((node: { type: unknown }) => node.type === 'text' || node.type === 'rn-text')
    .flatMap((node) => {
      const children = node.props?.children;
      return Array.isArray(children)
        ? children.filter((c): c is string => typeof c === 'string')
        : typeof children === 'string'
          ? [children]
          : [];
    });

const render = async (element: React.ReactElement): Promise<ReactTestRenderer> => {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = await create(element);
  });
  if (!tree) throw new Error('render produced no tree');
  return tree;
};

/** The frame values both branches share: one card, the seam and the indent. */
const expectFrame = (frame: ReactTestInstance): void => {
  const style = flatStyle(frame);
  expect(style.borderWidth).toBe(1);
  expect(style.borderRadius).toBe(8); // radiusMd
  expect(style.padding).toBe(0.23 * 16); // resultFramePad
  expect(style.overflow).toBe('hidden');
  expect(style.marginTop).toBe(1.5 * 0.23 * 16); // mt-1.5 seam
  expect(style.marginLeft).toBe(1.375 * 16); // the row's text column (inline surface, not a chain)
};

describe('ToolError frame characterization', () => {
  test('a plain error renders one neutral card with a capped body scroll', async () => {
    const tree = await render(
      React.createElement(mod.ToolError, { error: ERROR, toolName: 'bash', partId: 'p1' }),
    );
    const [frame] = frames(tree);
    if (!frame) throw new Error('no frame card');
    expectFrame(frame);
    const style = flatStyle(frame);
    expect(style.borderColor).toBe('bd');
    expect(style.backgroundColor).toBe('po');
    expect(flatStyle(scroller(tree)).maxHeight).toBe(96 * 0.23 * 16); // outputMaxHeight
    expect(texts(tree)).toContain(ERROR);
  });

  test('a validation error renders the same frame values in its issues branch', async () => {
    const tree = await render(
      React.createElement(mod.ToolError, { error: VALIDATION_ERROR, toolName: 'bash' }),
    );
    const [frame] = frames(tree);
    if (!frame) throw new Error('no frame card');
    expectFrame(frame);
    const style = flatStyle(frame);
    expect(style.borderColor).toBe('bd');
    expect(style.backgroundColor).toBe('po');
    expect(texts(tree)).toContain('Required');
  });

  test('on a detail surface the seam stays and the indent drops', async () => {
    const tree = await render(
      React.createElement(
        ToolDetailContext.Provider,
        { value: 'body' },
        React.createElement(mod.ToolError, { error: ERROR, toolName: 'bash', partId: 'p1' }),
      ),
    );
    const [frame] = frames(tree);
    if (!frame) throw new Error('no frame card');
    const style = flatStyle(frame);
    expect(style.borderWidth).toBe(1);
    expect(style.borderRadius).toBe(8); // radiusMd
    expect(style.padding).toBe(0.23 * 16); // resultFramePad
    expect(style.marginTop).toBe(1.5 * 0.23 * 16); // mt-1.5 seam survives
    expect(style.marginLeft).toBeFalsy(); // no row column to indent to
  });
});
