'use client';

import { PROD_TARGET, setupPromptFor, setupTarget, type SetupTarget } from '@kortix/shared/setup-guide';
import { track } from '@/lib/track';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';

import { COPY_GUIDE_ATTR, useCopyGuide } from './copy-guide';
import { Claude } from '@kortix/ui/internal/icons/claude';
import { SolidCheckIcon } from '@kortix/ui/internal/icons/solid-check-icon';
import { Kbd } from '@kortix/ui/kbd';
import { Codex } from '@kortix/ui/internal/icons/codex';
import { cn } from '@kortix/ui';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

const COPIED_MS = 2000;

const noSubscription = () => () => {};

/**
 * The deployment this page is served from: a prompt copied on dev.kortix.com or
 * localhost points at that deployment's own guide, so it is testable there.
 * The server render uses production; the browser corrects it after hydration.
 */
export function useSetupTarget(): SetupTarget {
  const origin = useSyncExternalStore(noSubscription, () => window.location.origin, () => PROD_TARGET.origin);
  return useMemo(() => setupTarget(origin), [origin]);
}

/**
 * The page is always dark, whatever theme the reader picked elsewhere on the
 * site. The wrapper wears `.dark`, and while the page is mounted the root
 * element does too, so the overscroll area, the scrollbars and every portal
 * (menus, tooltips) are dark as well. The reader's stored choice is never
 * changed; leaving the page puts the root back as it was.
 */
export function useForceDarkPage() {
  useEffect(() => {
    const root = document.documentElement;
    const hadDark = root.classList.contains('dark');
    const hadLight = root.classList.contains('light');
    const scheme = root.style.colorScheme;
    const apply = () => {
      if (!root.classList.contains('dark')) root.classList.add('dark');
      if (root.classList.contains('light')) root.classList.remove('light');
      if (root.style.colorScheme !== 'dark') root.style.colorScheme = 'dark';
    };
    apply();
    // The theme provider rewrites the root class when the theme changes: put dark back.
    const observer = new MutationObserver(apply);
    observer.observe(root, { attributes: true, attributeFilter: ['class', 'style'] });
    return () => {
      observer.disconnect();
      root.classList.toggle('dark', hadDark);
      root.classList.toggle('light', hadLight);
      root.style.colorScheme = scheme;
    };
  }, []);
}

export function useCopy(text: string) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  /** True once the text is on the clipboard. */
  const copy = async (): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return false; // Nothing reached the clipboard: claim nothing.
    }
    flash();
    return true;
  };
  /** Shows the copied state without writing to the clipboard: another button already did. */
  const flash = () => {
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };
  return { copied, copy, flash };
}

/**
 * The page's one action: copy the setup prompt. A light pill on the dark page,
 * the copy mark turning into a check for two seconds once the text is on the clipboard.
 */
/** The key that copies the prompt from anywhere on the page. */
const COPY_KEY = 'c';
/** Set on <html> while the copy key is held: every key chip on the page shows it pressed. */
const KEY_DOWN_ATTR = 'copyKey';
/** Fired once the key copied the prompt: buttons that show the key but do not own it show "copied" too. */
const KEY_COPIED_EVENT = 'loopmaxxing:key-copied';

