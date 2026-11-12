/**
 * BottomSearchBar — the iOS 26 bottom search of a list page (the Claude iOS
 * Projects page; Jay, 2026-11-11). iOS only: `usesBottomSearch()` is false
 * elsewhere, the component renders nothing there, and the page keeps its top
 * `SearchListHeader`.
 *
 * At rest the page has no search field at the top. A `PinnedBar` (fade +
 * progressive blur of `background`) holds one row:
 *
 *   [search circle]                    [trailing] [action pill]
 *
 * - Left: the search circle.
 * - Right: `trailing` when given (the Files version switcher), then the
 *   action pill. No `action`: no pill.
 * - `fieldAtRest` (a page with no action, the Apps page): the full-width
 *   search field shows at rest instead of the circle, with no X; the X shows
 *   next to it while the field is focused or holds text (Jay, 2026-11-11).
 * - The search circle is a 44pt Liquid Glass circle with a magnifier
 *   (`GlassButtons`, the drawer's avatar circle). The action pill is the
 *   drawer's New session: `Button size="lg"` on glass tinted in the primary
 *   colour (`GlassButtons tintColor`), icon + label.
 *
 * A tap on the search circle expands the row into a full-width glass search
 * field (magnifier + field, auto-focused) and a separate 44pt glass X circle.
 * The row rides on the keyboard (`KeyboardStickyView`), `KEYBOARD_GAP` above
 * it. Typing calls `onChangeText` on every keystroke: the page filters as it
 * did with the top field. X clears the text, closes the keyboard and
 * collapses the row. The keyboard closing (a drag on the list) collapses an
 * empty field; a field with text stays expanded at the bottom, so the filter
 * stays visible, and X clears it. Text set from outside (a page's Reset)
 * expands or collapses the row with it.
 *
 * `autoFocusOnMount` starts expanded and focused (the drawer's Search row
 * opens the Sessions page that way). `searchEnabled={false}` hides the search
 * circle (a list with nothing to search yet) and keeps the action.
 *
 * iOS before 26, or a binary without `ExpoGlassEffect`: the same layout on
 * the drawer's opaque fallbacks: a `secondary` circle and field, the solid
 * primary pill.
 *
 * No expand animation: the row swaps in one frame and the keyboard's own
 * motion carries it. Nothing to turn off under Reduce Motion.
 *
 * The page pads its list's end by `useBottomSearchInset()`, so the last row
 * clears the bar.
 */
import * as React from 'react';
import { Keyboard, Platform, View, type ViewProps } from 'react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HEADER_BUTTON_SIZE, HEADER_ICON_SIZE } from '@/components/kortix/header-button';
import { GlassButtons, LiquidGlass, LIQUID_GLASS_AVAILABLE } from '@/components/kortix/liquid-glass';
import { PINNED_BAR_BOTTOM_GAP, PinnedBar, usePinnedBarInset } from '@/components/kortix/pinned-bar';
import { SearchPill } from '@/components/kortix/search-pill';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { haptics } from '@/lib/haptics';
import { MagnifyingGlassIcon, XIcon, type AppIcon } from '@/lib/icons';
import { BUTTON_LABEL_MAX_FONT_SCALE } from '@/lib/ui/font-scale';
import { THEME } from '@/lib/utils/theme';

/** The row's height: the 44pt circles and the `lg` pill. */
export const BOTTOM_SEARCH_BAR_HEIGHT = 44;
/** Space between the expanded row and the top of the keyboard. */
const KEYBOARD_GAP = 10;

type StickyViewType = React.ComponentType<
  ViewProps & { offset?: { closed?: number; opened?: number }; children?: React.ReactNode }
>;

/**
 * `KeyboardStickyView`, loaded on iOS only (the app root's `KeyboardProvider`
 * has loaded the package there). Required, not imported: Android and bun tests
 * never load it. Missing: the row stays at the bottom.
 */
const StickyView: StickyViewType | null = (() => {
  if (Platform?.OS !== 'ios') return null;
  try {
    return (require('react-native-keyboard-controller') as { KeyboardStickyView: StickyViewType }).KeyboardStickyView;
  } catch {
    return null;
  }
})();

