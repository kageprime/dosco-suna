/**
 * NativeSheet — `KortixBottomSheetModal` on iOS: the system sheet
 * (UISheetPresentationController, the iOS 26 Liquid Glass sheet) through
 * `FormSheet` from `react-native-screens/experimental`. Native grabber, native
 * detents, native pan-to-dismiss, the native dimming and corner radius.
 *
 * It keeps gorhom's `BottomSheetModal` ref (`present`, `dismiss`, `close`,
 * `snapToIndex`, …), so every call site is unchanged. `KortixBottomSheetModal`
 * picks it once per binary (`NATIVE_SHEET_AVAILABLE`); Android and an iOS
 * binary without `RNSFormSheetHost` keep gorhom.
 *
 * How the native side behaves (react-native-screens 4.30.1,
 * `ios/gamma/modals/form-sheet/`):
 * - `isOpen` true presents from the top-most presented view controller of the
 *   host's window (`RNSPresentationSourceProvider`), so a sheet opened from
 *   inside another sheet stacks on it. Dismissing a lower sheet tears down the
 *   ones above it; each of those reports `onNativeDismiss`.
 * - The host draws nothing and takes no touch (`hitTest` returns nil); its
 *   children are mounted in the sheet's own view and laid out at the sheet's
 *   size (the host is a root node kind sized from the native view).
 * - `onDismiss` fires after a dismissal from `isOpen` false finishes;
 *   `onNativeDismiss` after a swipe down or a backdrop tap. Either one ends the
 *   sheet here: the body unmounts (as gorhom unmounts a modal's content), then
 *   the call site's `onChange(-1)` and `onDismiss` run.
 * - Detents are set only as a list, and the selected detent only on open
 *   (`initialDetentIndex`). A detent list change while open re-applies the
 *   list and keeps the selected identifier (`"0"`, `"1"`, …).
 *
 * gorhom features with no native counterpart, and what this does instead:
 * - `snapToIndex(i)` while open: no native call selects a detent. It undoes
 *   `expand()` / `snapToPosition()` (the only uses: back from a pushed view),
 *   which returns to detent 0. Any other index is a no-op.
 * - `expand()` / `snapToPosition(p)`: a content-sized sheet gets a minimum
 *   height of the maximum detent; a fixed-detent sheet lists only the full
 *   detent until `collapse()` / `snapToIndex()`.
 * - A content-sized sheet cannot list a full detent beside `fitToContents`
 *   (`lib/ui/native-sheet.ts`). It fits its content up to the maximum height.
 * - `backdropComponent` (the lighter backdrops), `topInset`, `handleComponent`,
 *   `animationConfigs`, `enableOverDrag`, `keyboardBehavior`,
 *   `keyboardBlurBehavior` and `android_keyboardInputMode` have no effect: the
 *   system dims, stops the full detent under the status bar, draws the
 *   grabber and runs its own motion. The keyboard is handled by the content
 *   parts (`sheet-parts.tsx`).
 * - `enableContentPanningGesture={false}` turns off
 *   `prefersScrollingExpandsWhenScrolledToEdge`; a drag on a scroll view does
 *   not resize the sheet, but iOS can still dismiss it from a scroll at its top.
 * - gorhom's `stackBehavior` ("switch": hide the lower sheet) has no
 *   counterpart: native sheets stack.
 */
import * as React from 'react';
// A namespace import: a component test that mocks `react-native` with only the
// names its own graph uses still loads this module.
import * as RN from 'react-native';
import type { ViewStyle } from 'react-native';
import type { BottomSheetModal, BottomSheetModalProps } from '@gorhom/bottom-sheet';
import type { FormSheetProps } from 'react-native-screens/experimental';
import { useReducedMotion, useSharedValue } from 'react-native-reanimated';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';

import { getSheetBg } from '@/lib/theme-colors';
import { detentsKey } from '@/lib/ui/sheet-detents';
import {
  hasNativeComponent,
  nativeSheetHiddenBottom,
  nativeSheetMaxHeight,
  resolveNativeDetents,
  supportsNativeSheet,
} from '@/lib/ui/native-sheet';
import { PinnedBarShiftContext } from '@/components/kortix/pinned-bar';
import { SheetSettledContext } from '@/components/kortix/sheet-settled';
import { SurfaceContext } from '@/components/kortix/surface-context';
import { NativeSheetContext, type NativeSheetApi } from '@/components/kortix/native-sheet-context';

/** The native sheet is in this binary (iOS, `RNSFormSheetHost` registered). Fixed per launch. */
export const NATIVE_SHEET_AVAILABLE = supportsNativeSheet(
  RN.Platform?.OS,
  RN.Platform?.OS === 'ios' && hasNativeComponent('RNSFormSheetHost')
);

