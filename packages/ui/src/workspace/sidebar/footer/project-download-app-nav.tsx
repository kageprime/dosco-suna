'use client';

import { DownloadSimpleIcon } from '@phosphor-icons/react';
import { useCallback, useState, useSyncExternalStore } from 'react';

import { useSidebar } from '../../../primitives/sidebar';
import { useIsMobile } from '../../../internal/hooks';
import { isDesktop } from '../../../internal/lib/desktop';
import { useTranslations } from '../../../i18n';
import { PromoNavRow } from './promo-nav-row';

export const DOWNLOAD_APP_PROMO_DISMISSED_KEY = 'kortix.download-app-promo.dismissed';

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
 * "Download app": the same promo row as "Connect MCP", shown until dismissed
 * and never inside the desktop app. It moved here from the workspace menu,
 * where it sat two levels deep. After a dismiss, Apps and extensions in the
 * workspace menu still offers the download.
 */
export function ProjectDownloadAppNavItem({ onOpenDownload }: { onOpenDownload: () => void }) {
  const t = useTranslations('sidebar');
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
  if (stored || dismissedNow) return null;

  return (
    <PromoNavRow
      icon={<DownloadSimpleIcon className="text-muted-foreground size-4 shrink-0" />}
      label={t('workspace.downloadApp')}
      dismissLabel={tComputers('dismissPromo')}
      onDismiss={dismiss}
      onClick={() => {
        onOpenDownload();
        if (isMobile) setOpenMobile(false);
      }}
    />
  );
}