/** True when a key press belongs to something the reader is typing into. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export function CopyButton({
  size = 'md',
  variant = 'primary',
  text,
  label = 'Copy prompt',
  icon = 'none',
  bindKey = true,
  className,
}: {
  /** `sm` is for the header only, as on the site navbar. */
  size?: 'sm' | 'md';
  /** The landing button's variants: `primary` is the page's main action. */
  variant?: 'primary' | 'secondary';
  text?: string;
  label?: string;
  /** What follows the label: nothing (a check once copied), or the page-wide key that copies (only one button should take it). */
  icon?: 'none' | 'shortcut';
  /** With `icon="shortcut"`: false shows the key without listening for it, so a second button can show it while one button owns it. */
  bindKey?: boolean;
  className?: string;
}) {
  const target = useSetupTarget();
  const prompt = text ?? setupPromptFor(target);
  const { copied, copy: write, flash } = useCopy(prompt);
  const guide = useCopyGuide();
  // Every copy opens the page's guide: where to paste the prompt next.
  const copy = async (method: 'button' | 'key' = 'button') => {
    if (!(await write())) return;
    // A template prompt names its template (loopPrompt): "The template is <id>."
    const template = /The template is ([a-z0-9-]+)\./.exec(prompt)?.[1] ?? 'none';
    track('setup_prompt_copied', { template, method, location: window.location.pathname });
    guide?.open(prompt);
  };
  const copyRef = useRef(copy);
  const flashRef = useRef(flash);
  useEffect(() => {
    copyRef.current = copy;
    flashRef.current = flash;
  });
  useEffect(() => {
    if (icon !== 'shortcut') return;
    if (!bindKey) {
      const onCopied = () => flashRef.current();
      window.addEventListener(KEY_COPIED_EVENT, onCopied);
      return () => window.removeEventListener(KEY_COPIED_EVENT, onCopied);
    }
    const root = document.documentElement;
    const release = () => delete root.dataset[KEY_DOWN_ATTR];
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== COPY_KEY || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      // The guide is open: the key does not copy again under it.
      if (document.querySelector(`[${COPY_GUIDE_ATTR}]`)) return;
      event.preventDefault();
      root.dataset[KEY_DOWN_ATTR] = 'down';
      if (event.repeat) return;
      void copyRef.current('key').then(() => window.dispatchEvent(new Event(KEY_COPIED_EVENT)));
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === COPY_KEY) release();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', release);
      release();
    };
  }, [icon, bindKey]);
  const key = size === 'sm' ? 'size-4' : 'size-5';
  return (
    <MarketingButton
      type="button"
      variant={variant}
      size={size}
      onClick={() => void copy()}
      aria-keyshortcuts={icon === 'shortcut' ? COPY_KEY.toUpperCase() : undefined}
      // The key sits as far from the right edge as from the top and bottom: (h-10 - size-5) / 2.
      className={cn(
        size === 'md' ? 'hit-area-y-1' : 'hit-area-y-2',
        // A phone has no C key: the chip shows from `sm` up.
        icon === 'shortcut' && (size === 'sm' ? 'sm:pr-2' : 'sm:pr-2.5'),
        // Held key: the button dims as under a press, the chip sinks one pixel (color only with reduced motion).
        icon === 'shortcut' && 'in-data-[copy-key=down]:opacity-85',
        className,
      )}
    >
      {/* The label never changes; the trailing mark turns into a check, and a reader hears "Copied". */}
      <span>{label}</span>
      <span aria-live="polite" className="sr-only">
        {copied ? 'Copied' : ''}
      </span>
      {icon === 'none' && copied ? <SolidCheckIcon aria-hidden className="size-4" /> : null}
      {icon === 'shortcut' ? copied ? <SolidCheckIcon aria-hidden className={cn(key, 'shrink-0')} /> : <Kbd
            className={cn(
              'border-none bg-background/20 font-sans duration-fast text-inherit max-sm:hidden transition-[translate,background-color] in-data-[copy-key=down]:translate-y-px in-data-[copy-key=down]:bg-background/45 motion-reduce:in-data-[copy-key=down]:translate-y-0',
              key,
            )}
          >{COPY_KEY.toUpperCase()}</Kbd> : null}
    </MarketingButton>
  );
}

/** A plain link in the header, as the site navbar draws Sign in: the landing button's secondary variant. */
export function GhostButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <MarketingButton variant="secondary" asChild>
      <Link href={href}>{children}</Link>
    </MarketingButton>
  );
}

/** A product name with its mark, inline in running text (founder call 2026-11-10: Claude and Codex show their logos). */
export function Mark({ name }: { name: 'Claude' | 'Codex' | 'Claude Code' }) {
  const Icon = name === 'Codex' ? Codex : Claude;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <Icon className="size-[1em] shrink-0" />
      {name}
    </span>
  );
}
