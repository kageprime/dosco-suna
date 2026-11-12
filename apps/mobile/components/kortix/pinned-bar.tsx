/**
 * PinnedBar — controls pinned to the bottom of a scrolling region, floating over
 * a fade of the surface behind them. The project drawer's bottom bar (New
 * session · avatar) as a component, same values (Jay, 2026-09-22):
 *
 * - the content fills the whole height and scrolls under the bar
 * - the controls sit `PINNED_BAR_BOTTOM_GAP` above the safe-area edge
 * - the fade starts `PINNED_BAR_FADE_ABOVE` over the controls and reaches the
 *   edge: clear → 85% at 45% → solid. It takes no touches, and the transparent
 *   top of the bar passes touches to the content under it (`box-none`)
 * - the content pads its end by `usePinnedBarInset(controlHeight)`, so its last
 *   row rests `PINNED_BAR_CONTENT_GAP` above the controls
 *
 * `background` is the surface the bar sits on; the fade ends on it. Never fade
 * to `transparent` (black at zero alpha: a grey band on Android).
 *
 * `blur` (iOS, where the binary has `ExpoBlur`) adds a progressive blur under
 * the fade: the system blur masked clear → full from the top of the bar
 * down, so the rows sliding under the controls soften before they fade (the
 * Claude iOS sidebar; Jay, 2026-11-11). The fade is lighter over the blur.
 * Android and older binaries keep the plain fade.
 */
import * as React from 'react';
import { Platform, StyleSheet, View, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { withAlpha } from '@/lib/utils/theme';
import { cn } from '@/lib/utils/utils';
import { useNativeSheet } from '@/components/kortix/native-sheet-context';

type MaskedViewType = React.ComponentType<{
  maskElement: React.ReactElement;
  pointerEvents?: 'none';
  style?: ViewStyle;
  children: React.ReactNode;
}>;

/**
 * The system blur and its mask, only on iOS where the binary has `ExpoBlur`
 * (an OTA can reach an older build). Required here, not imported: the
 * Android path and bun tests never load them.
 */
const BLUR: { BlurView: typeof import('expo-blur').BlurView; MaskedView: MaskedViewType } | null = (() => {
  if (Platform?.OS !== 'ios') return null;
  try {
    const { requireOptionalNativeModule } = require('expo') as typeof import('expo');
    if (requireOptionalNativeModule('ExpoBlur') == null) return null;
    return {
      BlurView: (require('expo-blur') as typeof import('expo-blur')).BlurView,
      MaskedView: (require('@react-native-masked-view/masked-view') as { default: unknown }).default as MaskedViewType,
    };
  } catch {
    return null;
  }
})();

/** Gap between the controls and the safe-area edge. */
export const PINNED_BAR_BOTTOM_GAP = 16;
/** How far the fade reaches above the controls. */
const PINNED_BAR_FADE_ABOVE = 36;
/** How far the progressive blur reaches above the controls (`blur`). */
const PINNED_BAR_BLUR_ABOVE = 64;
/** Space between the content's last row and the controls. */
const PINNED_BAR_CONTENT_GAP = 16;

/** Bottom padding for the content under a `PinnedBar` with controls this tall. */
export function usePinnedBarInset(controlHeight: number, bottomGap: number = PINNED_BAR_BOTTOM_GAP): number {
  const insets = useSafeAreaInsets();
  return insets.bottom + bottomGap + controlHeight + PINNED_BAR_CONTENT_GAP;
}

interface PinnedBarProps {
  /** Height of the tallest control: 40 for `Button` default, 44 for `lg`. */
  controlHeight: number;
  /** The surface colour under the bar. */
  background: string;
  /** Layout of the controls row, e.g. `gap-2 px-4`. */
  className?: string;
  /**
   * Draw the fade behind the controls. Default true. `false` floats the
   * controls straight over the content (the Browser toolbar: its capsules are
   * opaque, the site shows to the edge; Jay, 2026-09-23).
   */
  fade?: boolean;
  /** A progressive blur under the fade (iOS). See the file comment. */
  blur?: boolean;
  /** The blur's tint: the app's theme. */
  dark?: boolean;
  /** Space between the controls and the safe-area edge. Default `PINNED_BAR_BOTTOM_GAP` (16). Pass the same value to `usePinnedBarInset`. */
  bottomGap?: number;
  children: React.ReactNode;
}

/**
 * How far a `PinnedBar` moves up to sit on the visible sheet edge, in points
 * (0 or less). `SheetFill` (`sheet.tsx`) provides it: while a sheet moves, its
 * body keeps one laid-out height and the bar follows the edge by this
 * transform, not by a new layout on each frame. No provider: the bar does not move.
 */
export const PinnedBarShiftContext = React.createContext<SharedValue<number> | null>(null);

/** The bar's root, moved by `shift` on the UI thread. Same props as the plain root. */
function ShiftedRoot({ shift, style, children }: { shift: SharedValue<number>; style: ViewStyle; children: React.ReactNode }) {
  const shifted = useAnimatedStyle(() => ({ transform: [{ translateY: shift.get() }] }), [shift]);
  return (
    <Animated.View pointerEvents="box-none" className="absolute inset-x-0 bottom-0" style={[style, shifted]}>
      {children}
    </Animated.View>
  );
}

export function PinnedBar({ controlHeight, background, className, fade: fadeProp = true, blur = false, dark = false, bottomGap = PINNED_BAR_BOTTOM_GAP, children }: PinnedBarProps) {
  const insets = useSafeAreaInsets();
  // On the iOS 26 native sheet glass there is no colour to fade to: a fade in
  // the popover colour would draw an opaque band over the glass.
  const nativeSheet = useNativeSheet();
  const fade = fadeProp && !(nativeSheet && nativeSheet.surface === null);
  const shift = React.useContext(PinnedBarShiftContext);
  const barBottom = insets.bottom + bottomGap;
  const blurred = blur && fade && BLUR != null;
  // The blur starts higher than the fade: rows soften before they fade.
  const rootStyle = { height: barBottom + controlHeight + (blurred ? PINNED_BAR_BLUR_ABOVE : PINNED_BAR_FADE_ABOVE) };

  const content = (
    <>
      {blurred && BLUR ? (
        <BLUR.MaskedView
          pointerEvents="none"
          style={StyleSheet.absoluteFill}
          maskElement={
            <LinearGradient
              // Only the mask's alpha counts: clear at the top, full blur from 55% down.
              colors={[withAlpha(background, 0), withAlpha(background, 1), withAlpha(background, 1)]}
              locations={[0, 0.55, 1]}
              style={StyleSheet.absoluteFill}
            />
          }>
          <BLUR.BlurView intensity={24} tint={dark ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />
        </BLUR.MaskedView>
      ) : null}
      {fade ? (
        <LinearGradient
          pointerEvents="none"
          colors={
            blurred
              ? [withAlpha(background, 0), withAlpha(background, 0.5), withAlpha(background, 0.92)]
              : [withAlpha(background, 0), withAlpha(background, 0.85), withAlpha(background, 1)]
          }
          locations={[0, 0.45, 1]}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      <View
        pointerEvents="box-none"
        className={cn('absolute inset-x-0 flex-row items-center', className)}
        style={{ bottom: barBottom }}>
        {children}
      </View>
    </>
  );

  if (shift) {
    return (
      <ShiftedRoot shift={shift} style={rootStyle}>
        {content}
      </ShiftedRoot>
    );
  }
  return (
    <View pointerEvents="box-none" className="absolute inset-x-0 bottom-0" style={rootStyle}>
      {content}
    </View>
  );
}
