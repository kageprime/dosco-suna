'use client';

import { Claude } from '@kortix/ui/internal/icons/claude';
import { Codex } from '@kortix/ui/internal/icons/codex';
import { Cursor } from '@kortix/ui/internal/icons/cursor';
import { SolidCheckIcon } from '@kortix/ui/internal/icons/solid-check-icon';
import { Kbd } from '@kortix/ui/kbd';
import { Modal, ModalClose, ModalContent, ModalDescription, ModalTitle } from '@kortix/ui/modal';
import { PlusIcon, ShareFatIcon } from '@phosphor-icons/react';
import { createContext, useCallback, useContext, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import { MarketingButton } from '@/features/marketing/kit/marketing-button';

import { LoopmaxxingWordmark } from './hoop';
import { HOOP_PALETTE } from './hoop-palette';

/** The coding agents the dialog shows, each with its own mark. A "+" closes the row: any agent with a shell runs the prompt. */
const AGENTS: ReadonlyArray<{ name: string; mark: ReactNode }> = [
  { name: 'Claude Code', mark: <Claude className="size-5" /> },
  { name: 'Codex', mark: <Codex className="size-5" /> },
  { name: 'Cursor', mark: <Cursor className="size-5" /> },
  // eslint-disable-next-line @next/next/no-img-element -- a 20px static SVG; next/image adds nothing here
  { name: 'OpenCode', mark: <img src="/provider-icons/opencode.svg" alt="" width={20} height={20} className="size-5 invert" /> },
  // eslint-disable-next-line @next/next/no-img-element -- a 20px static SVG; next/image adds nothing here
  { name: 'pi', mark: <img src="/provider-icons/pi.svg" alt="" width={20} height={20} className="size-5" /> },
];

type CopyGuide = { open: (text: string) => void };

const CopyGuideContext = createContext<CopyGuide | null>(null);

/** Opens the "what now" dialog after a copy. Null outside the provider: the button then only copies. */
export function useCopyGuide(): CopyGuide | null {
  return useContext(CopyGuideContext);
}

/** Set on the dialog while it is open: the page's C key does not copy again under it. */
export const COPY_GUIDE_ATTR = 'data-copy-guide';

/**
 * The page's guide after every Copy prompt: the prompt is on the clipboard,
 * now paste it into a coding agent. One dialog for the whole page; each button
 * opens it with the text it copied. Closing it puts focus back on that button.
 */
export function CopyGuideProvider({ children }: { children: ReactNode }) {
  const [text, setText] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const open = useCallback((copied: string) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setText(copied);
  }, []);
  const touch = useTouchFirst();
  const close = () => {
    setText(null);
    // After the close starts, so the dialog's own focus handling does not take it back.
    requestAnimationFrame(() => opener.current?.focus());
  };
  return (
    <CopyGuideContext.Provider value={{ open }}>
      {children}
      <Modal open={text !== null} onOpenChange={(next) => !next && close()}>
        {/* A full-screen takeover: LOOPMAXXING with its two spinning hoop O's is the centrepiece, then what to do next. */}
        <ModalContent
          {...{ [COPY_GUIDE_ATTR]: '' }}
          showCloseButton={false}
          className="bg-background data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 inset-0 h-dvh max-h-none w-screen max-w-none space-y-0 overflow-y-auto rounded-none! border-0 duration-(--duration-moderate) lg:top-0 lg:left-0 lg:block lg:h-dvh lg:max-w-none lg:translate-x-0 lg:translate-y-0"
        >
          {/* The prompt is already copied: Esc, or a click or tap anywhere, closes it. Only the phone's share action stays. */}
          <ModalClose className="sr-only">Close</ModalClose>
          <div onClick={close} className="flex min-h-full w-full cursor-default flex-col items-center justify-center gap-12 py-16 text-center">
            {/* The word spans about 90% of the screen: its size is a share of the full-width box (cqi), so it fits at every width. */}
            <div className="@container w-full px-6">
              <div className="text-foreground flex justify-center font-mono text-[12.6cqi] leading-none font-medium whitespace-nowrap uppercase">
                <LoopmaxxingWordmark />
              </div>
            </div>
            <div className="flex w-full flex-col items-center gap-5 px-6">
              <ModalTitle className="sr-only">Prompt copied</ModalTitle>
              {/* What is on the clipboard: the prompt itself, one line, with the check. */}
              <div className="bg-card flex max-w-full min-w-0 items-center gap-3 rounded-full sm:max-w-xl py-2.5 pr-5 pl-3">
                <SolidCheckIcon aria-hidden className="size-5.5 shrink-0" style={{ color: HOOP_PALETTE[2] }} />
                <span className="text-muted-foreground min-w-0 truncate font-mono text-sm">{text}</span>
              </div>
              <ModalDescription className="text-muted-foreground text-base">
                {touch ? 'Run it on your computer: send it to yourself.' : 'On your clipboard. Paste it into your coding agent and hit Enter.'}
              </ModalDescription>
            </div>
            <ul className="flex flex-wrap items-center justify-center gap-x-6 gap-y-3 px-6">
              {AGENTS.map((agent) => (
                <li key={agent.name} className="text-foreground inline-flex items-center gap-2 text-sm">
                  <span aria-hidden className="inline-flex shrink-0">
                    {agent.mark}
                  </span>
                  {agent.name}
                </li>
              ))}
              <li className="text-muted-foreground inline-flex items-center">
                <PlusIcon aria-hidden className="size-5" />
                <span className="sr-only">and more</span>
              </li>
            </ul>
            {touch && text !== null ? <SendToYourself /> : null}
            <p className="text-muted-foreground inline-flex items-center gap-1.5 text-sm">
              {touch ? (
                'Tap anywhere to close'
              ) : (
                <>
                  <Kbd>Esc</Kbd> to close
                </>
              )}
            </p>
          </div>
        </ModalContent>
      </Modal>
    </CopyGuideContext.Provider>
  );
}

