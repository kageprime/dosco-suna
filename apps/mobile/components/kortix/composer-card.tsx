/**
 * The composer card's shared surfaces: the one card class and the card view.
 * `SessionConnecting` reuses the card for the session failure views,
 * `ComposerStatusPill` draws it as the status row, and the floating popovers
 * (`components/kortix/composer-popover.tsx`) draw it around their capped
 * list — so the surfaces never drift from the composer
 * (`components/kortix/composer.tsx`). Light on purpose (a `View` only): the
 * components render inside test graphs that cannot load the composer's own
 * native imports.
 */
import * as React from 'react';
import { View } from 'react-native';

/**
 * The composer card's surface: corners, hairline border, page colour, inset.
 * A view that takes the composer's slot (the session failure card) uses it so
 * the two never drift.
 */
export const COMPOSER_CARD_CLASS = 'rounded-3xl border border-border bg-background p-2';

/** The composer card as a view: `COMPOSER_CARD_CLASS`, plus any caller classes. */
export function ComposerCard({ className, children }: { className?: string; children: React.ReactNode }) {
  return <View className={className ? `${className} ${COMPOSER_CARD_CLASS}` : COMPOSER_CARD_CLASS}>{children}</View>;
}
