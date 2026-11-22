'use client';

import type { PromoSlide } from './promo-card';
import { PromoMark } from './promo-card';

import { useChromeConnections } from '@kortix/sdk/react';
import { CursorClickIcon, KeyIcon } from '@phosphor-icons/react';
import { useCallback, useState, useSyncExternalStore, type ReactNode } from 'react';

import { useTranslations } from '../../../i18n';
import { BrowserIcon } from '../../../internal/chrome/browser-icon';
import { useIsMobile } from '../../../internal/hooks';
import { useSidebar } from '../../../primitives/sidebar';

export const CHROME_PROMO_DISMISSED_KEY = 'kortix.chrome-promo.dismissed';

const subscribeNoop = () => () => {};

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(CHROME_PROMO_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

/** Whether the Chrome slide was dismissed in this browser, and the dismiss. */
export function useChromePromoDismissed(): [boolean, () => void] {
  // The server and the hydrating render read "dismissed"; the stored flag applies after.
  const stored = useSyncExternalStore(subscribeNoop, readDismissed, () => true);
  const [dismissedNow, setDismissed] = useState(false);
  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      window.localStorage.setItem(CHROME_PROMO_DISMISSED_KEY, '1');
    } catch {
      // Private mode or blocked storage: dismissed for this page view only.
    }
  }, []);
  return [stored || dismissedNow, dismiss];
}

/**
 * "Add Kortix to Chrome": the Chrome slide of the sidebar's promo switcher
 * (`project-promo-cards.tsx`). An advertisement, not a status widget: the
 * slide is `null` while the browser list loads and once the caller connected
 * a browser. Mount it only while the slide is not dismissed, so a dismissed
 * slide polls no browser list. The sidebar owns the connect dialog: on a
 * phone the card unmounts with the sidebar sheet.
 */
export function ChromePromoSlide({
  onOpenConnect,
  onDismiss,
  children,
}: {
  onOpenConnect: () => void;
  onDismiss: () => void;
  children: (slide: PromoSlide | null) => ReactNode;
}) {
  const t = useTranslations('chrome');
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  // One a minute until the first browser connects: the connect dialog polls
  // faster while it is open.
  const connections = useChromeConnections({ refetchInterval: 60_000 });

  if (!connections.isSuccess || connections.data.length > 0) return children(null);

  return children({
    id: 'chrome',
    marks: (
      <>
        <PromoMark>
          <BrowserIcon brand="chrome" tone="current" className="size-5" />
        </PromoMark>
        <PromoMark>
          <KeyIcon className="size-5" />
        </PromoMark>
        <PromoMark>
          <CursorClickIcon className="size-5" />
        </PromoMark>
      </>
    ),
    title: t('connectTitle'),
    description: t('connectDescription'),
    cta: t('connect'),
    dismissLabel: t('dismissPromo'),
    onDismiss,
    onClick: () => {
      onOpenConnect();
      if (isMobile) setOpenMobile(false);
    },
  });
}
