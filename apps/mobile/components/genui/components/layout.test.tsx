/**
 * The genui image gallery through `GenuiStack`: two or more images and nothing
 * else read as one gallery — one page per image, the "1 / 2" counter that
 * follows a swipe, and the shared 280pt page height. The component tree is host
 * stubs, as `genui-message-block.test.tsx`.
 * Run with `bun test --isolate`.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { type ReactTestInstance, type ReactTestRenderer, act, create } from 'react-test-renderer';

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host =
  (name: string) =>
  ({ children, ...props }: HostProps) =>
    React.createElement(name, props, children);

mock.module('react-native', () => ({
  View: host('view'),
  Text: host('rntext'),
  Pressable: host('pressable'),
  ScrollView: host('scroll'),
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios },
  useWindowDimensions: () => ({ width: 375, height: 812, fontScale: 1, scale: 3 }),
}));
mock.module('react-native-gesture-handler', () => ({ ScrollView: host('gh-scroll') }));
mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options: string | Record<string, unknown>) =>
      typeof options === 'string'
        ? options
        : String(options.defaultValue).replace(/{{(\w+)}}/g, (_m, name: string) =>
            String(options[name]),
          ),
  }),
}));
mock.module('@/components/ui/icon', () => ({ Icon: host('icon') }));
mock.module('@/components/ui/tabs', () => ({
  Tabs: host('tabs'),
  TabsList: host('tabs-list'),
  TabsTrigger: host('tabs-trigger'),
  TabsContent: host('tabs-content'),
}));
mock.module('@/components/ui/text', () => ({ Text: host('text') }));
mock.module('@/lib/icons', () => ({ StarIcon: 'star' }));
mock.module('@/components/genui/components/open-link', () => ({ openGenuiLink: () => {} }));
mock.module('@/components/genui/components/inline', () => ({
  badgeTone: () => ({ dot: '' }),
  GenuiImageView: host('genui-image'),
  GenuiImageGridContext: React.createContext<false | 'page'>(false),
  GALLERY_PAGE_HEIGHT: 280,
}));

let GenuiStack: typeof import('./layout').GenuiStack;

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ GenuiStack } = await import('./layout'));
});

let tree: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
});

const image = (id: string, src: string): import('@kortix/sdk/genui').GenuiNode =>
  ({ type: 'Image', id, props: { src, alt: id } }) as never;
const two = () => [
  image('a', 'https://example.com/a.png'),
  image('b', 'https://example.com/b.png'),
];
/** The Stack node itself, the one `GenuiStack` receives. */
const stack = (): import('@kortix/sdk/genui').GenuiNode =>
  ({ type: 'Stack', id: 's', props: { children: two() } }) as never;

const render = (element: React.ReactElement) => {
  act(() => {
    tree = create(element);
  });
  return tree!.root;
};
const all = (root: ReactTestInstance, type: string) =>
  root.findAll((n) => n.type === (type as never));
const texts = (root: ReactTestInstance) => all(root, 'text').flatMap((n) => n.children);

describe('the genui image gallery', () => {
  test('one page per image, the counter follows a swipe, the label names the count', () => {
    const root = render(
      <GenuiStack
        node={stack()}
        props={{ children: two() }}
        streaming={false}
        renderChild={(node) => React.createElement('genui-image', { key: node.id, node })}
      />,
    );
    // The pager's accessibility label is the translated "{{count}} images".
    const outer = all(root, 'view').find((n) => n.props.accessibilityLabel === '2 images')!;
    expect(outer).toBeDefined();
    expect(all(root, 'scroll')).toHaveLength(0);
    expect(texts(root)).toEqual(['1 / 2']);
    act(() => outer.props.onLayout({ nativeEvent: { layout: { width: 320 } } }));
    const scroll = all(root, 'scroll').find((n) => n.props.onMomentumScrollEnd)!;
    expect(all(scroll, 'genui-image')).toHaveLength(2);
    expect(texts(root)).toEqual(['1 / 2']);
    act(() => scroll.props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: 320 } } }));
    expect(texts(root)).toEqual(['2 / 2']);
  });

  test('before the layout the pager is one 280pt page-height view', () => {
    const root = render(
      <GenuiStack
        node={stack()}
        props={{ children: two() }}
        streaming={false}
        renderChild={(node) => React.createElement('genui-image', { key: node.id, node })}
      />,
    );
    expect(all(root, 'view').filter((n) => n.props.style?.height === 280)).toHaveLength(1);
  });
});
