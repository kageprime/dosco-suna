/**
 * BottomSearchBar (iOS bottom search): collapsed it shows the search circle
 * and the action pill; the circle expands it into a focused field and an X
 * circle; X clears the text and collapses; text keeps it expanded after the
 * keyboard closes; Android renders nothing (pages keep the top search).
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
// @ts-ignore -- this app has no @types/react-test-renderer
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host = (name: string) => ({ children, ...props }: HostProps) => React.createElement(name, props, children);
const none = () => null;

const platform = { OS: 'ios' as string };
let keyboardDismissals = 0;

mock.module('react-native', () => ({
  View: host('view'),
  Platform: platform,
  Keyboard: { dismiss: () => void keyboardDismissals++ },
}));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'light' }) }));
mock.module('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 34 }) }));
mock.module('react-native-keyboard-controller', () => ({ KeyboardStickyView: host('sticky') }));
mock.module('@/components/kortix/header-button', () => ({ HEADER_BUTTON_SIZE: 'icon-lg', HEADER_ICON_SIZE: 22 }));
mock.module('@/components/kortix/liquid-glass', () => ({
  LIQUID_GLASS_AVAILABLE: true,
  GlassButtons: host('glass-buttons'),
  LiquidGlass: host('glass'),
}));
mock.module('@/components/kortix/pinned-bar', () => ({
  PINNED_BAR_BOTTOM_GAP: 16,
  PinnedBar: host('pinned-bar'),
  usePinnedBarInset: (h: number) => 34 + 16 + h + 16,
}));
mock.module('@/components/kortix/search-pill', () => ({ SearchPill: host('search-pill') }));
mock.module('@/components/ui/button', () => ({ Button: host('button') }));
mock.module('@/components/ui/icon', () => ({ Icon: host('icon') }));
mock.module('@/components/ui/text', () => ({ Text: host('text') }));
mock.module('@/lib/haptics', () => ({ haptics: { tap: none } }));
mock.module('@/lib/icons', () => ({ MagnifyingGlassIcon: none, XIcon: none, PlusIcon: none }));
mock.module('@/lib/ui/font-scale', () => ({ BUTTON_LABEL_MAX_FONT_SCALE: { lg: 1.5 } }));
mock.module('@/lib/utils/theme', () => ({ THEME: { light: { primary: 'black' }, dark: { primary: 'white' } } }));

let BottomSearchBar: typeof import('./bottom-search-bar').BottomSearchBar;
let GlassSearchField: typeof import('./bottom-search-bar').GlassSearchField;
beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ BottomSearchBar, GlassSearchField } = await import('./bottom-search-bar'));
});

let tree: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
  platform.OS = 'ios';
  keyboardDismissals = 0;
});

type Props = React.ComponentProps<typeof import('./bottom-search-bar').BottomSearchBar>;

/** A page that owns the text, as the list pages do. */
function Page(props: Partial<Props> & { initial?: string; onAction?: () => void }) {
  const [value, setValue] = React.useState(props.initial ?? '');
  return (
    <BottomSearchBar
      value={value}
      onChangeText={setValue}
      placeholder="Search schedules"
      action={{ label: 'New schedule', onPress: props.onAction ?? none }}
      background="white"
      {...props}
    />
  );
}

const render = (el: React.ReactElement) => {
  act(() => {
    tree = create(el);
  });
  return tree!;
};
const button = (label: string) =>
  tree!.root.findAll((n: { type: unknown; props: Record<string, unknown> }) => n.type === 'button' && n.props.accessibilityLabel === label);
const pill = () => tree!.root.findAllByType('search-pill' as never);
const textOf = (n: { findAllByType: (t: never) => Array<{ props: { children: unknown } }> }) =>
  n.findAllByType('text' as never).map((t) => String(t.props.children)).join('');

