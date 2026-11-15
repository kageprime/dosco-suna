/**
 * DrawerPeekCard — the project page as a card while the project drawer opens
 * (the Claude / ChatGPT iOS sidebar; Jay, 2026-11-11). It wraps the
 * `Drawer`'s children in `ProjectScreen`.
 *
 * `react-native-drawer-layout` (`drawerType="back"`) keeps the sidebar still
 * and moves the page over it by the drawer width (Jay, 2026-11-15: with
 * "slide" the sidebar and page moved as one flat sheet). This card adds,
 * from the drawer's progress on the UI thread (`peekCardFrame`,
 * `lib/ui/drawer-layout.ts`):
 * - corner radius 44pt (iOS) / 28pt (Android), the display corners, reached
 *   in the first eighth of the travel (0 at rest)
 * - a veil of the page's own colour, 0 → 50%: the content fades toward the
 *   surface, so the card stays light beside the sidebar (never an ink dim,
 *   which turned it grey)
 * - a hairline edge in the border token, and a faint shadow: the card reads
 *   against the sidebar without a dark band.
 * The card keeps its full size: a scaled card left a gap beside the sidebar.
 *
 * Two layers: the outer view casts the shadow (a clipping view cannot) with a
 * fixed radius and shadow, so it is drawn once, never per frame. The inner
 * view clips the page to the animated radius and holds the veil and the edge.
 * The drawer's own overlay (transparent, `ProjectScreen`) lies over the card
 * and closes the drawer on a tap on the peek strip.
 */
import * as React from 'react';
import { Platform, StyleSheet } from 'react-native';
import { useDrawerProgress } from 'react-native-drawer-layout';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useColorScheme } from 'nativewind';

import { PEEK_CARD_RADIUS, SIDEBAR_DIM, peekCardFrame, sidebarDim } from '@/lib/ui/drawer-layout';
import { THEME, withAlpha } from '@/lib/utils/theme';

const RADIUS = Platform.OS === 'ios' ? PEEK_CARD_RADIUS.ios : PEEK_CARD_RADIUS.android;

export function DrawerPeekCard({ children }: { children: React.ReactNode }) {
  const progress = useDrawerProgress();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  // The page surface: the card's own fill, so the rounded corners never show
  // a transparent screen while the page under it draws nothing yet.
  const surface = isDark ? THEME.dark.background : THEME.light.background;
  const edge = isDark ? THEME.dark.border : THEME.light.border;
  // A faint lift, not a band: the light theme's ink both ways.
  const shadow = `0px 0px 12px 0px ${withAlpha(THEME.light.foreground, isDark ? 0.3 : 0.06)}`;

  const clipStyle = useAnimatedStyle(() => ({
    borderRadius: peekCardFrame(progress.value, RADIUS).borderRadius,
  }));
  const veilStyle = useAnimatedStyle(() => ({
    opacity: peekCardFrame(progress.value, RADIUS).veil,
  }));
  // The edge appears as soon as the card moves (a closed page has no edge).
  const edgeStyle = useAnimatedStyle(() => {
    const frame = peekCardFrame(progress.value, RADIUS);
    return { borderRadius: frame.borderRadius, opacity: Math.min(1, progress.value * 4) };
  });

  return (
    <Animated.View style={[styles.card, { boxShadow: shadow }]}>
      <Animated.View style={[styles.clip, { backgroundColor: surface }, clipStyle]}>
        {children}
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: surface }, veilStyle]} />
      </Animated.View>
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { borderWidth: StyleSheet.hairlineWidth, borderColor: edge }, edgeStyle]}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // No fill: the corners outside the clip show the sidebar surface.
  card: { flex: 1, borderRadius: RADIUS },
  clip: { flex: 1, overflow: 'hidden' },
  sidebar: { flex: 1 },
  // hex-allowlist: pure black (#000), a dim not a colour; its alpha is SIDEBAR_DIM.
  dim: { backgroundColor: '#000' },
});

/**
 * DrawerSidebarDim — the sidebar under the card (Claude iOS). It wraps the
 * drawer content in `ProjectScreen`. A black layer over the sidebar fades
 * from `SIDEBAR_DIM` (card fully over it) to 0 (drawer open), so the sidebar
 * reads as the layer BEHIND the page. It takes no touches, and it is
 * transparent whenever the drawer is open, so the sidebar is never dimmed
 * while someone uses it.
 */
export function DrawerSidebarDim({ children }: { children: React.ReactNode }) {
  const progress = useDrawerProgress();
  const { colorScheme } = useColorScheme();
  const max = colorScheme === 'dark' ? SIDEBAR_DIM.dark : SIDEBAR_DIM.light;
  // No dependency array: on native, Reanimated tracks the closure (`max`) itself.
  const dimStyle = useAnimatedStyle(() => ({ opacity: sidebarDim(progress.value, max) }));

  return (
    <Animated.View style={styles.sidebar}>
      {children}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.dim, dimStyle]} />
    </Animated.View>
  );
}

/** The surface behind the card: the sidebar's own, so the card's corners show it. */
export function useDrawerBackdropColor(): string {
  const { colorScheme } = useColorScheme();
  return colorScheme === 'dark' ? THEME.dark.chromeBackground : THEME.light.chromeBackground;
}
