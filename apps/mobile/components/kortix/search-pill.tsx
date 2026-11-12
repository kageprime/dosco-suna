/**
 * SearchPill — the filled, borderless search input pill (40pt, `rounded-full
 * bg-secondary`) holding a 16pt magnifier, the app Input and a clear pressable
 * that shows only when the text is non-empty. Single source of truth for the
 * pill's sizing, padding, and radii; `SearchListHeader` composes it.
 *
 * `icon` swaps the magnifier for a field that is not a search but takes the
 * same look (the Invite member sheet's email field). `Input` renders
 * `SheetRawTextInput` inside a sheet (gorhom's `BottomSheetTextInput` in a
 * gorhom sheet, React Native's `TextInput` in an iOS native sheet), so the pill
 * is sheet-safe.
 */

import * as React from 'react';
import { Pressable, View } from 'react-native';
import { MagnifyingGlassIcon as Search, XIcon as X, type AppIcon } from '@/lib/icons';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';

export function SearchPill({
  value,
  onChangeText,
  placeholder = 'Search…',
  icon = Search,
  clearLabel = 'Clear search',
  size = 'default',
  filled = true,
  clearable = true,
  inputProps,
}: {
  value: string;
  onChangeText: (next: string) => void;
  placeholder?: string;
  /** The leading glyph. Default: the magnifier. */
  icon?: AppIcon;
  /** Spoken name of the clear button. */
  clearLabel?: string;
  /** `default` 40pt, `lg` 44pt. */
  size?: 'default' | 'lg';
  /** The `bg-secondary` fill. `false` on a glass capsule. */
  filled?: boolean;
  /** The inline clear button while there is text. */
  clearable?: boolean;
  inputProps?: Omit<React.ComponentProps<typeof Input>, 'value' | 'onChangeText' | 'placeholder'>;
}) {
  return (
    // Filled, borderless pill; the Input inside inherits the app-wide input
    // text (16pt Roobert Regular) and only drops its own surface.
    <View
      className={`${size === 'lg' ? 'h-11' : 'h-10'} flex-1 flex-row items-center rounded-full px-4${filled ? ' bg-secondary' : ''}`}>
      <Icon as={icon} size={size === 'lg' ? 18 : 16} className="text-muted-foreground" />
      <Input
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
        {...inputProps}
        className="ml-2 h-full flex-1 rounded-none bg-transparent px-0"
      />
      {clearable && value.length > 0 && (
        <Pressable
          onPress={() => onChangeText('')}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={clearLabel}>
          <Icon as={X} size={16} className="text-muted-foreground" />
        </Pressable>
      )}
    </View>
  );
}