/** True where pages put their search at the bottom (iOS). Elsewhere they keep `SearchListHeader`. */
export function usesBottomSearch(): boolean {
  return Platform?.OS === 'ios';
}

/** Bottom padding for a list under a `BottomSearchBar`. */
export function useBottomSearchInset(): number {
  return usePinnedBarInset(BOTTOM_SEARCH_BAR_HEIGHT);
}

export interface BottomSearchAction {
  label: string;
  icon?: AppIcon;
  onPress: () => void;
  accessibilityLabel?: string;
  disabled?: boolean;
}

interface BottomSearchBarProps {
  value: string;
  onChangeText: (next: string) => void;
  /** The field's placeholder. Default "Search". */
  placeholder?: string;
  /** Spoken name of the search circle and the field. Default "Search". */
  searchLabel?: string;
  /** The page's primary action, a pill at the bottom right. Omit for none. */
  action?: BottomSearchAction;
  /** A control at the bottom right, before the action (the Files version switcher). Hidden while expanded. */
  trailing?: React.ReactNode;
  /** Show the full-width field at rest instead of the circle; the X shows only while focused or with text. */
  fieldAtRest?: boolean;
  /** Start expanded with the field focused. */
  autoFocusOnMount?: boolean;
  /** `false` hides the search circle and keeps the action. Default true. */
  searchEnabled?: boolean;
  /** The surface under the bar; the fade ends on it. */
  background: string;
}

export function BottomSearchBar({
  value,
  onChangeText,
  placeholder = 'Search',
  searchLabel = 'Search',
  action,
  trailing,
  fieldAtRest = false,
  autoFocusOnMount = false,
  searchEnabled = true,
  background,
}: BottomSearchBarProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  // `open`: the user asked for the field (a tap, the mount focus). Text keeps
  // it expanded after the keyboard closes.
  const [open, setOpen] = React.useState(autoFocusOnMount);
  const expanded = searchEnabled && (open || value.length > 0);

  if (!usesBottomSearch()) return null;

  const glassy = LIQUID_GLASS_AVAILABLE;
  const primaryFill = isDark ? THEME.dark.primary : THEME.light.primary;

  const expand = () => {
    haptics.tap();
    setOpen(true);
  };
  const close = () => {
    haptics.tap();
    onChangeText('');
    setOpen(false);
    Keyboard.dismiss();
  };

  const circle = (icon: AppIcon, label: string, onPress: () => void) => (
    <GlassButtons>
      <Button
        variant={glassy ? 'ghost' : 'secondary'}
        size={HEADER_BUTTON_SIZE}
        className="rounded-full"
        onPress={onPress}
        accessibilityLabel={label}>
        <Icon as={icon} size={HEADER_ICON_SIZE} className="text-foreground" />
      </Button>
    </GlassButtons>
  );

  const searchCircle = searchEnabled ? circle(MagnifyingGlassIcon, searchLabel, expand) : null;

  const actionPill = action ? (
    <GlassButtons tintColor={primaryFill}>
      <Button
        size="lg"
        variant="default"
        // On glass the tint is the fill: the solid primary would hide the glass.
        className={glassy ? 'rounded-full bg-transparent dark:bg-transparent' : 'rounded-full'}
        disabled={action.disabled}
        accessibilityLabel={action.accessibilityLabel}
        onPress={() => {
          haptics.tap();
          action.onPress();
        }}>
        {action.icon ? <Icon as={action.icon} size={20} /> : null}
        <Text maxFontSizeMultiplier={BUTTON_LABEL_MAX_FONT_SCALE.lg}>{action.label}</Text>
      </Button>
    </GlassButtons>
  ) : null;

  const field = (
    <SearchPill
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      size="lg"
      filled={!glassy}
      clearable={false}
      inputProps={{
        // `open` at mount: a tap or `autoFocusOnMount`. A row that mounts
        // expanded only because it has text keeps the keyboard down.
        autoFocus: open,
        accessibilityLabel: searchLabel,
        onFocus: () => setOpen(true),
        onBlur: () => setOpen(false),
      }}
    />
  );

  const fieldRow = (withClose: boolean) => (
    <>
      {glassy ? (
        <LiquidGlass interactive={false} style={{ flex: 1, flexDirection: 'row' }}>
          {field}
        </LiquidGlass>
      ) : (
        field
      )}
      {withClose ? circle(XIcon, 'Close search', close) : null}
    </>
  );

  const row = expanded ? (
    fieldRow(true)
  ) : fieldAtRest && searchEnabled ? (
    fieldRow(false)
  ) : (
    <>
      {searchCircle ?? <View />}
      <View className="min-w-0 flex-row items-center gap-2" style={{ flexShrink: 1 }}>
        {trailing}
        {actionPill}
      </View>
    </>
  );

  const bar = (
    <PinnedBar
      controlHeight={BOTTOM_SEARCH_BAR_HEIGHT}
      background={background}
      blur
      dark={isDark}
      className={expanded || (fieldAtRest && searchEnabled) ? 'gap-2 px-4' : 'justify-between gap-2 px-4'}>
      {row}
    </PinnedBar>
  );

  if (!StickyView) return bar;
  // The whole page box moves with the keyboard (it takes no touches), so the
  // bar keeps its own layout. Open: the bar's bottom gap (safe area + 16)
  // shrinks to `KEYBOARD_GAP` above the keyboard.
  return (
    <StickyView
      pointerEvents="box-none"
      style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
      offset={{ closed: 0, opened: insets.bottom + PINNED_BAR_BOTTOM_GAP - KEYBOARD_GAP }}>
      {bar}
    </StickyView>
  );
}