// `require` only when the binary has the component: no gamma module loads on
// Android or on a binary without it.
const FormSheet: ((props: FormSheetProps) => React.JSX.Element) | null = NATIVE_SHEET_AVAILABLE
  ? require('react-native-screens/experimental').FormSheet
  : null;

/**
 * iOS 26 draws the sheet's own Liquid Glass background when the content view
 * is clear (react-native-screens leaves it clear without
 * `nativeContainerStyle.backgroundColor`). Before 26 a clear sheet is
 * see-through, so it gets the sheet colour.
 */
const SYSTEM_SHEET_GLASS =
  RN.Platform?.OS === 'ios' && Number.parseInt(String(RN.Platform?.Version), 10) >= 26;

type Phase = 'closed' | 'open' | 'closing';

export interface NativeSheetProps extends BottomSheetModalProps {
  /** The title row (or the handle spacer), drawn at the top of the content. */
  header: React.ReactNode;
}

export const NativeSheet = React.forwardRef<BottomSheetModal, NativeSheetProps>(function NativeSheet(
  {
    header,
    children,
    snapPoints,
    enableDynamicSizing = true,
    index = 0,
    enablePanDownToClose = true,
    enableContentPanningGesture = true,
    maxDynamicContentSize,
    footerComponent,
    backgroundStyle,
    onChange,
    onDismiss,
  },
  ref
) {
  const [phase, setPhase] = React.useState<Phase>('closed');
  const phaseRef = React.useRef<Phase>('closed');
  const setPhaseBoth = React.useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);
  const [expanded, setExpanded] = React.useState(false);
  /** The detent the sheet rests at (index into the call site's detents). */
  const [detentAt, setDetentAt] = React.useState(0);
  const [settled, setSettled] = React.useState(false);
  const [data, setData] = React.useState<unknown>(undefined);
  // Set by `onWillAppear`: the sheet reached the screen. A dismiss before it
  // ends the sheet at once (there is no native dismissal to wait for).
  const appearedRef = React.useRef(false);

  const { height: windowHeight } = RN.useWindowDimensions();
  // The screen's insets. A sheet opened inside a content-sized sheet reads that
  // sheet's override (bottom 0), so the outermost sheet passes the real ones down.
  const contextInsets = useSafeAreaInsets();
  const insets = React.useContext(ScreenInsetsContext) ?? contextInsets;
  const maxHeight = nativeSheetMaxHeight(windowHeight, insets.top, insets.bottom);
  const key = detentsKey(snapPoints);
  const { detents: baseDetents, initialIndex } = React.useMemo(
    () => resolveNativeDetents({ snapPoints, dynamicSizing: enableDynamicSizing !== false, index, maxHeight }),
    // Keyed by value: most call sites pass an inline array.
    [key, enableDynamicSizing, index, maxHeight]
  );
  const fit = baseDetents === 'fitToContents';
  // A fixed-detent sheet's content end (`SheetBox`'s hidden margin) follows
  // its detent: ease it there instead of a jump of the bottom bar. Only when
  // the visible fraction really changes (a configured animation that no commit
  // uses would wait and animate an unrelated later update), and not under
  // Reduce Motion. Every other layout change in the same commit (the call
  // site's `onChange`, the keyboard avoider turning on) eases with it.
  const reducedMotion = useReducedMotion();
  const layoutRef = React.useRef({ fit, baseDetents, detentAt, expanded, reducedMotion });
  const easeDetentChange = React.useCallback((next: { expanded: boolean; detentAt: number }) => {
    const now = layoutRef.current;
    if (now.fit || now.reducedMotion) return;
    const detents = now.baseDetents as number[];
    const fractionOf = (at: { expanded: boolean; detentAt: number }) => (at.expanded ? 1 : (detents[at.detentAt] ?? 1));
    if (fractionOf(next) === fractionOf(now)) return;
    RN.LayoutAnimation?.configureNext(DETENT_LAYOUT);
  }, []);
  const detents = !fit && expanded ? [1] : baseDetents;

  const onChangeRef = React.useRef(onChange);
  const onDismissRef = React.useRef(onDismiss);
  React.useLayoutEffect(() => {
    onChangeRef.current = onChange;
    layoutRef.current = { fit, baseDetents, detentAt, expanded, reducedMotion };
    onDismissRef.current = onDismiss;
  });

  // `native`: a swipe down, a backdrop tap, or a lower sheet torn down. The
  // native side has set its own `isOpen` to false, so the sheet always ends:
  // an `isOpen` left true here would never present again.
  const finish = React.useCallback((native: boolean) => {
    // `present()` during a close from code: the native side presents again on
    // its own (its `onWillAppear` arrives before this `onDismiss`), so the body
    // and the appeared flag stay. The close still counts for the call site.
    if (native || phaseRef.current !== 'open') {
      appearedRef.current = false;
      setPhaseBoth('closed');
      setSettled(false);
      setExpanded(false);
    }
    onChangeRef.current?.(-1, 0, 0 as never);
    onDismissRef.current?.();
  }, [setPhaseBoth]);

  const dismiss = React.useCallback(() => {
    if (phaseRef.current !== 'open') return;
    if (!appearedRef.current) {
      phaseRef.current = 'closing';
      finish(false);
      return;
    }
    setPhaseBoth('closing');
  }, [finish, setPhaseBoth]);

  React.useImperativeHandle(
    ref,
    () =>
      ({
        present: (next?: unknown) => {
          // A sheet is a new context: a keyboard left up from the screen
          // behind would cover it (the gorhom path does the same).
          RN.Keyboard.dismiss();
          setData(next);
          if (phaseRef.current === 'open') return;
          setExpanded(false);
          setDetentAt(initialIndex);
          setPhaseBoth('open');
        },
        dismiss,
        close: dismiss,
        forceClose: dismiss,
        snapToIndex: (to: number) => {
          if (to < 0) dismiss();
          else {
            easeDetentChange({ expanded: false, detentAt: to });
            setExpanded(false);
            setDetentAt(to);
          }
        },
        snapToPosition: (position: string | number) => {
          const full = typeof position === 'string' ? position.trim() === '100%' : position >= maxHeight;
          if (full) {
            easeDetentChange({ expanded: true, detentAt: layoutRef.current.detentAt });
            setExpanded(true);
          }
        },
        expand: () => {
          easeDetentChange({ expanded: true, detentAt: layoutRef.current.detentAt });
          setExpanded(true);
        },
        collapse: () => {
          easeDetentChange({ expanded: false, detentAt: layoutRef.current.detentAt });
          setExpanded(false);
        },
      }) as unknown as BottomSheetModal,
    [dismiss, maxHeight, setPhaseBoth, initialIndex, easeDetentChange]
  );

  const footerPosition = useSharedValue(0);
  const { colorScheme } = useColorScheme();

  const explicitBackground = (RN.StyleSheet.flatten(backgroundStyle) as ViewStyle | undefined)?.backgroundColor as
    | string
    | undefined;
  const background = explicitBackground ?? (SYSTEM_SHEET_GLASS ? undefined : getSheetBg(colorScheme === 'dark'));
  const api = React.useMemo<NativeSheetApi>(() => ({ dismiss, surface: background ?? null }), [dismiss, background]);
  // A content-sized detent is measured above the home indicator: UIKit puts
  // the bottom safe area under the content (\`RNSFormSheetDetentResolver.mm\`,
  // a custom detent). A body that pads \`insets.bottom\` would pad it twice, so
  // inside a content-sized sheet the bottom inset reads 0. A fixed-detent
  // sheet's content reaches the screen edge and keeps the real inset.
  const contentInsets = React.useMemo(() => ({ ...insets, bottom: 0 }), [insets]);

  if (!FormSheet || phase === 'closed') return null;

  const Footer = footerComponent;
  // A content-sized sheet is as tall as this box: capped at the maximum detent
  // (so a long body scrolls instead of running off the sheet), and held at it
  // while expanded.
  const cap = Math.min(maxHeight, maxDynamicContentSize ?? Number.POSITIVE_INFINITY);
  const boxStyle: ViewStyle = fit ? { maxHeight: cap, minHeight: expanded ? cap : undefined } : styles.fill;
  const body = (
    typeof children === 'function' ? (children as (props: { data?: unknown }) => React.ReactNode)({ data }) : children
  ) as React.ReactNode;

  return (
    <FormSheet
      isOpen={phase === 'open'}
      detents={detents}
      initialDetentIndex={fit ? 0 : Math.min(initialIndex, (detents as number[]).length - 1)}
      prefersGrabberVisible
      preferredCornerRadius="systemDefault"
      preventNativeDismiss={enablePanDownToClose === false}
      prefersScrollingExpandsWhenScrolledToEdge={enableContentPanningGesture !== false}
      nativeContainerStyle={background ? { backgroundColor: background } : undefined}
      onWillAppear={() => {
        appearedRef.current = true;
      }}
      onDidAppear={() => {
        setSettled(true);
        onChangeRef.current?.(fit ? 0 : initialIndex, 0, 0 as never);
      }}
      onDetentChanged={(event) => {
        const at = event.nativeEvent.index;
        // While expanded a fixed-detent sheet lists only the full detent.
        const reported = !fit && expanded ? (baseDetents as number[]).length - 1 : at;
        easeDetentChange({ expanded, detentAt: reported });
        setDetentAt(reported);
        onChangeRef.current?.(reported, 0, 0 as never);
      }}
      onDismiss={() => finish(false)}
      onNativeDismiss={() => finish(true)}>
      <NativeSheetContext.Provider value={api}>
        <SurfaceContext.Provider value="sheet">
          <SheetSettledContext.Provider value={settled}>
            {/* A sheet opened from inside another sheet's `SheetFill` must not inherit its shift. */}
            <PinnedBarShiftContext.Provider value={null}>
             <ScreenInsetsContext.Provider value={insets}>
             <SafeAreaInsetsContext.Provider value={fit ? contentInsets : insets}>
              {/* A fixed-detent sheet can stand at full height, where UIKit
                  does not move it for the keyboard: the box shrinks above the
                  keyboard instead, so a Save row under a scrolling form stays
                  reachable. A content-sized sheet is lifted by UIKit itself. */}
              <SheetBox
                fit={fit}
                avoid={!fit && (expanded || detentAt === (baseDetents as number[]).length - 1)}
                fraction={fit || expanded ? 1 : ((baseDetents as number[])[detentAt] ?? 1)}
                maxHeight={maxHeight}
                bottomInset={insets.bottom}
                windowHeight={windowHeight}
                style={boxStyle}>
                {header}
                {body}
                {/* gorhom renders `footerComponent` as a component, so does this. */}
                {Footer ? <Footer animatedFooterPosition={footerPosition} /> : null}
              </SheetBox>
             </SafeAreaInsetsContext.Provider>
             </ScreenInsetsContext.Provider>
            </PinnedBarShiftContext.Provider>
          </SheetSettledContext.Provider>
        </SurfaceContext.Provider>
      </NativeSheetContext.Provider>
    </FormSheet>
  );
});

