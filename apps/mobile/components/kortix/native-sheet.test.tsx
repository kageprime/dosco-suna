/**
 * NativeSheet: gorhom's `BottomSheetModal` ref over the iOS native sheet
 * (`FormSheet`, react-native-screens). The native view is a host stand-in;
 * the test drives its events the way `RNSFormSheetHostComponentView.mm` emits
 * them (`onWillAppear` → `onDidAppear`; `onDismiss` after a dismissal from
 * `isOpen` false; `onNativeDismiss` after a swipe) and asserts the props the
 * native side receives and the callbacks the call site gets.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';

type TestNode = { type: unknown; props: Record<string, any>; findAll: (predicate: (node: TestNode) => boolean) => TestNode[] };
type ReactTestRenderer = {
  root: { findAll: (predicate: (node: TestNode) => boolean) => TestNode[] };
  update: (element: React.ReactElement) => void;
  unmount: () => void;
};
const { act, create } = require('react-test-renderer') as {
  act: (fn: () => void) => void;
  create: (element: React.ReactElement) => ReactTestRenderer;
};

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host = (name: string) => ({ children, ...props }: HostProps) => React.createElement(name, props, children);

let keyboardDismisses = 0;
const layoutAnimations: unknown[] = [];
mock.module('react-native', () => ({
  Keyboard: { dismiss: () => void keyboardDismisses++ },
  LayoutAnimation: { configureNext: (config: unknown) => void layoutAnimations.push(config) },
  Platform: { OS: 'ios', Version: '26.0' },
  StyleSheet: { flatten: (style: unknown) => (Array.isArray(style) ? Object.assign({}, ...style) : style) },
  View: host('view'),
  FlatList: host('rn-flat-list'),
  TextInput: host('rn-text-input'),
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));
mock.module('react-native-screens/experimental', () => ({ FormSheet: host('form-sheet') }));
const motion = { reduced: false };
mock.module('react-native-reanimated', () => ({ useSharedValue: (value: number) => ({ value }), useReducedMotion: () => motion.reduced }));
const SafeAreaInsetsContext = React.createContext<{ top: number; bottom: number } | null>(null);
mock.module('react-native-safe-area-context', () => ({
  SafeAreaInsetsContext,
  useSafeAreaInsets: () => React.useContext(SafeAreaInsetsContext) ?? { top: 50, bottom: 34 },
}));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'dark' }) }));
mock.module('@/lib/theme-colors', () => ({ getSheetBg: (dark: boolean) => (dark ? 'sheet-dark' : 'sheet-light') }));
mock.module('@/components/kortix/pinned-bar', () => ({ PinnedBarShiftContext: React.createContext(null) }));
mock.module('react-native-keyboard-controller', () => ({ useKeyboardState: (select: (s: { height: number }) => number) => select({ height: 300 }), KeyboardAwareScrollView: host('keyboard-aware-scroll'), KeyboardAvoidingView: host('keyboard-avoiding') }));
mock.module('@gorhom/bottom-sheet', () => ({
  BottomSheetScrollView: host('gorhom-scroll'),
  BottomSheetView: host('gorhom-view'),
  BottomSheetTextInput: host('gorhom-text-input'),
  BottomSheetFlatList: host('gorhom-flat-list'),
  BottomSheetFooter: host('gorhom-footer'),
  TouchableOpacity: host('touchable'),
  useBottomSheetInternal: () => null,
  useBottomSheetModal: () => ({ dismiss: () => {} }),
}));

// The JSI global React Native installs: this binary has the form sheet.
(globalThis as Record<string, unknown>).__nativeComponentRegistry__hasComponent = (name: string) =>
  name === 'RNSFormSheetHost';

const { NativeSheet, NATIVE_SHEET_AVAILABLE } = require('./native-sheet') as typeof import('./native-sheet');
const { SheetScrollView, SheetFooter, useSheetDismiss } = require('./sheet-parts') as typeof import('./sheet-parts');
const { SheetSettledContext } = require('./sheet-settled') as typeof import('./sheet-settled');

type Ref = {
  present: (data?: unknown) => void;
  dismiss: () => void;
  expand: () => void;
  collapse: () => void;
  snapToIndex: (index: number) => void;
  snapToPosition: (position: string | number) => void;
};

let tree: ReactTestRenderer;
let ref: React.RefObject<Ref | null>;
let changes: number[];
let dismisses: number;

function SettledProbe() {
  const settled = React.useContext(SheetSettledContext);
  return React.createElement('settled-probe', { settled });
}

function DismissProbe() {
  const dismiss = useSheetDismiss();
  return React.createElement('dismiss-probe', { dismiss });
}

function mount(props: Record<string, unknown> = {}, children: React.ReactNode = null) {
  ref = React.createRef<Ref>();
  act(() => {
    tree = create(
      React.createElement(
        NativeSheet as never,
        {
          ref,
          header: React.createElement('header'),
          onChange: (index: number) => changes.push(index),
          onDismiss: () => dismisses++,
          ...props,
        },
        children ?? React.createElement(SettledProbe)
      )
    );
  });
}

const sheet = () => tree.root.findAll((node) => node.type === 'form-sheet')[0];
const box = () => sheet().findAll((node) => node.type === 'view')[0];
const fire = (event: string, nativeEvent: Record<string, unknown> = {}) =>
  act(() => sheet().props[event]({ nativeEvent }));
const call = (fn: (r: Ref) => void) => act(() => fn(ref.current!));

beforeEach(() => {
  changes = [];
  dismisses = 0;
  keyboardDismisses = 0;
});

describe('NATIVE_SHEET_AVAILABLE', () => {
  test('iOS with RNSFormSheetHost registered picks the native sheet', () => {
    expect(NATIVE_SHEET_AVAILABLE).toBe(true);
  });
});

describe('NativeSheet', () => {
  test('nothing is mounted until present(); present opens it and closes the keyboard', () => {
    mount({ snapPoints: ['40%', '100%'], enableDynamicSizing: false, index: 1 });
    expect(tree.root.findAll((node) => node.type === 'form-sheet')).toHaveLength(0);
    call((r) => r.present());
    expect(keyboardDismisses).toBe(1);
    expect(sheet().props.isOpen).toBe(true);
    expect(sheet().props.detents).toEqual([0.4, 1]);
    expect(sheet().props.initialDetentIndex).toBe(1);
    expect(sheet().props.prefersGrabberVisible).toBe(true);
    expect(sheet().props.preventNativeDismiss).toBe(false);
  });

  test('settled and onChange follow the native appear', () => {
    mount({ snapPoints: ['92%'], enableDynamicSizing: false });
    call((r) => r.present());
    const probe = () => tree.root.findAll((node) => node.type === 'settled-probe')[0];
    expect(probe().props.settled).toBe(false);
    fire('onWillAppear');
    fire('onDidAppear');
    expect(probe().props.settled).toBe(true);
    expect(changes).toEqual([0]);
    fire('onDetentChanged', { index: 1 });
    expect(changes).toEqual([0, 1]);
  });

  test('dismiss() closes natively; the body unmounts and onDismiss runs once the close finishes', () => {
    mount();
    call((r) => r.present());
    fire('onWillAppear');
    fire('onDidAppear');
    call((r) => r.dismiss());
    expect(sheet().props.isOpen).toBe(false);
    expect(dismisses).toBe(0);
    fire('onDismiss');
    expect(tree.root.findAll((node) => node.type === 'form-sheet')).toHaveLength(0);
    expect(dismisses).toBe(1);
    expect(changes).toEqual([0, -1]);
  });

  test('a swipe down (onNativeDismiss) ends the sheet the same way', () => {
    mount();
    call((r) => r.present());
    fire('onWillAppear');
    fire('onNativeDismiss');
    expect(tree.root.findAll((node) => node.type === 'form-sheet')).toHaveLength(0);
    expect(dismisses).toBe(1);
  });

  test('a dismiss before the sheet appeared ends it at once (no native close to wait for)', () => {
    mount();
    call((r) => r.present());
    call((r) => r.dismiss());
    expect(tree.root.findAll((node) => node.type === 'form-sheet')).toHaveLength(0);
    expect(dismisses).toBe(1);
  });

  test('present() during the close keeps the body; the close still reaches the call site', () => {
    mount();
    call((r) => r.present());
    fire('onWillAppear');
    call((r) => r.dismiss());
    call((r) => r.present());
    expect(sheet().props.isOpen).toBe(true);
    fire('onDismiss');
    expect(sheet().props.isOpen).toBe(true);
    expect(dismisses).toBe(1);
  });

  test('enablePanDownToClose={false} prevents the native dismiss', () => {
    mount({ enablePanDownToClose: false });
    call((r) => r.present());
    expect(sheet().props.preventNativeDismiss).toBe(true);
  });

  test('a content-sized sheet fits its content, capped at the maximum detent', () => {
    // 800 window − 50 top − 34 bottom − 16 gap.
    mount();
    call((r) => r.present());
    expect(sheet().props.detents).toBe('fitToContents');
    expect(box().props.style).toEqual({ maxHeight: 700, minHeight: undefined });
  });

  test('maxDynamicContentSize lowers the cap', () => {
    mount({ maxDynamicContentSize: 500 });
    call((r) => r.present());
    expect(box().props.style.maxHeight).toBe(500);
  });

  test("snapToPosition('100%') holds a content-sized sheet at full height; snapToIndex(0) returns", () => {
    mount();
    call((r) => r.present());
    call((r) => r.snapToPosition('100%'));
    expect(box().props.style.minHeight).toBe(700);
    call((r) => r.snapToIndex(0));
    expect(box().props.style.minHeight).toBeUndefined();
  });

  test('expand() lists only the full detent on a fixed-detent sheet; collapse() restores the list', () => {
    mount({ snapPoints: ['40%'], enableDynamicSizing: false });
    call((r) => r.present());
    call((r) => r.expand());
    expect(sheet().props.detents).toEqual([1]);
    call((r) => r.collapse());
    expect(sheet().props.detents).toEqual([0.4, 1]);
  });

  test('iOS 26 leaves the background to the system glass; an explicit backgroundStyle wins', () => {
    mount();
    call((r) => r.present());
    expect(sheet().props.nativeContainerStyle).toBeUndefined();
    mount({ backgroundStyle: { backgroundColor: 'page' } });
    call((r) => r.present());
    expect(sheet().props.nativeContainerStyle).toEqual({ backgroundColor: 'page' });
  });

  test('content parts render the plain part inside the native sheet', () => {
    mount({}, React.createElement(React.Fragment, null, React.createElement(SheetScrollView), React.createElement(DismissProbe)));
    call((r) => r.present());
    expect(tree.root.findAll((node) => node.type === 'keyboard-aware-scroll')).toHaveLength(1);
    expect(tree.root.findAll((node) => node.type === 'gorhom-scroll')).toHaveLength(0);
    fire('onWillAppear');
    // `useSheetDismiss` closes this native sheet, not a gorhom modal.
    const probe = tree.root.findAll((node) => node.type === 'dismiss-probe')[0];
    act(() => probe.props.dismiss());
    expect(sheet().props.isOpen).toBe(false);
  });

  test('a footerComponent renders as a component with the footer props', () => {
    const footer = ({ animatedFooterPosition }: { animatedFooterPosition: { value: number } }) =>
      React.createElement(SheetFooter as never, { animatedFooterPosition }, React.createElement('verdicts'));
    mount({ footerComponent: footer });
    call((r) => r.present());
    expect(tree.root.findAll((node) => node.type === 'verdicts')).toHaveLength(1);
    expect(tree.root.findAll((node) => node.type === 'gorhom-footer')).toHaveLength(0);
  });

  test('outside a native sheet the parts stay gorhom', () => {
    act(() => {
      tree = create(React.createElement(SheetScrollView));
    });
    expect(tree.root.findAll((node) => node.type === 'gorhom-scroll')).toHaveLength(1);
  });
});

describe('bottom safe area', () => {
  function InsetProbe() {
    const insets = React.useContext(SafeAreaInsetsContext);
    return React.createElement('inset-probe', { bottom: insets?.bottom });
  }
  const probe = () => tree.root.findAll((node) => node.type === 'inset-probe')[0];

  test('a content-sized sheet reads bottom 0: UIKit puts the home indicator under the content', () => {
    mount({}, React.createElement(InsetProbe));
    call((r) => r.present());
    expect(probe().props.bottom).toBe(0);
  });

  test('a fixed-detent sheet keeps the real bottom inset: its content reaches the screen edge', () => {
    mount({ snapPoints: ['50%'], enableDynamicSizing: false }, React.createElement(InsetProbe));
    call((r) => r.present());
    expect(probe().props.bottom).toBe(34);
  });
});

describe('keyboard', () => {
  const avoider = () => tree.root.findAll((node) => node.type === 'keyboard-avoiding')[0];

  test('a content-sized sheet has no avoider: UIKit lifts it above the keyboard', () => {
    mount();
    call((r) => r.present());
    expect(avoider()).toBeUndefined();
  });

  test('a fixed-detent sheet below its full detent leaves the keyboard to UIKit', () => {
    mount({ snapPoints: ['50%'], enableDynamicSizing: false });
    call((r) => r.present());
    expect(avoider().props.enabled).toBe(false);
  });

  test('at the full detent the box shrinks above the keyboard, offset by the sheet top', () => {
    mount({ snapPoints: ['50%'], enableDynamicSizing: false });
    call((r) => r.present());
    // The call site's 50% plus the appended full detent: index 1 is full.
    fire('onDetentChanged', { index: 1 });
    expect(avoider().props.enabled).toBe(true);
    act(() => avoider().props.onLayout({ nativeEvent: { layout: { height: 730 } } }));
    // Window 800, box 730: the sheet's top sits 70pt down the screen.
    expect(avoider().props.keyboardVerticalOffset).toBe(70);
  });

  test('expand() counts as the full detent', () => {
    mount({ snapPoints: ['50%'], enableDynamicSizing: false });
    call((r) => r.present());
    call((r) => r.expand());
    expect(avoider().props.enabled).toBe(true);
  });
});

describe('the content ends at the visible edge', () => {
  // Window 800, insets 50 / 34: maximum detent 700, full-height box 734.
  const avoider = () => tree.root.findAll((node) => node.type === 'keyboard-avoiding')[0];
  const content = () => avoider().findAll((node) => node.type === 'view')[0];
  const margin = () => (Array.isArray(content().props.style) ? Object.assign({}, ...content().props.style) : content().props.style).marginBottom;
  const layout = (height: number) => act(() => avoider().props.onLayout({ nativeEvent: { layout: { height } } }));

  test('a box laid out at the full detent ends the content above the part below the screen (the picker tabs)', () => {
    mount({ snapPoints: ['85%'], enableDynamicSizing: false });
    call((r) => r.present());
    layout(734);
    expect(margin()).toBe(105);
  });

  test('a box UIKit sized to the detent is left alone', () => {
    mount({ snapPoints: ['85%'], enableDynamicSizing: false });
    call((r) => r.present());
    layout(0.85 * 700 + 34);
    expect(margin()).toBe(0);
  });

  test('the full detent and expand() hide nothing', () => {
    mount({ snapPoints: ['85%'], enableDynamicSizing: false });
    call((r) => r.present());
    layout(734);
    fire('onDetentChanged', { index: 1 });
    expect(margin()).toBe(0);
    fire('onDetentChanged', { index: 0 });
    expect(margin()).toBe(105);
    call((r) => r.expand());
    expect(margin()).toBe(0);
  });

  test('a detent change eases the content end instead of jumping', () => {
    mount({ snapPoints: ['85%'], enableDynamicSizing: false });
    call((r) => r.present());
    layoutAnimations.length = 0;
    fire('onDetentChanged', { index: 1 });
    expect(layoutAnimations).toEqual([{ duration: 200, update: { type: 'easeOut' } }]);
  });

  test('expand() and collapse() from code ease it too; a content-sized sheet never animates', () => {
    mount({ snapPoints: ['85%'], enableDynamicSizing: false });
    call((r) => r.present());
    layoutAnimations.length = 0;
    call((r) => r.expand());
    call((r) => r.collapse());
    expect(layoutAnimations).toHaveLength(2);
    act(() => tree.unmount());
    mount();
    call((r) => r.present());
    layoutAnimations.length = 0;
    call((r) => r.expand());
    expect(layoutAnimations).toHaveLength(0);
  });

  test('no animation when the detent does not change: a repeated collapse(), the same detent reported again', () => {
    mount({ snapPoints: ['85%'], enableDynamicSizing: false });
    call((r) => r.present());
    layoutAnimations.length = 0;
    call((r) => r.collapse());
    fire('onDetentChanged', { index: 0 });
    call((r) => r.snapToIndex(0));
    expect(layoutAnimations).toHaveLength(0);
  });

  test('Reduce Motion moves the content end at once', () => {
    motion.reduced = true;
    try {
      mount({ snapPoints: ['85%'], enableDynamicSizing: false });
      call((r) => r.present());
      layoutAnimations.length = 0;
      fire('onDetentChanged', { index: 1 });
      call((r) => r.expand());
      expect(layoutAnimations).toHaveLength(0);
    } finally {
      motion.reduced = false;
    }
  });
});

describe('one owner for the keyboard space', () => {
  const scroll = () => tree.root.findAll((node) => node.type === 'keyboard-aware-scroll')[0];
  const body = () => React.createElement(SheetScrollView as never, {}, React.createElement('row'));

  test('the scroll view never adds the keyboard as an inset, at any detent', () => {
    mount({ snapPoints: ['50%'], enableDynamicSizing: false }, body());
    call((r) => r.present());
    expect(scroll().props.extraKeyboardSpace).toBe(-300);
    // A detent change keeps the same value: no stale cached inset to refresh.
    fire('onDetentChanged', { index: 1 });
    expect(scroll().props.extraKeyboardSpace).toBe(-300);
  });
});
