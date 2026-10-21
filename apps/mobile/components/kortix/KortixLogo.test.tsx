/**
 * KortixLogo picks one of the baked Dosco brand PNGs from `variant` ×
 * `color` and sizes the wide variants (wordmark 1600:342) from the square
 * `size`. The symbol is the full-colour crest on both surfaces.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

type HostProps = Record<string, unknown>;
const host = (name: string) => (props: HostProps) => React.createElement(name, props);

// The png modules are mocked to named strings; CJS interop may hand the
// component the bare string or the `{ default: name }` namespace, so the
// asset under test is read back through both shapes.
mock.module('react-native', () => ({
  View: host('view'),
  Image: host('image'),
  StyleSheet: { flatten: (s: unknown) => s, create: (s: unknown) => s },
  Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android },
}));
mock.module('@/assets/brand/dosco-crest-square.png', () => ({ default: 'crest-square' }));
mock.module('@/assets/brand/dosco-wordmark-dark.png', () => ({ default: 'wordmark-dark' }));
mock.module('@/assets/brand/dosco-wordmark-light.png', () => ({ default: 'wordmark-light' }));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'dark' }) }));

const assetName = (source: unknown): string => {
  if (typeof source === 'string') return source;
  if (source && typeof source === 'object' && typeof (source as { default?: unknown }).default === 'string') {
    return (source as { default: string }).default;
  }
  return String(source);
};

let KortixLogo: typeof import('./KortixLogo').KortixLogo;
beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ KortixLogo } = await import('./KortixLogo'));
});

let tree: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
});

const render = (props: Record<string, unknown>) => {
  act(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tree = create(React.createElement(KortixLogo as any, props));
  });
  const view = tree!.root.findByType('view' as never);
  const imgEl = tree!.root.findByType('image' as never);
  return { view: view.props as Record<string, unknown>, img: imgEl.props as Record<string, unknown> };
};

describe('KortixLogo variant × color', () => {
  const WORDMARK_RATIO = 1600 / 342;
  test.each([
    ['symbol', 'dark', 'crest-square', 1],
    ['symbol', 'light', 'crest-square', 1],
    ['logomark', 'dark', 'wordmark-light', WORDMARK_RATIO],
    ['logomark', 'light', 'wordmark-dark', WORDMARK_RATIO],
    ['text', 'dark', 'wordmark-light', WORDMARK_RATIO],
    ['text', 'light', 'wordmark-dark', WORDMARK_RATIO],
  ] as const)('variant=%s color=%s renders %s at %s:1', (variant, color, asset, ratio) => {
    const { view, img } = render({ size: 24, variant, color });
    expect(assetName(img.source)).toBe(asset);
    // The wide variants scale width by their aspect ratio; the symbol is square.
    expect(img.style).toMatchObject({ width: 24 * ratio, height: 24 });
    expect(img.resizeMode).toBe('contain');
    // The wrapper reserves the same box (and never shrinks in a row).
    expect(view.style).toMatchObject({ width: 24 * ratio, height: 24, flexShrink: 0 });
  });
});
