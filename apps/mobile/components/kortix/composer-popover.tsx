/**
 * The composer's popover: the card (`components/kortix/composer-card.tsx`)
 * with one capped list inside. The question's options (`QuestionPrompt`) and
 * the @/#// suggestions (`SuggestionCard`) draw it, so the floating lists
 * never drift from the composer (`components/kortix/composer.tsx`).
 */
import * as React from 'react';
import { ScrollView } from 'react-native';

import { ComposerCard } from './composer-card';

/** About five option rows, then the list scrolls. */
const POPOVER_MAX_HEIGHT = 260;

/** The composer card's capped list: the option/suggestion rows scroll inside the popover card. */
export function ComposerList({ children, ...props }: React.ComponentProps<typeof ScrollView>) {
  return (
    <ScrollView
      style={{ maxHeight: POPOVER_MAX_HEIGHT }}
      keyboardShouldPersistTaps="always"
      showsVerticalScrollIndicator={false}
      {...props}
    >
      {children}
    </ScrollView>
  );
}

/**
 * The composer card floating above the input with one capped list inside
 * (about five option rows, then the list scrolls). `cardClassName` carries
 * the popover's own placement — the margin on the composer's edge, a clip.
 */
export function ComposerPopover({
  cardClassName,
  children,
  ...props
}: React.ComponentProps<typeof ScrollView> & { cardClassName?: string; children: React.ReactNode }) {
  return (
    <ComposerCard className={cardClassName}>
      <ComposerList {...props}>{children}</ComposerList>
    </ComposerCard>
  );
}
