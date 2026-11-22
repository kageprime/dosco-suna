'use client';

import type { PromoSlide } from './promo-card';
import { PromoMark } from './promo-card';

import { AppWindowIcon, CommandIcon, LaptopIcon } from '@phosphor-icons/react';
import { useCallback, useState, useSyncExternalStore } from 'react';

import { useTranslations } from '../../../i18n';
import { useIsMobile } from '../../../internal/hooks';
import { isDesktop } from '../../../internal/lib/desktop';
import { useSidebar } from '../../../primitives/sidebar';

export const DOWNLOAD_APP_PROMO_DISMISSED_KEY = 'kortix.download-app-promo.dismissed';

/** The window, Quick Entry, and the computer it connects in one click. */
const MARKS = [AppWindowIcon, CommandIcon, LaptopIcon] as const;

const subscribeNoop = () => () => {};

function readHidden(): boolean {
  // The desktop app is already the download.
  if (isDesktop()) return true;
  try {
    return window.localStorage.getItem(DOWNLOAD_APP_PROMO_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * "Get the desktop app": a slide of the sidebar's promo switcher
 * (`project-promo-cards.tsx`), shown until dismissed and never inside the
 * desktop app. `onOpenDownload` opens the download dialog (desktop and phone
 * apps); without it, there is no slide. After a dismiss, Apps and extensions
 * in the workspace menu still offers the download.
 */
export function useDesktopAppPromo(onOpenDownload: (() => void) | undefined): PromoSlide | null {
  const t = useTranslations('sidebar.desktopPromo');
  const tComputers = useTranslations('computers');
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  // The server and the hydrating render read "hidden"; the stored flag applies after.
  const stored = useSyncExternalStore(subscribeNoop, readHidden, () => true);
  const [dismissedNow, setDismissed] = useState(false);
  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DOWNLOAD_APP_PROMO_DISMISSED_KEY, '1');
    } catch {
      // Private mode or blocked storage: dismissed for this page view only.
    }
  }, []);
  if (!onOpenDownload || stored || dismissedNow) return null;

  return {
    id: 'desktop',
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
