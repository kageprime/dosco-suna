'use client';

import type { PromoSlide } from './promo-card';
import { PromoMark } from './promo-card';

import { PlusIcon } from '@phosphor-icons/react';
import { useCallback, useState, useSyncExternalStore } from 'react';

import { useSidebar } from '../../../primitives/sidebar';
import { Claude } from '../../../internal/icons/claude';
import { Cursor } from '../../../internal/icons/cursor';
import { OpenAI } from '../../../internal/icons/open-ai';
import { useIsMobile } from '../../../internal/hooks';
import { useTranslations } from '../../../i18n';

export const MCP_PROMO_DISMISSED_KEY = 'kortix.mcp-promo.dismissed';

/** The clients on the card's art row. Product names are identifiers, not UI copy. */
const MARKS = [
  { name: 'Claude', Logo: Claude },
  { name: 'ChatGPT', Logo: OpenAI },
  { name: 'Cursor', Logo: Cursor },
] as const;

const subscribeNoop = () => () => {};

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(MCP_PROMO_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * "Use Kortix in ChatGPT and Claude": the MCP slide of the sidebar's promo
 * switcher (`project-promo-cards.tsx`), shown until dismissed. It sells the
 * MCP server by the chat apps people already use, not by the protocol name.
 * `onOpenConnect` opens `ConnectMcpModal`, which the sidebar owns: on a phone
 * the card unmounts with the sidebar sheet.
 */
export function useMcpPromo(onOpenConnect: () => void): PromoSlide | null {
  const t = useTranslations('sidebar.mcpPromo');
  const tComputers = useTranslations('computers');
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  // The server and the hydrating render read "dismissed"; the stored flag applies after.
  const stored = useSyncExternalStore(subscribeNoop, readDismissed, () => true);
  const [dismissedNow, setDismissed] = useState(false);
  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      window.localStorage.setItem(MCP_PROMO_DISMISSED_KEY, '1');
    } catch {
      // Private mode or blocked storage: dismissed for this page view only.
    }
  }, []);
  if (stored || dismissedNow) return null;

  return {
    id: 'mcp',
    marks: (
      <>
        {MARKS.map(({ name, Logo }) => (
          <PromoMark key={name} label={name}>
            <Logo className="size-5" />
          </PromoMark>
        ))}
        <PromoMark>
          <PlusIcon className="size-5" />
        </PromoMark>
      </>
    ),
    title: t('title'),
    description: t('description'),
    cta: t('cta'),
    dismissLabel: tComputers('dismissPromo'),
    onDismiss: dismiss,
    onClick: () => {
      onOpenConnect();
      if (isMobile) setOpenMobile(false);
    },
  };
}
