/**
 * The shared paged gallery: one page per item, the "1 / 2" counter that follows
 * a swipe, and the shared 280pt page height. React Native is host stubs.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host = (name: string) => ({ children, ...props }: HostProps) => React.createElement(name, props, children);

mock.module('react-native', () => ({
  View: host('view'),
  ScrollView: host('scroll'),
}));
mock.module('@/components/ui/text', () => ({ Text: host('text') }));

let PagedGallery: typeof import('./paged-gallery').PagedGallery;
let GALLERY_PAGE_HEIGHT: typeof import('./paged-gallery').GALLERY_PAGE_HEIGHT;

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ PagedGallery, GALLERY_PAGE_HEIGHT } = await import('./paged-gallery'));
});

let tree: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
});

const render = (element: React.ReactElement) => {
  act(() => {
    tree = create(element);
  });
  return tree!.root;
};
const all = (root: ReactTestInstance, type: string) => root.findAll((n) => n.type === (type as never));
const texts = (root: ReactTestInstance) => all(root, 'text').flatMap((n) => n.children);
/** The outer view's onLayout, then the scroll's momentum end: a swipe to `page` (0-based). */
const layout = (root: ReactTestInstance) =>
  act(() =>
    all(root, 'view')
      .find((n) => n.props.accessibilityLabel === '2 pages')!
      .props.onLayout({ nativeEvent: { layout: { width: 320 } } }),
  );
const swipe = (root: ReactTestInstance, page: number) =>
  act(() =>
    all(root, 'scroll')
      .find((n) => n.props.onMomentumScrollEnd)!
      .props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: page * 320 } } }),
  );

const gallery = (props?: { placeholder?: React.ReactNode }) => (
  <PagedGallery
    count={2}
    accessibilityLabel="2 pages"
    placeholder={props?.placeholder}
    renderPage={(index, width) => React.createElement('view', { key: index, style: { width }, testID: `page-${index}` })}
  />
);

describe('PagedGallery', () => {
  test('one page per item, and the "1 / n" counter before any swipe', () => {
    const root = render(gallery());
    // No width yet: nothing to page, so the placeholder shows and the counter still reads 1 / 2.
    expect(all(root, 'scroll')).toHaveLength(0);
    expect(texts(root)).toEqual(['1 / 2']);
    layout(root);
    const scroll = all(root, 'scroll').find((n) => n.props.onMomentumScrollEnd)!;
    expect(scroll.props.horizontal).toBe(true);
    expect(scroll.props.pagingEnabled).toBe(true);
    expect(all(scroll, 'view').filter((n) => String(n.props.testID ?? '').startsWith('page-'))).toHaveLength(2);
    expect(texts(root)).toEqual(['1 / 2']);
  });

  test('the counter follows a swipe: "2 / n" after one page', () => {
    const root = render(gallery());
    layout(root);
    swipe(root, 1);
    expect(texts(root)).toEqual(['2 / 2']);
    swipe(root, 0);
    expect(texts(root)).toEqual(['1 / 2']);
  });

  test('before the layout the placeholder is one page-height view; the caller may draw its own', () => {
    const root = render(gallery());
    const empty = all(root, 'view').filter((n) => n.props.style?.height === GALLERY_PAGE_HEIGHT);
    expect(empty).toHaveLength(1);
    act(() => tree!.update(gallery({ placeholder: React.createElement('view', { testID: 'own-placeholder' }) })));
    expect(all(root, 'view').filter((n) => n.props.testID === 'own-placeholder')).toHaveLength(1);
    expect(all(root, 'view').filter((n) => n.props.style?.height === GALLERY_PAGE_HEIGHT)).toHaveLength(0);
  });

  test('the page height is the shared 280pt constant', () => {
    expect(GALLERY_PAGE_HEIGHT).toBe(280);
  });
});
