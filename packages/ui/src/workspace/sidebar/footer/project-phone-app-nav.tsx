'use client';

import type { PromoSlide } from './promo-card';
import { PromoMark } from './promo-card';

import { BellIcon, DeviceMobileIcon, MicrophoneIcon } from '@phosphor-icons/react';
import { useCallback, useState, useSyncExternalStore } from 'react';

import { useTranslations } from '../../../i18n';
import { useIsMobile } from '../../../internal/hooks';
import { useSidebar } from '../../../primitives/sidebar';

export const PHONE_APP_PROMO_DISMISSED_KEY = 'kortix.phone-app-promo.dismissed';

/** The phone, then what it adds: push notifications and dictation. */
const MARKS = [DeviceMobileIcon, BellIcon, MicrophoneIcon] as const;

const subscribeNoop = () => () => {};

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(PHONE_APP_PROMO_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * "Kortix on your phone": a slide of the sidebar's promo switcher
 * (`project-promo-cards.tsx`), shown until dismissed. `onOpenDownload` opens
 * the download dialog: on a computer its phone card carries the store QR
 * code, on a phone the store buttons. Without it, there is no slide. The
 * one-time phone pop-up (`mobile-app-promo.tsx`) keeps its own flag.
 */
export function usePhoneAppPromo(onOpenDownload: (() => void) | undefined): PromoSlide | null {
  const t = useTranslations('sidebar.phonePromo');
  const tComputers = useTranslations('computers');
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  // The server and the hydrating render read "dismissed"; the stored flag applies after.
  const stored = useSyncExternalStore(subscribeNoop, readDismissed, () => true);
  const [dismissedNow, setDismissed] = useState(false);
  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      window.localStorage.setItem(PHONE_APP_PROMO_DISMISSED_KEY, '1');
    } catch {
      // Private mode or blocked storage: dismissed for this page view only.
    }
  }, []);
  if (!onOpenDownload || stored || dismissedNow) return null;

  return {
    id: 'phone',
    marks: MARKS.map((MarkIcon, index) => (
      <PromoMark key={index}>
        <MarkIcon className="size-5" />
      </PromoMark>
    )),
    title: t('title'),
    description: t('description'),
    cta: t('cta'),
    dismissLabel: tComputers('dismissPromo'),
    onDismiss: dismiss,
    onClick: () => {
      onOpenDownload();
      if (isMobile) setOpenMobile(false);
    },
  };
}
