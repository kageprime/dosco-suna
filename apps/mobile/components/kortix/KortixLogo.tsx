import * as React from 'react';
import { Image, View, type ViewProps, type ViewStyle } from 'react-native';

// Baked by scripts/bake-brand-assets.mjs from the dosco-brand sources:
// the full-colour crest (theme-invariant — chrome + red read on both
// surfaces) for the symbol, and the alpha silhouettes of the wordmark for
// the wide marks. Fitted with `contain`, so the exact pixel ratio only
// letterboxes transparent padding.
const CrestSquare = require('@/assets/brand/dosco-crest-square.png');
const WordmarkDark = require('@/assets/brand/dosco-wordmark-dark.png');
const WordmarkLight = require('@/assets/brand/dosco-wordmark-light.png');

interface KortixLogoProps extends Omit<ViewProps, 'style'> {
  size?: number;
  variant?: 'symbol' | 'logomark' | 'text';
  className?: string;
  style?: ViewStyle;
  color?: 'light' | 'dark';
}

// One row per variant × surface: the image to render (baked PNG) and its
// aspect ratio (`size` is the height; the wide marks scale `size` by it, the
// symbol is square). `color` names the SURFACE (`dark` = it sits on a dark
// background), not the ink.
const LOGOS: Record<'symbol' | 'logomark' | 'text', Record<'light' | 'dark', { logo: number; ratio: number }>> = {
  symbol: {
    light: { logo: CrestSquare, ratio: 1 },
    dark: { logo: CrestSquare, ratio: 1 },
  },
  logomark: {
    // 1600×342 — the wordmark silhouette baked from the brand lockup.
    light: { logo: WordmarkDark, ratio: 1600 / 342 },
    dark: { logo: WordmarkLight, ratio: 1600 / 342 },
  },
  text: {
    light: { logo: WordmarkDark, ratio: 1600 / 342 },
    dark: { logo: WordmarkLight, ratio: 1600 / 342 },
  },
};

export function KortixLogo({
  size = 24,
  variant = 'symbol',
  className,
  style,
  color = 'dark',
  ...props
}: KortixLogoProps) {
  const { logo: source, ratio } = LOGOS[variant][color];
  const width = size * ratio;
  const containerStyle: ViewStyle = { width, height: size, flexShrink: 0, ...style };
  return (
    <View className={className} style={containerStyle} {...props}>
      <Image source={source} style={{ width, height: size }} resizeMode="contain" />
    </View>
  );
}
