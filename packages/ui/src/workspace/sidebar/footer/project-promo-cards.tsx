'use client';

import { ChromePromoSlide, useChromePromoDismissed } from './project-chrome-nav';
import { ComputerPromoSlide, useComputerPromoDismissed } from './project-computer-nav';
import { useDesktopAppPromo } from './project-download-app-nav';
import { useMcpPromo } from './project-mcp-nav';
import { usePhoneAppPromo } from './project-phone-app-nav';
import { PromoSwitcher, type PromoSlide } from './promo-card';

import type { ReactNode } from 'react';

import { useTranslations } from '../../../i18n';

/**
 * The workspace's one promo card: in the sidebar on a phone, floating in the
 * window's bottom-right corner on desktop. Every way to reach Kortix from somewhere else
 * is a slide, in this order: the chat apps people already use (MCP), their
 * own computer, Chrome, the desktop app, the phone app. Each slide is
 * dismissed on its own and leaves once it is done (a paired computer, a
 * connected browser, inside the desktop app). With no slide left, nothing
 * renders.
 *
 * The computer and Chrome slides read a list from the API, so they mount only
 * while they are not dismissed (`ComputerPromoSlide`, `ChromePromoSlide`).
 */
export function ProjectPromoCards({
  projectId,
  onOpenMcp,
  onOpenComputer,
  onOpenChrome,
  onOpenDownloadApp,
  variant = 'inline',
  composer,
}: {
  projectId: string;
  /** `floating` pins the card to the window's bottom-right corner (desktop). */
  variant?: 'inline' | 'floating';
  /** Floating only: the page's bottom composer (see `PromoSwitcher`). */
  composer?: 'centered' | 'full';
  onOpenMcp: () => void;
  onOpenComputer: () => void;
  /** Absent when Kortix in Chrome is off for this workspace. */
  onOpenChrome?: () => void;
  /** Absent where the host has no download dialog. */
  onOpenDownloadApp?: () => void;
}) {
  const t = useTranslations('sidebar');
  const mcp = useMcpPromo(onOpenMcp);
  const desktop = useDesktopAppPromo(onOpenDownloadApp);
  const phone = usePhoneAppPromo(onOpenDownloadApp);
  const [computerDismissed, dismissComputer] = useComputerPromoDismissed();
  const [chromeDismissed, dismissChrome] = useChromePromoDismissed();

  const render = (computer: PromoSlide | null, chrome: PromoSlide | null) => (
    <PromoSwitcher
      label={t('promos')}
      variant={variant}
      composer={composer}
      slides={[mcp, computer, chrome, desktop, phone].filter(
        (slide): slide is PromoSlide => slide !== null,
      )}
    />
  );
  const withChrome = (computer: PromoSlide | null): ReactNode =>
    !onOpenChrome || chromeDismissed ? (
      render(computer, null)
    ) : (
      <ChromePromoSlide onOpenConnect={onOpenChrome} onDismiss={dismissChrome}>
        {(chrome) => render(computer, chrome)}
      </ChromePromoSlide>
    );

  if (computerDismissed) return withChrome(null);
  return (
    <ComputerPromoSlide
      projectId={projectId}
      onOpenConnect={onOpenComputer}
      onDismiss={dismissComputer}
    >
      {withChrome}
    </ComputerPromoSlide>
  );
}
