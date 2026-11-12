/**
 * sheet-parts — the content parts of a bottom sheet, for both sheet engines.
 *
 * `KortixBottomSheetModal` renders the iOS native sheet where the binary has
 * it (`native-sheet.tsx`) and gorhom everywhere else (Android, an OTA on an
 * old iOS build). gorhom's own parts read gorhom's internal context: inside a
 * native sheet `BottomSheetScrollView`, `BottomSheetView`,
 * `BottomSheetTextInput`, `BottomSheetFlatList` and `BottomSheetFooter` throw
 * ("'useBottomSheetInternal' cannot be used out of the BottomSheet"). Every
 * part here renders the gorhom part inside a gorhom sheet and the plain React
 * Native part inside a native sheet (`NativeSheetContext`).
 *
 * Import content parts from here, never from `@gorhom/bottom-sheet`
 * (`sheet-imports.test.ts` enforces it outside `components/kortix/`). The
 * props are gorhom's, so a migrated call site keeps its props.
 *
 * Inside a native sheet:
 * - `SheetScrollView` is `KeyboardAwareScrollView`
 *   (`react-native-keyboard-controller`, `mode="insets"`: no re-layout). A
 *   native sheet does not lift its content for the keyboard; at the full
 *   detent the keyboard covers its lower part. The scroll view scrolls a
 *   focused field above the keyboard, measured in window coordinates, so it
 *   does nothing when UIKit already moved a smaller sheet above the keyboard.
 * - `SheetView`, `SheetFlatList`, `SheetRawTextInput` are React Native's
 *   `View`, `FlatList`, `TextInput`.
 * - `SheetFooter` is a `View` pinned to the bottom edge of the sheet's content.
 */
import * as React from 'react';
// Namespace imports: a component test that mocks `react-native` or gorhom with
// only the names its own graph uses still loads this module (a named import
// of a missing export is a link error). Every name below exists in the real
// packages; `pnpm typecheck` checks them.
import * as RN from 'react-native';
import * as Gorhom from '@gorhom/bottom-sheet';
import type { BottomSheetFooterProps } from '@gorhom/bottom-sheet';
import type { KeyboardAwareScrollView as KeyboardAwareScrollViewType } from 'react-native-keyboard-controller';

import { useNativeSheet } from './native-sheet-context';

/** The system blur, only where the binary has it (an OTA can reach an older build). Native sheets are iOS-only. */
const FOOTER_BLUR: typeof import('expo-blur').BlurView | null = (() => {
  if (RN.Platform?.OS !== 'ios') return null;
  try {
    const { requireOptionalNativeModule } = require('expo') as typeof import('expo');
    return requireOptionalNativeModule('ExpoBlur') != null ? (require('expo-blur') as typeof import('expo-blur')).BlurView : null;
  } catch {
    return null;
  }
})();

/**
 * Loaded on the first native-sheet scroll view only: the gorhom path (Android,
 * the OTA fallback, every bun test of a sheet) never loads it. The app root's
 * `KeyboardProvider` has loaded the package already on iOS.
 */
/** The keyboard's height the last time it was open: the inset to cancel before the next show's event arrives. */
let lastOpenKeyboardHeight = 0;
let keyboardModule: typeof import('react-native-keyboard-controller') | null = null;
function keyboardController(): typeof import('react-native-keyboard-controller') {
  keyboardModule ??= require('react-native-keyboard-controller') as typeof import('react-native-keyboard-controller');
  return keyboardModule;
}

type ScrollProps = React.ComponentProps<typeof Gorhom.BottomSheetScrollView>;
type ViewProps = React.ComponentProps<typeof Gorhom.BottomSheetView>;
type TextInputProps = React.ComponentProps<typeof Gorhom.BottomSheetTextInput>;

/** Space between a focused field and the keyboard inside a native sheet. */
const KEYBOARD_GAP = 16;

/** gorhom-only scroll props: no meaning on a plain React Native scroll view. */
function withoutGorhomScrollProps<P extends object>(props: P): P {
  const {
    focusHook: _focusHook,
    scrollEventsHandlersHook: _scrollEventsHandlersHook,
    enableFooterMarginAdjustment: _enableFooterMarginAdjustment,
    ...rest
  } = props as P & { focusHook?: unknown; scrollEventsHandlersHook?: unknown; enableFooterMarginAdjustment?: unknown };
  return rest as P;
}

/**
 * The native sheet's scroll view. It scrolls a focused field above the
 * keyboard (window coordinates). The keyboard never overlaps it: below the
 * full detent UIKit lifts the sheet above the keyboard, and at the full detent
 * the sheet's box shrinks above it (`SheetBox`, `native-sheet.tsx`). So its
 * keyboard inset is always cancelled (`extraKeyboardSpace` −height): one layer
 * owns the keyboard's space, never two, and the value does not change with the
 * detent (keyboard-controller caches the inset until the next keyboard event).
 * The height comes from the JS `keyboardWillShow` event; the last open height
 * is the fallback, so only the first keyboard show can carry a keyboard-height
 * scroll tail for its ~250 ms animation.
 */
