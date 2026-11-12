'use client';

import { useComposerPrefillStore } from '@kortix/ui/internal/stores/composer-prefill-store';
import { errorToast } from '@kortix/ui/toast';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { useTranslations } from '@/i18n/use-translations';

import { usePanelChannel, type PanelContext, type PanelTab } from './panel-channel';
import {
  isReadPage,
  pageAttachment,
  screenshotAttachment,
  withActTab,
  withQuote,
  type PanelMode,
} from './panel-prompt';

/**
 * The panel's send: the prompt (or a quick action's override) with the read
 * page text, the screenshot and the quote as attachments, handed to the
 * project home composer, which sends it exactly like a typed message.
 */
export function usePanelSend({
  text,
  projectId,
  quote,
  tabs,
  mode,
  shot,
  channel,
}: {
  text: string;
  projectId: string | null;
  quote: PanelContext | null;
  tabs: PanelTab[];
  mode: PanelMode;
  shot: boolean;
  channel: ReturnType<typeof usePanelChannel>;
}) {
  const t = useTranslations('chrome.panel');
  const router = useRouter();
  const [sending, setSending] = useState(false);
  // A quick action reads the page whatever the switch says.
  const send = async (override?: string, sendMode: PanelMode = mode) => {
    const body = (override ?? text).trim();
    if (!body || !projectId || sending) return;
    setSending(true);
    try {
      let prompt = quote?.quote ? withQuote(body, quote.quote, quote.tab) : body;
      const readable = tabs.filter((tab) => tab.readable);
      let files: ReturnType<typeof pageAttachment>[] = [];
      if (sendMode === 'act') {
        const tab = readable[0] ?? quote?.tab;
        if (tab?.readable) {
          prompt = withActTab(prompt, tab);
          channel.handAct(tab.id);
        }
      } else if (readable.length) {
        const pages = await channel.readTabs(readable.map((tab) => tab.id));
        const read = pages.filter(isReadPage);
        if (!read.length) throw new Error(t('readFailed'));
        const readAt = new Date();
        files = read.map((page) => pageAttachment(page, readAt));
      }
      if (shot) {
        // Chrome captures the window's visible tab: the one the first chip shows.
        const dataUrl = await channel.capture();
        if (!dataUrl) throw new Error(t('captureFailed'));
        files = [...files, screenshotAttachment(dataUrl, channel.activeTab?.title ?? '', new Date())];
      }
      // Project home sends it as if the person pressed Enter there, then opens the session here.
      // 'when-ready': a one-shot submit on landing is dropped when the composer is still loading.
      useComposerPrefillStore
        .getState()
        .setPrefill(projectId, prompt, { submit: 'when-ready', ...(files.length ? { files } : {}) });
      // nav-contract: prefetch-only — project home consumes the prefill and opens the new session
      router.push(`/workspaces/${projectId}`);
    } catch (error) {
      errorToast(error instanceof Error && error.message ? error.message : t('readFailed'));
      setSending(false);
    }
  };
  return { send, sending };
}
