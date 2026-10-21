import * as React from 'react';
import { Image, View, type ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { cn } from '@/lib/utils';

/**
 * KortixLoader - The Dosco loading animation.
 *
 * The brand crest (the red diamond) breathing gently — in place of the old
 * Kortix eclipse-ring Lottie. Reduced Motion holds the mark at full opacity.
 *
 * The mark is theme-invariant (it reads on both surfaces), so there is no
 * ink recoloring and no `forceTheme` prop (that prop existed for the white /
 * black Lottie; removed with it). Deterministic on every renderer: no
 * animation library beyond Reanimated on the UI thread.
 */

interface KortixLoaderProps {
  /**
   * Size preset. `small` is the loader everywhere: lists, pages, sheets,
   * previews, buttons. `large` is the boot screens only (it matches the 200 pt
   * native splash mark scaled down); `medium` is the session-wake screen only
   * (`SessionConnecting`). `kortix-loader-size.test.ts` enforces this (KRTX-559).
   * @default 'small'
   */
  size?: 'small' | 'medium' | 'large';
  /**
   * Custom size in pixels (overrides size preset)
   */
  customSize?: number;
  /**
   * Additional className for the container
   */
  className?: string;
  /**
   * Additional style for the container
   */
  style?: ViewStyle;
}

const SIZE_MAP = {
  small: 20,
  medium: 40,
  large: 80,
} as const;

// The baked crest (`scripts/bake-brand-assets.mjs`: a 480 px downscale of the
// trimmed full-resolution crest). `size` / `customSize` name the mark's
// WIDTH; the height follows the baked crest's aspect (dosco-crest-ratio.txt).
const CREST_SOURCE = require('@/assets/brand/dosco-crest-loader.png');
const CREST_ASPECT = 1.6276;

const PULSE_MS = 950;

export function KortixLoader({
  size = 'small',
  customSize,
  className,
  style,
}: KortixLoaderProps) {
  const width = customSize || SIZE_MAP[size];
  const reducedMotion = useReducedMotion();
  // Breathe: 0.35 → 1 and back (reversed repeat from the resting dim value).
  const opacity = useSharedValue(reducedMotion ? 1 : 0.35);

  React.useEffect(() => {
    if (reducedMotion) {
      cancelAnimation(opacity);
      opacity.value = 1;
      return;
    }
    opacity.value = withRepeat(
      withTiming(1, { duration: PULSE_MS, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
    return () => cancelAnimation(opacity);
  }, [reducedMotion, opacity]);
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  return (
    <View
      className={cn('items-center justify-center', className)}
      style={[{ width, height: width / CREST_ASPECT }, style]}>
      <Animated.Image
        source={CREST_SOURCE}
        resizeMode="contain"
        style={[{ width: '100%', height: '100%' }, animatedStyle]}
      />
    </View>
  );
}