const styles = { fill: { flex: 1 } } satisfies Record<string, ViewStyle>;

/** 200 ms ease-out: the content's end moving to a new detent (SHEET_MOTION's close length, shortened for a settle). */
const DETENT_LAYOUT = { duration: 200, update: { type: 'easeOut' as const } };

/** The screen's real safe-area insets, carried past a content-sized sheet's bottom-0 override. */
const ScreenInsetsContext = React.createContext<ReturnType<typeof useSafeAreaInsets> | null>(null);

/** Loaded on the first fixed-detent native sheet only (the app root's `KeyboardProvider` has loaded the package on iOS). */
let keyboardAvoidingView: typeof import('react-native-keyboard-controller').KeyboardAvoidingView | null = null;

/**
 * The sheet's content box. At the full detent the box shrinks above the
 * keyboard: UIKit cannot raise a full-height sheet, so the keyboard would
 * cover its bottom (a Save row under a form). The box's frame is relative to
 * the sheet (y 0), so the offset is the sheet's top on screen,
 * `windowHeight − boxHeight`, and the padding comes out as the keyboard's
 * overlap with the box. Below the full detent UIKit lifts the sheet itself, so
 * the avoider is off there (`enabled`) and never pads twice. A content-sized
 * sheet is lifted by UIKit too and keeps a plain View.
 *
 * At a partial detent the box can keep the full detent's height while only
 * its top is on screen (`nativeSheetHiddenBottom`). The content then ends that
 * much above the box's bottom, so `flex: 1`, a `PinnedBar` and a list's last
 * row end at the visible edge, as in gorhom's `SheetFill`. Without it the
 * picker's Agent · Model tabs sat below the screen on iOS.
 */