describe('BottomSearchBar', () => {
  test('collapsed: the search circle and the primary action pill, no field', () => {
    let pressed = 0;
    render(<Page onAction={() => pressed++} />);
    expect(button('Search')).toHaveLength(1);
    expect(pill()).toHaveLength(0);
    const action = tree!.root.findAll((n: { type: unknown }) => n.type === 'button').find((b: any) => textOf(b) === 'New schedule');
    expect(action).toBeTruthy();
    expect(action!.props.size).toBe('lg');
    act(() => (action!.props.onPress as () => void)());
    expect(pressed).toBe(1);
    // The glass of the pill is tinted in the primary colour.
    expect(tree!.root.findAll((n: { type: unknown; props: Record<string, unknown> }) => n.type === 'glass-buttons' && n.props.tintColor === 'black')).toHaveLength(1);
    // The bar rides on the keyboard, 10pt above it: safe area 34 + gap 16 - 10.
    expect(tree!.root.findByType('sticky' as never).props.offset).toEqual({ closed: 0, opened: 40 });
  });

  test('no action: no pill', () => {
    render(<Page action={undefined} />);
    expect(button('Search')).toHaveLength(1);
    expect(tree!.root.findAll((n: { type: unknown; props: Record<string, unknown> }) => n.type === 'button' && n.props.size === 'lg')).toHaveLength(0);
  });

  test('the search circle expands into a focused field and a Close search circle', () => {
    render(<Page />);
    act(() => (button('Search')[0].props.onPress as () => void)());
    const [field] = pill();
    expect(field).toBeTruthy();
    expect(field.props.placeholder).toBe('Search schedules');
    expect((field.props.inputProps as { autoFocus: boolean }).autoFocus).toBe(true);
    expect(button('Close search')).toHaveLength(1);
    expect(button('Search')).toHaveLength(0);
    expect(tree!.root.findAll((n: { type: unknown }) => n.type === 'button').some((b: any) => textOf(b) === 'New schedule')).toBe(false);
  });

  test('typing reaches the page; X clears the text, closes the keyboard and collapses', () => {
    render(<Page />);
    act(() => (button('Search')[0].props.onPress as () => void)());
    act(() => (pill()[0].props.onChangeText as (t: string) => void)('nightly'));
    expect(pill()[0].props.value).toBe('nightly');
    act(() => (button('Close search')[0].props.onPress as () => void)());
    expect(keyboardDismissals).toBe(1);
    expect(pill()).toHaveLength(0);
    expect(button('Search')).toHaveLength(1);
  });

  test('a blur with text keeps the field expanded; a blur with no text collapses', () => {
    render(<Page />);
    act(() => (button('Search')[0].props.onPress as () => void)());
    act(() => (pill()[0].props.onChangeText as (t: string) => void)('digest'));
    act(() => (pill()[0].props.inputProps as { onBlur: () => void }).onBlur());
    expect(pill()).toHaveLength(1);
    expect(pill()[0].props.value).toBe('digest');
    act(() => (pill()[0].props.onChangeText as (t: string) => void)(''));
    expect(pill()).toHaveLength(0);
  });

  test('a value on mount starts expanded without the keyboard; autoFocusOnMount starts focused', () => {
    render(<Page initial="kept" />);
    expect((pill()[0].props.inputProps as { autoFocus: boolean }).autoFocus).toBe(false);
    act(() => tree!.unmount());
    render(<Page autoFocusOnMount />);
    expect((pill()[0].props.inputProps as { autoFocus: boolean }).autoFocus).toBe(true);
  });

  test('the search circle stays bottom left and trailing sits right (Files); searchEnabled false hides the circle', () => {
    render(<Page action={undefined} trailing={React.createElement('view-trailing')} />);
    expect(tree!.root.findAllByType('view-trailing' as never)).toHaveLength(1);
    expect(button('Search')).toHaveLength(1);
    act(() => tree!.unmount());
    render(<Page searchEnabled={false} />);
    expect(button('Search')).toHaveLength(0);
    expect(tree!.root.findAll((n: { type: unknown }) => n.type === 'button').some((b: any) => textOf(b) === 'New schedule')).toBe(true);
  });

  test('fieldAtRest (Apps): the full field at rest with no X; focus adds the X; X clears and blurs back', () => {
    render(<Page action={undefined} fieldAtRest />);
    expect(pill()).toHaveLength(1);
    expect(button('Search')).toHaveLength(0);
    expect(button('Close search')).toHaveLength(0);
    act(() => (pill()[0]!.props.inputProps.onFocus as () => void)());
    expect(pill()).toHaveLength(1);
    expect(button('Close search')).toHaveLength(1);
    act(() => (button('Close search')[0]!.props.onPress as () => void)());
    expect(pill()).toHaveLength(1);
    expect(button('Close search')).toHaveLength(0);
  });

  test('Android renders nothing: the page keeps its top search', () => {
    platform.OS = 'android';
    render(<Page />);
    expect(tree!.toJSON()).toBeNull();
  });
});


describe('GlassSearchField (the switcher sheet)', () => {
  function Field() {
    const [value, setValue] = React.useState('');
    return <GlassSearchField value={value} onChangeText={setValue} placeholder="Search workspaces" />;
  }

  test('the field alone at rest; focus adds the X; X clears the text', () => {
    render(<Field />);
    expect(pill()).toHaveLength(1);
    expect(button('Close search')).toHaveLength(0);
    act(() => (pill()[0]!.props.inputProps.onFocus as () => void)());
    expect(button('Close search')).toHaveLength(1);
    act(() => (pill()[0]!.props.onChangeText as (t: string) => void)('acme'));
    expect(pill()[0]!.props.value).toBe('acme');
    act(() => (button('Close search')[0]!.props.onPress as () => void)());
    expect(pill()[0]!.props.value).toBe('');
  });

  test('Android: the pill sits in a row, so its flex-1 is its width, not a squeezed height', () => {
    platform.OS = 'android';
    render(<Field />);
    const parent = tree!.toJSON() as { type: string; props: { className?: string }; children: Array<{ type: string }> };
    expect(parent.type).toBe('view');
    expect(parent.props.className).toContain('flex-row');
    expect(parent.children[0]!.type).toBe('search-pill');
  });
});
