'use client';

import { PROD_TARGET, setupPromptFor, setupTarget, type SetupTarget } from '@kortix/shared/setup-guide';
import { Claude } from '@kortix/ui/internal/icons/claude';
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

export function useCopy(text: string) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return; // Nothing reached the clipboard: claim nothing.
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };
  return { copied, copy };
}

export function CopyButton({ size = 'md', text, label = 'Copy the prompt' }: { size?: 'sm' | 'md'; text?: string; label?: string }) {
  const target = useSetupTarget();
  const { copied, copy } = useCopy(text ?? setupPromptFor(target));
  return (
    <button
      type="button"
      onClick={copy}
      className={cn(
        'bg-kortix-base hover:bg-kortix-base/90 rounded-md font-medium text-white transition-colors',
        size === 'md' ? 'h-9 px-4 text-sm' : 'h-8 px-3 text-sm',
      )}
    >
      <span aria-live="polite">{copied ? 'Copied' : label}</span>
    </button>
  );
}

export function GhostButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="border-border bg-card text-foreground hover:bg-accent inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors">
      {children}
    </Link>
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

export function Eyebrow({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground font-mono text-xs tracking-wider uppercase">{children}</span>;
}
