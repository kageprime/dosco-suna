/**
 * NativeMenuButton — an icon button that opens the iOS system menu (a SwiftUI
 * `Menu` through `@expo/ui`; Liquid Glass on iOS 26), with submenus and
 * checkmarks (Jay, 2026-11-11: the Files page's View options on iOS).
 *
 * A tap opens the menu, as a native pull-down button does. Items are data:
 * an `action` row (title, SF Symbol, `checked` draws a checkmark, `destructive`)
 * or a `submenu` of action rows. The button draws only the glyph in a 44pt box
 * (`HEADER_BUTTON_PT`): the glass around it comes from where it sits
 * (`PageHeader`'s right column is one glass capsule).
 *
 * `NATIVE_MENU_AVAILABLE` is false on Android and on a binary without the
 * `ExpoUI` native module (an OTA update can reach one): the caller keeps its
 * React Native control (Files: the View options sheet).
 */
import * as React from 'react';
import { Platform, View } from 'react-native';
import { useColorScheme } from 'nativewind';

import { HEADER_BUTTON_PT } from '@/components/kortix/header-button';

type SwiftUIModule = typeof import('@expo/ui/swift-ui');
type SwiftUIModifiers = typeof import('@expo/ui/swift-ui/modifiers');
type SFSymbol = NonNullable<React.ComponentProps<SwiftUIModule['Image']>['systemName']>;

/** `@expo/ui` only where the binary has it: required, not imported, so Android and bun tests never load it. */
const swiftUI: { ui: SwiftUIModule; modifiers: SwiftUIModifiers } | null = (() => {
  if (Platform?.OS !== 'ios') return null;
  try {
    const { requireOptionalNativeModule } = require('expo') as typeof import('expo');
    if (requireOptionalNativeModule('ExpoUI') == null) return null;
    return {
      ui: require('@expo/ui/swift-ui') as SwiftUIModule,
      modifiers: require('@expo/ui/swift-ui/modifiers') as SwiftUIModifiers,
    };
  } catch {
    return null;
  }
})();

/** True where `NativeMenuButton` renders (iOS with `ExpoUI`). */
export const NATIVE_MENU_AVAILABLE = swiftUI != null;

export interface NativeMenuAction {
  type: 'action';
  title: string;
  systemImage?: SFSymbol;
  /** Draws a checkmark in place of `systemImage` (the active choice). */
  checked?: boolean;
  disabled?: boolean;
  destructive?: boolean;
  onPress: () => void;
}

export interface NativeSubmenu {
  type: 'submenu';
  title: string;
  systemImage?: SFSymbol;
  disabled?: boolean;
  items: NativeMenuAction[];
}

export type NativeMenuItem = NativeMenuAction | NativeSubmenu;

export function NativeMenuButton({
  systemImage,
  accessibilityLabel,
  items,
}: {
  /** The glyph on the button. */
  systemImage: SFSymbol;
  accessibilityLabel: string;
  items: NativeMenuItem[];
}) {
  const { colorScheme } = useColorScheme();
  if (!swiftUI) return null;
  const { Host, Menu, Button, Image } = swiftUI.ui;
  const { frame, contentShape, shapes, disabled, accessibilityLabel: a11yLabel, foregroundStyle } = swiftUI.modifiers;
  const ink = colorScheme === 'dark' ? 'white' : 'black';

  const action = (item: NativeMenuAction, key: string) => (
    <Button
      key={key}
      label={item.title}
      systemImage={item.checked ? 'checkmark' : item.systemImage}
      role={item.destructive ? 'destructive' : 'default'}
      onPress={item.onPress}
      modifiers={item.disabled ? [disabled(true)] : undefined}
    />
  );

  return (
    <View style={{ width: HEADER_BUTTON_PT, height: HEADER_BUTTON_PT }}>
      <Host style={{ width: HEADER_BUTTON_PT, height: HEADER_BUTTON_PT }} colorScheme={colorScheme === 'dark' ? 'dark' : 'light'}>
        <Menu
          label={
            <Image
              systemName={systemImage}
              size={19}
              modifiers={[
                frame({ width: HEADER_BUTTON_PT, height: HEADER_BUTTON_PT }),
                // The whole 44pt box takes the tap, not only the glyph.
                contentShape(shapes.rectangle()),
                foregroundStyle(ink),
                a11yLabel(accessibilityLabel),
              ]}
            />
          }>
          {items.map((item, i) =>
            item.type === 'submenu' ? (
              <Menu
                key={`m${i}`}
                label={item.title}
                systemImage={item.systemImage}
                modifiers={item.disabled ? [disabled(true)] : undefined}>
                {item.items.map((sub, j) => action(sub, `m${i}-${j}`))}
              </Menu>
            ) : (
              action(item, `a${i}`)
            )
          )}
        </Menu>
      </Host>
    </View>
  );
}