/** A touch-first device without hover: a phone or a tablet. The prompt runs on a computer, not here. */
function useTouchFirst(): boolean {
  return useSyncExternalStore(
    noSubscription,
    () => window.matchMedia('(pointer: coarse) and (hover: none)').matches,
    () => false,
  );
}

const noSubscription = () => () => {};

/** What the phone sends: the page, and one line on what to do with it. */
const SHARE = {
  title: 'Loopmaxxing',
  text: 'Add a Software Factory to your repo with 1 prompt. Open this on your computer and copy the prompt into Claude Code or Codex.',
};

/**
 * On a phone, the prompt waits for a computer: send the page to yourself. The
 * share sheet reaches Slack, WhatsApp, Messages and Mail. Without one, or when
 * it fails, WhatsApp, Email and Copy link do the same by hand.
 */
function SendToYourself() {
  const [fallback, setFallback] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  // The page itself, without a query or a hash: the link to open on the computer.
  const url = typeof window === 'undefined' ? '' : `${window.location.origin}${window.location.pathname}`;
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const share = async () => {
    try {
      await navigator.share({ ...SHARE, url });
    } catch (error) {
      // The reader closed the sheet: nothing to do. Any other failure: show the links instead.
      if (!(error instanceof DOMException && error.name === 'AbortError')) setFallback(true);
    }
  };
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setLinkCopied(true);
    } catch {
      // The clipboard refused: the other two links still work.
    }
  };
  const message = `${SHARE.text} ${url}`;
  return (
    <div onClick={(event) => event.stopPropagation()} className="flex w-full flex-col items-center gap-3 px-6">
      {canShare && !fallback ? (
        <MarketingButton type="button" variant="primary" size="md" className="hit-area-y-1 w-full max-w-xs" onClick={() => void share()}>
          <ShareFatIcon aria-hidden className="size-4" />
          Send it to yourself
        </MarketingButton>
      ) : (
        <div className="flex w-full max-w-xs flex-col gap-2">
          <MarketingButton variant="primary" size="md" className="hit-area-y-1 w-full" asChild>
            <a href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noopener noreferrer">
              WhatsApp
            </a>
          </MarketingButton>
          <MarketingButton variant="secondary" size="md" className="hit-area-y-1 w-full" asChild>
            <a href={`mailto:?subject=${encodeURIComponent(SHARE.title)}&body=${encodeURIComponent(message)}`}>Email</a>
          </MarketingButton>
          <MarketingButton type="button" variant="secondary" size="md" className="hit-area-y-1 w-full" onClick={() => void copyLink()}>
            {linkCopied ? 'Link copied' : 'Copy link'}
          </MarketingButton>
        </div>
      )}
    </div>
  );
}
