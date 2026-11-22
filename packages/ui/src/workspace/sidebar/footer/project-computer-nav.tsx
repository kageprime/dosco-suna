'use client';

import type { PromoSlide } from './promo-card';
import { PromoMark } from './promo-card';

import { CursorClickIcon, FolderSimpleIcon, LaptopIcon, TerminalWindowIcon } from '@phosphor-icons/react';
import { useCallback, useState, useSyncExternalStore, type ReactNode } from 'react';

import { useSidebar } from '../../../primitives/sidebar';
import {
  useConnectDesktopComputer,
  useOwnsPairedComputer,
  useThisComputerState,
} from '../../../internal/tunnel/computer-connect';
import { useIsMobile } from '../../../internal/hooks';
import { useTranslations } from '../../../i18n';

export const COMPUTER_PROMO_DISMISSED_KEY = 'kortix.computer-promo.dismissed';

/** The machine, then the three capabilities a pairing grants: Filesystem, Shell, Computer Use. */
const MARKS = [LaptopIcon, FolderSimpleIcon, TerminalWindowIcon, CursorClickIcon] as const;

const subscribeNoop = () => () => {};

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(COMPUTER_PROMO_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

/** Whether the computer slide was dismissed in this browser, and the dismiss. */
export function useComputerPromoDismissed(): [boolean, () => void] {
  // The server and the hydrating render read "dismissed"; the stored flag applies after.
  const stored = useSyncExternalStore(subscribeNoop, readDismissed, () => true);
  const [dismissedNow, setDismissed] = useState(false);
  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      window.localStorage.setItem(COMPUTER_PROMO_DISMISSED_KEY, '1');
    } catch {
      // Private mode or blocked storage: dismissed for this page view only.
    }
  }, []);
  return [stored || dismissedNow, dismiss];
}

/**
 * "Connect your work computer": the computer slide of the sidebar's promo
 * switcher (`project-promo-cards.tsx`). An advertisement, not a status
 * widget: the slide is `null` while the caller's machines load, once they own
 * a paired machine, and on a deployment with computers disabled (the machine
 * list answers 503). Mount it only while the slide is not dismissed, so a
 * dismissed slide reads no machine list. The controls for a paired machine
 * live in the workspace menu's "Your computer" (desktop app).
 *
 * - Desktop app: one click pairs this machine (`desktopComputerConnect`).
 * - Browser: `onOpenConnect` opens the download / CLI dialog. The sidebar owns
 *   that dialog: on a phone the card lives in the sidebar sheet, and closing
 *   the sheet unmounts it together with anything it renders.
 */
export function ComputerPromoSlide({
  projectId,
  onOpenConnect,
  onDismiss,
  children,
}: {
  projectId: string;
  onOpenConnect: () => void;
  onDismiss: () => void;
  children: (slide: PromoSlide | null) => ReactNode;
}) {
  const t = useTranslations('computers');
  const tPromo = useTranslations('computers.promo');
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const paired = useOwnsPairedComputer();
  // `oneClick` is false when the bundled agent cannot run; the dialog offers
  // the CLI. A local pairing this backend does not list is re-paired (`stale`).
  const { desktop, oneClick, stale } = useThisComputerState();
  const connectDesktop = useConnectDesktopComputer(projectId);

  if (!paired.isSuccess || paired.owns || desktop.isPending) return children(null);

  return children({
    id: 'computer',
    marks: MARKS.map((MarkIcon, index) => (
      <PromoMark key={index}>
        <MarkIcon className="size-5" />
      </PromoMark>
    )),
    title: oneClick ? tPromo('titleThis') : tPromo('title'),
    description: tPromo('description'),
    cta: connectDesktop.isPending ? t('connecting') : oneClick ? tPromo('ctaOneClick') : tPromo('cta'),
    dismissLabel: t('dismissPromo'),
    onDismiss,
    pending: connectDesktop.isPending,
    onClick: () => {
      if (oneClick) {
        connectDesktop.mutate({ reauth: stale });
        return;
      }
      onOpenConnect();
      if (isMobile) setOpenMobile(false);
    },
  });
}