/**
 * GlassSearchField — the bottom bar's expanded field on its own, for a search
 * that stays at the top of its surface (the workspace switcher sheet; Jay,
 * 2026-11-11): a 44pt Liquid Glass search pill, and a 44pt glass X beside it
 * while the field is focused or holds text. X clears and closes the keyboard.
 * iOS before 26: the same on the opaque fallbacks. Elsewhere (Android) the
 * standard filled `SearchPill` with its inline clear button.
 */
export function GlassSearchField({
  value,
  onChangeText,
  placeholder = 'Search',
  searchLabel = 'Search',
}: {
  value: string;
  onChangeText: (next: string) => void;
  placeholder?: string;
  searchLabel?: string;
}) {
  const [focused, setFocused] = React.useState(false);
  if (!usesBottomSearch()) {
    // `SearchPill` is `flex-1` for a row: in the caller's column it would
    // shrink to a sliver under the list (the Android workspace switcher).
    return (
      <View className="flex-row items-center">
        <SearchPill value={value} onChangeText={onChangeText} placeholder={placeholder} inputProps={{ accessibilityLabel: searchLabel }} />
      </View>
    );
  }
  const glassy = LIQUID_GLASS_AVAILABLE;
  const field = (
    <SearchPill
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      size="lg"
      filled={!glassy}
      clearable={false}
      inputProps={{
        accessibilityLabel: searchLabel,
        returnKeyType: 'search',
        onFocus: () => setFocused(true),
        onBlur: () => setFocused(false),
      }}
    />
  );
  return (
    <View className="flex-row items-center gap-2">
      {glassy ? (
        <LiquidGlass interactive={false} style={{ flex: 1, flexDirection: 'row' }}>
          {field}
        </LiquidGlass>
      ) : (
        field
      )}
      {focused || value.length > 0 ? (
        <GlassButtons>
          <Button
            variant={glassy ? 'ghost' : 'secondary'}
            size={HEADER_BUTTON_SIZE}
            className="rounded-full"
            onPress={() => {
              haptics.tap();
              onChangeText('');
              Keyboard.dismiss();
            }}
            accessibilityLabel="Close search">
            <Icon as={XIcon} size={HEADER_ICON_SIZE} className="text-foreground" />
          </Button>
        </GlassButtons>
      ) : null}
    </View>
  );
}