function SheetBox({
  fit,
  avoid,
  fraction,
  maxHeight,
  bottomInset,
  windowHeight,
  style,
  children,
}: {
  fit: boolean;
  avoid: boolean;
  /** The detent the sheet rests at, as a fraction of the maximum detent. */
  fraction: number;
  maxHeight: number;
  bottomInset: number;
  windowHeight: number;
  style: ViewStyle;
  children: React.ReactNode;
}) {
  const [boxHeight, setBoxHeight] = React.useState<number | null>(null);
  // One element type per sheet (a detent change must not remount the form):
  // a fixed-detent sheet always renders the avoider and switches it with `enabled`.
  if (fit) return <RN.View style={style}>{children}</RN.View>;
  keyboardAvoidingView ??= (require('react-native-keyboard-controller') as typeof import('react-native-keyboard-controller'))
    .KeyboardAvoidingView;
  const Avoiding = keyboardAvoidingView;
  const hidden = nativeSheetHiddenBottom({ boxHeight: boxHeight ?? 0, fraction, maxHeight, bottomInset });
  return (
    <Avoiding
      behavior="padding"
      enabled={avoid}
      keyboardVerticalOffset={boxHeight === null ? 0 : Math.max(0, windowHeight - boxHeight)}
      onLayout={(e) => setBoxHeight(e.nativeEvent.layout.height)}
      style={style}>
      <RN.View style={[styles.fill, { marginBottom: hidden }]}>{children}</RN.View>
    </Avoiding>
  );
}
