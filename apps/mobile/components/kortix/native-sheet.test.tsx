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
  create: (element: React.ReactElement, options?: { createNodeMock?: (element: { type: unknown }) => unknown }) => ReactTestRenderer;
};

/** The host view the native sheet measures (`measureInWindow`); set per test. */
let viewNode: unknown = null;

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
      ),
      { createNodeMock: (element) => (element.type === 'view' ? viewNode : null) }
    );
  });
}

const sheet = () => tree.root.findAll((node) => node.type === 'form-sheet')[0];
const box = () => sheet().findAll((node) => node.type === 'view')[0];
const fire = (event: string, nativeEvent: Record<string, unknown> = {}) =>
  act(() => sheet().props[event]({ nativeEvent }));
const call = (fn: (r: Ref) => void) => act(() => fn(ref.current!));
/** The content box reports its laid-out height (a content-sized sheet). */
const layout = (height: number) => act(() => box().props.onLayout({ nativeEvent: { layout: { height } } }));

beforeEach(() => {
  viewNode = null;
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
    layout(280);
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

  test('a content-sized sheet measures its content before it presents, then opens at that height', () => {
    // 800 window − 50 top − 34 bottom − 16 gap = 700 maximum detent.
    mount();
    call((r) => r.present());
    // Mounted closed: UIKit resolves the detent when it presents, so the
    // height must be known first (presented with it unknown, the sheet stood
    // at full height, opaque on iOS 26).
    expect(sheet().props.isOpen).toBe(false);
    // Laid out at the glass sheet's width (400 − 2 × 8) while it measures.
    expect(box().props.style).toEqual({ maxHeight: 700, minHeight: undefined, width: 384 });
    layout(280);
    expect(sheet().props.isOpen).toBe(true);
    expect(sheet().props.detents).toEqual([0.4]);
    expect(sheet().props.initialDetentIndex).toBe(0);
    // Presented: the box takes the sheet's own width.
    expect(box().props.style).toEqual({ maxHeight: 700, minHeight: undefined });
  });

  test('a content-sized sheet follows its content once it rests, not during the present', () => {
    mount();
    call((r) => r.present());
    layout(280);
    // A layout while UIKit still sizes the sheet (the box not yet at the sheet's width) is ignored.
    layout(690);
    expect(sheet().props.detents).toEqual([0.4]);
    fire('onWillAppear');
    fire('onDidAppear');
    layout(350.4);
    expect(sheet().props.detents).toEqual([0.502]);
    // Taller than the maximum detent: full height, the body scrolls.
    layout(700);
    expect(sheet().props.detents).toEqual([1]);
  });

  test('a height laid out while the sheet presents applies once it rests', () => {
    mount();
    call((r) => r.present());
    layout(280);
    fire('onWillAppear');
    // The list loads more rows during the present.
    layout(420);
    expect(sheet().props.detents).toEqual([0.4]);
    fire('onDidAppear');
    expect(sheet().props.detents).toEqual([0.6]);
  });

  test('a body that never lays out still opens, at the full detent, after 400 ms', () => {
    // A captured timer, not the real clock.
    const timers: { fn: () => void; ms: number }[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return Symbol('timer') as never;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
    try {
      mount();
      call((r) => r.present());
      expect(sheet().props.isOpen).toBe(false);
      const fallback = timers.find((timer) => timer.ms === 400);
      expect(fallback).toBeDefined();
      act(() => fallback!.fn());
      expect(sheet().props.isOpen).toBe(true);
      expect(sheet().props.detents).toEqual([1]);
    } finally {
      act(() => tree.unmount());
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });

  test('a content-sized sheet measures again on every present', () => {
    mount();
    call((r) => r.present());
    layout(280);
    fire('onWillAppear');
    fire('onDidAppear');
    call((r) => r.dismiss());
    fire('onDismiss');
    call((r) => r.present());
    expect(sheet().props.isOpen).toBe(false);
    layout(140);
    expect(sheet().props.detents).toEqual([0.2]);
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

  test('nativeFullDetent false: the one partial detent leaves the keyboard to UIKit', () => {
    mount({ snapPoints: ['85%', '100%'], enableDynamicSizing: false, nativeFullDetent: false });
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

describe('the measured box replaces the estimate once the sheet rests', () => {
  // Window 800. The box reports its window frame through `measureInWindow`.
  const avoider = () => tree.root.findAll((node) => node.type === 'keyboard-avoiding')[0];
  const content = () => avoider().findAll((node) => node.type === 'view')[0];
  const margin = () => (Array.isArray(content().props.style) ? Object.assign({}, ...content().props.style) : content().props.style).marginBottom;
  const frame = { y: 0, height: 0 };
  let measures = 0;
  const node = { measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => (measures++, cb(0, frame.y, 400, frame.height)) };
  const frames: Array<() => void> = [];
  const flush = () => act(() => { for (let i = 0; i < 100 && frames.length; i++) frames.shift()!(); });
  const layout = (height: number) => act(() => avoider().props.onLayout({ nativeEvent: { layout: { height } } }));

  beforeEach(() => {
    viewNode = node;
    measures = 0;
    frames.length = 0;
    (globalThis as Record<string, unknown>).requestAnimationFrame = (cb: () => void) => frames.push(cb);
    (globalThis as Record<string, unknown>).cancelAnimationFrame = () => {};
  });

  test('a screen-tall box at 85% ends its content at the screen edge (TestFlight 171: tabs below the screen)', () => {
    mount({ snapPoints: ['85%'], enableDynamicSizing: false });
    call((r) => r.present());
    // The sheet's top is 200pt down; its box is as tall as the window.
    frame.y = 200;
    frame.height = 800;
    layout(800);
    expect(measures).toBe(0); // not before the sheet rests
    fire('onDidAppear');
    flush();
    expect(margin()).toBe(200);
  });

  test('a box sized to the visible sheet hides nothing', () => {
    mount({ snapPoints: ['85%'], enableDynamicSizing: false });
    call((r) => r.present());
    frame.y = 200;
    frame.height = 592; // ends 8pt above the screen edge: the iOS 26 floating sheet
    layout(592);
    fire('onDidAppear');
    flush();
    expect(margin()).toBe(0);
  });

  test('it waits for the frame to hold still before it measures', () => {
    mount({ snapPoints: ['85%'], enableDynamicSizing: false });
    call((r) => r.present());
    frame.y = 400;
    frame.height = 800;
    layout(800);
    fire('onDidAppear');
    // Still moving: one frame later the sheet is higher.
    act(() => frames.shift()!());
    frame.y = 200;
    flush();
    expect(margin()).toBe(200);
  });

  test('a detent change drops the measurement and measures again at the new detent', () => {
    mount({ snapPoints: ['85%'], enableDynamicSizing: false });
    call((r) => r.present());
    frame.y = 200;
    frame.height = 800;
    layout(800);
    fire('onDidAppear');
    flush();
    expect(margin()).toBe(200);
    frame.y = 60;
    fire('onDetentChanged', { index: 1 });
    flush();
    expect(margin()).toBe(60);
  });

  test('a content-sized sheet never measures', () => {
    mount();
    call((r) => r.present());
    fire('onDidAppear');
    flush();
    expect(measures).toBe(0);
  });
});

describe('nativeSheetBoxBelowScreen', () => {
  const { nativeSheetBoxBelowScreen } = require('@/lib/ui/native-sheet') as typeof import('@/lib/ui/native-sheet');
  test('the part of the box past the window bottom, never more than half the box', () => {
    expect(nativeSheetBoxBelowScreen({ y: 200, height: 874, windowHeight: 874 })).toBe(200);
    expect(nativeSheetBoxBelowScreen({ y: 200, height: 600, windowHeight: 874 })).toBe(0);
    expect(nativeSheetBoxBelowScreen({ y: 870, height: 800, windowHeight: 874 })).toBe(400);
    expect(nativeSheetBoxBelowScreen({ y: Number.NaN, height: 800, windowHeight: 874 })).toBe(0);
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
