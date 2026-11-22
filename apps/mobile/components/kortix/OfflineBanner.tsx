/**
 * Global connectivity banner. Slides down from the top when the backend is
 * unreachable ("No internet connection") and briefly flashes a green
 * "Back online" when it recovers, then slides away. Overlay-positioned so it
 * never disturbs the navigator layout; non-interactive (taps pass through).
 */

import { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { WifiSlashIcon as WifiOff, WifiHighIcon as Wifi } from '@/lib/icons';
import { Text } from '@/components/ui/text';
import { THEME, withAlpha } from '@/lib/utils/theme';
import { useOnlineStatus } from '@/lib/network/use-online-status';

type Mode = 'hidden' | 'offline' | 'reconnected';

export function OfflineBanner() {
  const online = useOnlineStatus();
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const [mode, setMode] = useState<Mode>('hidden');
  const wasOffline = useRef(false);
  const translateY = useRef(new Animated.Value(-160)).current;

  // Drive the banner state from connectivity transitions.
  useEffect(() => {
    if (!online) {
      wasOffline.current = true;
      setMode('offline');
    } else if (wasOffline.current) {
      wasOffline.current = false;
      setMode('reconnected');
      const t = setTimeout(() => setMode('hidden'), 1800);
      return () => clearTimeout(t);
    }
  }, [online]);

  // Slide in/out.
  useEffect(() => {
    Animated.spring(translateY, {
      toValue: mode === 'hidden' ? -160 : 0,
      useNativeDriver: true,
      damping: 19,
      stiffness: 190,
      mass: 0.75,
    }).start();
  }, [mode, translateY]);

  const offline = mode === 'offline';

  // The banner is an absolute overlay above the whole navigator, so it MUST stay
  // opaque: an opaque theme background carries the tint layer below.
  const base = isDark ? THEME.dark.background : THEME.light.background;
  const accent = THEME.accent[isDark ? 'dark' : 'light'];
  // Tint = the state's accent at a low alpha over that base. The composite lands
  // within ~1-4pp lightness of the literals it replaces, so the dark banner stays
  // dark and the light banner stays light.
  const tint = offline
    ? withAlpha(isDark ? THEME.dark.destructive : THEME.light.destructive, isDark ? 0.18 : 0.14)
    : withAlpha(accent.green, isDark ? 0.18 : 0.14);
  // Foreground: the state's accent in both themes. `destructive` and
  // `accent.green` both have a per-theme value (J-7). Measured WCAG contrast of
  // the green on its own tint is 4.98:1 in light and 4.14:1 in dark. Keep the
  // success signal in the text, not only in the low-alpha tint.
  const fg = offline
    ? (isDark ? THEME.dark.destructive : THEME.light.destructive)
    : accent.green;

  return (
    <Animated.View
      pointerEvents="none"
      style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 9999, transform: [{ translateY }] }}
    >
      <View style={{ paddingTop: insets.top + 6, paddingBottom: 9, paddingHorizontal: 16, backgroundColor: base }}>
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: tint }]} />
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 }}>
          {offline ? <WifiOff size={14} color={fg} /> : <Wifi size={14} color={fg} />}
          <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fg }}>
            {offline ? 'No internet connection' : 'Back online'}
          </Text>
        </View>
      </View>
    </Animated.View>
  );
}
