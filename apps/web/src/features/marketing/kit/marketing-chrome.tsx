'use client';

import { roobert } from '@/app/(system)/fonts/roobert';
import { roobertMono } from '@/app/(system)/fonts/roobert-mono';
import { ConsentGate } from '@/components/consent-gate';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { DitherRidge } from '@/features/marketing/kit/dither-ridge';
import { GhostButton } from '@/features/marketing/one-prompt/parts';
import { cn } from '@kortix/ui';
import { Button } from '@kortix/ui/button';
import { ListIcon, XIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';

/** The column every public surface sits in. */
const COLUMN = 'mx-auto w-full max-w-7xl px-6';

/**
 * One link list for the whole public site. The two fold anchors are absolute:
 * on any other page they must return to the landing section, not set a hash on
 * the page the reader is already viewing.
 */
const LINKS = [
  { label: 'Roles', href: '/#roles' },
  { label: 'How it works', href: '/#how' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'Docs', href: '/developers' },
] as const;

/** The one action of the public site: an account. */
function SignUp({ children = 'Create your account', size = 'lg' }: { children?: string; size?: 'default' | 'lg' }) {
  return (
    <Button asChild variant="brand" size={size}>
      <Link href="/auth">{children}</Link>
    </Button>
  );
}

/** The one header. It sticks below the top edge on every public page. */
export function MarketingHeader() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="border-border bg-background/80 sticky top-0 z-30 border-b backdrop-blur">
      <div className={cn(COLUMN, 'flex h-16 items-center justify-between gap-4')}>
        <div className="flex items-center gap-4">
          <Link href="/" aria-label="Dosco" className="text-foreground">
            <KortixLogo size={16} variant="logomark" />
          </Link>
          <span className="text-foreground hidden font-mono text-sm font-medium tracking-wider uppercase sm:inline">
            CompanyOS
          </span>
        </div>
        <nav aria-label="Site" className="text-muted-foreground hidden items-center gap-8 text-sm md:flex">
          {LINKS.map((link) => (
            <Link key={link.href} href={link.href} className="hover:text-foreground">
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <GhostButton href="/auth">Sign in</GhostButton>
          <SignUp size="default">Sign up</SignUp>
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            className="border-border text-foreground hover:bg-accent inline-flex size-9 items-center justify-center rounded-md border transition-colors md:hidden"
          >
            {menuOpen ? <XIcon aria-hidden className="size-4" /> : <ListIcon aria-hidden className="size-4" />}
          </button>
        </div>
      </div>
      {menuOpen ? (
        <nav aria-label="Site menu" className={cn(COLUMN, 'border-border flex flex-col border-t py-2 md:hidden')}>
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setMenuOpen(false)}
              className="text-foreground hover:text-muted-foreground py-2 text-sm transition-colors"
            >
              {link.label}
            </Link>
          ))}
        </nav>
      ) : null}
    </header>
  );
}

/** The one footer: a centered close, the legal links, then the dithered ridge. */
export function MarketingFooter() {
  return (
    <footer className="relative isolate overflow-clip bg-background">
      <div className="relative z-10">
        <div className={cn(COLUMN, 'flex flex-col items-center gap-7 pt-32 pb-24 text-center lg:pt-48')}>
          <h2 className="text-foreground text-4xl tracking-tight text-balance sm:text-5xl lg:text-6xl">
            Your company.
            <br />
            <span className="text-muted-foreground">Your agents.</span>
          </h2>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <SignUp />
            <GhostButton href="/auth">Sign in</GhostButton>
          </div>
          <p className="text-muted-foreground text-sm">Free to start. Bring the model plan you already pay for.</p>
          <nav aria-label="Legal" className="text-muted-foreground flex gap-4 text-sm">
            <Link href="/legal?tab=privacy" className="hover:text-foreground transition-colors">
              Privacy
            </Link>
            <Link href="/legal/terms" className="hover:text-foreground transition-colors">
              Terms
            </Link>
          </nav>
        </div>
      </div>

      {/* The ridge: a spacer, then a field pinned to the bottom edge as the page ends. */}
      <div aria-hidden className="h-[56svh] min-h-[320px]" />
      <div aria-hidden className="pointer-events-none sticky bottom-0 z-0 h-0">
        <div className="absolute inset-x-0 bottom-0 h-[58svh] min-h-[330px] [mask-image:linear-gradient(to_top,#000_72%,transparent)]">
          <DitherRidge />
        </div>
      </div>
    </footer>
  );
}

/**
 * The shell every public page renders. It owns the one consent gate, the one
 * header and the one footer, and it scopes Roobert to this subtree so the
 * product app keeps its own type stack. Page content stays untouched: callers
 * keep their own `<main>` landmark.
 */
export function MarketingChrome({ children }: { children: ReactNode }) {
  return (
    <div
      className={cn(
        roobert.variable,
        roobertMono.variable,
        'font-marketing dark bg-background text-foreground relative min-h-screen overflow-x-clip',
      )}
    >
      <ConsentGate />
      <MarketingHeader />
      {children}
      <MarketingFooter />
    </div>
  );
}
