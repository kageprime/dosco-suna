/**
 * FadeEdges — a scroll view's content fading out at its top and bottom edges,
 * by an alpha mask (the workspace switcher's list; Jay, 2026-11-11).
 *
 * A mask, not a gradient painted over the content: inside an iOS 26 native
 * sheet the surface is the system glass, with no colour to fade to, and a
 * gradient in the sheet colour drew an opaque band over it. A mask fades the
 * rows themselves, so it reads the same on glass, on the sheet colour and on a
 * page. Pad the scroll content by at least the edge size, so the first and
 * last rows can rest outside the fade.
 *
 * The mask view (`@react-native-masked-view/masked-view`) is required, not
 * imported: bun tests cannot load it. Where it fails to load, the children
 * render unmasked.
 */
import * as React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

type MaskedViewType = React.ComponentType<{ maskElement: React.ReactElement; style?: ViewStyle; children: React.ReactNode }>;

let maskedView: MaskedViewType | null | undefined;
function loadMaskedView(): MaskedViewType | null {
  if (maskedView !== undefined) return maskedView;
  try {
    maskedView = (require('@react-native-masked-view/masked-view') as { default: MaskedViewType }).default;
  } catch {
    maskedView = null;
  }
  return maskedView;
}

/** Only the mask's alpha counts: opaque shows the content, clear hides it. */
const OPAQUE = 'black';
const CLEAR = 'rgba(0,0,0,0)'; // hex-allowlist: mask alpha only (black at 0 alpha), never drawn as a colour

export function FadeEdges({
  top = 16,
  bottom = 24,
  style,
  children,
}: {
  /** Height of the top fade, in points. */
  top?: number;
  /** Height of the bottom fade, in points. */
  bottom?: number;
  style?: ViewStyle;
  children: React.ReactNode;
}) {
  const Masked = loadMaskedView();
  if (!Masked) return <View style={[{ flex: 1 }, style]}>{children}</View>;
  return (
    <Masked
      style={[{ flex: 1 }, style] as unknown as ViewStyle}
      maskElement={
        <View style={StyleSheet.absoluteFill}>
          <LinearGradient colors={[CLEAR, OPAQUE]} style={{ height: top }} />
          <View style={{ flex: 1, backgroundColor: OPAQUE }} />
          <LinearGradient colors={[OPAQUE, CLEAR]} style={{ height: bottom }} />
        </View>
      }>
      {children}
    </Masked>
  );
}