const NativeScrollView = React.forwardRef<React.ComponentRef<typeof Gorhom.BottomSheetScrollView>, ScrollProps>(
  (props, ref) => {
    const keyboard = keyboardController();
    const liveHeight = keyboard.useKeyboardState((state) => state.height);
    if (liveHeight > 0) lastOpenKeyboardHeight = liveHeight;
    const keyboardHeight = liveHeight > 0 ? liveHeight : lastOpenKeyboardHeight;
    const Scroll = keyboard.KeyboardAwareScrollView;
    return (
      <Scroll
        bottomOffset={KEYBOARD_GAP}
        {...(withoutGorhomScrollProps(props) as React.ComponentProps<typeof KeyboardAwareScrollViewType>)}
        extraKeyboardSpace={-keyboardHeight}
        ref={ref as never}
      />
    );
  }
);
NativeScrollView.displayName = 'NativeScrollView';

/** gorhom's `BottomSheetScrollView`; `KeyboardAwareScrollView` in a native sheet. */
export const SheetScrollView = React.forwardRef<React.ComponentRef<typeof Gorhom.BottomSheetScrollView>, ScrollProps>(
  (props, ref) => {
    const native = useNativeSheet();
    if (native) return <NativeScrollView {...props} ref={ref} />;
    return <Gorhom.BottomSheetScrollView {...props} ref={ref} />;
  }
);
SheetScrollView.displayName = 'SheetScrollView';

/** gorhom's `BottomSheetView` (it measures a content-sized sheet); `View` in a native sheet. */
export function SheetView(props: ViewProps) {
  const native = useNativeSheet();
  if (native) {
    const { focusHook: _focusHook, ...rest } = props as ViewProps & { focusHook?: unknown };
    return <RN.View {...rest} />;
  }
  return <Gorhom.BottomSheetView {...props} />;
}

/** gorhom's `BottomSheetFlatList`; `FlatList` in a native sheet. */
export function SheetFlatList<T>(props: React.ComponentProps<typeof Gorhom.BottomSheetFlatList<T>>) {
  const native = useNativeSheet();
  if (native) {
    return <RN.FlatList<T> {...(withoutGorhomScrollProps(props) as React.ComponentProps<typeof RN.FlatList<T>>)} />;
  }
  return <Gorhom.BottomSheetFlatList<T> {...props} />;
}

/**
 * gorhom's `BottomSheetTextInput` (gorhom lifts the sheet only for a focused
 * input it registered); `TextInput` in a native sheet. The raw field: the
 * styled pill for a sheet is `SheetTextInput` (`SheetInput.tsx`).
 */
export const SheetRawTextInput = React.forwardRef<React.ComponentRef<typeof RN.TextInput>, TextInputProps>(
  (props, ref) => {
    const native = useNativeSheet();
    if (native) return <RN.TextInput {...props} ref={ref} />;
    return <Gorhom.BottomSheetTextInput {...props} ref={ref as never} />;
  }
);
SheetRawTextInput.displayName = 'SheetRawTextInput';

export type SheetFooterProps = BottomSheetFooterProps;

/**
 * gorhom's `BottomSheetFooter` (a `footerComponent` root); in a native sheet a
 * `View` on the bottom edge of the sheet's content. The native sheet passes
 * the same `footerProps` shape to `footerComponent`.
 */
export function SheetFooter(props: React.ComponentProps<typeof Gorhom.BottomSheetFooter>) {
  const native = useNativeSheet();
  if (native) {
    // On the iOS 26 glass the footer has no sheet colour to paint, and the
    // body scrolls under it: a system material keeps its buttons legible over
    // the content, as UIKit's own sheet toolbars do.
    const material = native.surface === null && FOOTER_BLUR ? (
      <FOOTER_BLUR tint="systemMaterial" intensity={100} style={RN.StyleSheet.absoluteFill} />
    ) : null;
    return (
      <RN.View pointerEvents="box-none" style={[{ position: 'absolute', left: 0, right: 0, bottom: 0 }, props.style]}>
        {material}
        {props.children}
      </RN.View>
    );
  }
  return <Gorhom.BottomSheetFooter {...props} />;
}

/**
 * gorhom's touchable: React Native's `TouchableOpacity` on iOS, the gesture
 * handler's on Android (it wins over a sheet's pan there). Reads no sheet
 * context, so it works in both engines.
 */
export const SheetTouchableOpacity = Gorhom.TouchableOpacity;

/** True inside any bottom sheet: a native one or a gorhom one. */
export function useInSheet(): boolean {
  const native = useNativeSheet();
  const gorhom = Gorhom.useBottomSheetInternal(true);
  return native !== null || gorhom !== null;
}

/**
 * Dismisses the sheet this subtree renders in: the native sheet, or the
 * top-most gorhom modal (gorhom's `useBottomSheetModal().dismiss()`).
 */
export function useSheetDismiss(): () => void {
  const native = useNativeSheet();
  const { dismiss } = Gorhom.useBottomSheetModal();
  return React.useCallback(() => {
    if (native) native.dismiss();
    else dismiss();
  }, [native, dismiss]);
}
