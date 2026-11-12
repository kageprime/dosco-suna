/**
 * The "Continue closes the sheet first, then the hand-off runs" pattern —
 * Paper board 08's close-then-open rule ("never two overlays"), factored out
 * of `ConnectProviderSheet` so `ConnectorAuthSheet` (COR-158's connector
 * hand-off) reuses it instead of duplicating the close-then dance.
 *
 * `run` fires from the sheet's own `onDismiss`, once, and ONLY when the
 * dismiss followed a Continue tap — a swipe-to-close or "Not now" never fires
 * it. The sheet component itself stays mounted the whole time (a permanent
 * sibling of the composer), so `run`'s closures over its own props are
 * unaffected by the *modal* dismissing — only the pending slot
 * (`useCloseThen`) distinguishes the two kinds of dismiss.
 *
 * `onCancel` (optional) fires from the same `onDismiss` when the dismiss did
 * NOT follow Continue — "Not now", a swipe, the backdrop — so a caller that
 * closed its own sheet to show this one can bring it back.
 */
import * as React from 'react';
import { View } from 'react-native';

import { type SheetRef, useCloseThen } from '@/components/kortix/sheet';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { ArrowUpRightIcon } from '@/lib/icons';
import { haptics } from '@/lib/haptics';

export function useHandoffDismiss(run: () => void | Promise<void>, onCancel?: () => void) {
  const { deferAfterClose, takeAfterClose } = useCloseThen<boolean>();

  const requestContinue = React.useCallback(
    (sheetRef: React.RefObject<SheetRef | null>) => {
      haptics.tap();
      // Close first — the hand-off runs only once this sheet is fully gone
      // (`handleDismiss`), so the two are never on screen together.
      deferAfterClose(true);
      sheetRef.current?.close();
    },
    [deferAfterClose],
  );

  const handleDismiss = React.useCallback(async () => {
    if (!takeAfterClose()) {
      onCancel?.();
      return;
    }
    await run();
  }, [takeAfterClose, run, onCancel]);

  return { requestContinue, handleDismiss };
}

/**
 * The body of a hand-off sheet: an optional leading node (the connector
 * handshake), what gets connected, one line on what happens next, then the
 * two pills.
 *
 * The primary pill names where it goes ("Continue to GitHub") and may carry
 * the leaves-the-app arrow beside its label. Both pills are `lg` and full
 * width, so the pair reads as one stack; "Not now" is `secondary`, as on the
 * upgrade sheet.
 */
export function HandoffBody({
  leading,
  title,
  line,
  action,
  notNowLabel = 'Not now',
  onContinue,
  onClose,
  leavesApp = false,
}: {
  /** The node above the title: the connector handshake. None centers the title alone. */
  leading?: React.ReactNode;
  title: string;
  line: string;
  /** The primary pill's label. */
  action: string;
  /** The secondary pill's label; it closes without running the hand-off. */
  notNowLabel?: string;
  onContinue: () => void;
  onClose: () => void;
  /** The primary pill carries the leaves-the-app arrow (a connector hand-off). */
  leavesApp?: boolean;
}) {
  return (
    <>
      {leading}
      <Text variant="large" className={leading ? 'mt-6 text-center' : 'text-center'} accessibilityRole="header">
        {title}
      </Text>
      <Text variant="muted" className="mt-2 px-4 text-center leading-5">
        {line}
      </Text>
      <View className="mt-8 w-full gap-2">
        <Button size="lg" className="rounded-full" onPress={onContinue}>
          <Text>{action}</Text>
          {leavesApp ? <Icon as={ArrowUpRightIcon} size={16} /> : null}
        </Button>
        <Button variant="secondary" size="lg" className="rounded-full" onPress={onClose}>
          <Text>{notNowLabel}</Text>
        </Button>
      </View>
    </>
  );
}
