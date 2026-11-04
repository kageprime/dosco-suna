'use client';

import { useTranslations } from '../../i18n';

/**
 * Shared quiet surface for the auth sub-flows (forgot / reset password).
 *
 * Mirrors the main `/auth` page: flat content on the plain background — no
 * card — with the Dosco mark above a left-aligned heading, and the legal
 * footer pinned to the bottom.
 */

import { CaretLeftIcon as ChevronLeft } from '@phosphor-icons/react';
import { m, useReducedMotion } from 'motion/react';
import { UiLink as Link } from '../../providers/ui-provider';

import { useDesktopBackTarget } from '../desktop/desktop-back-button';
import { KortixLogo } from '../../primitives/kortix-logo';
import { AuthMobileLogo } from './auth-primitives';
import { openExternalRoute } from '../lib/desktop';

const EASE = [0.23, 1, 0.32, 1] as const;

/** Which sentence the legal line uses. */
export type AuthLegalFooterVariant = 'default' | 'signup' | 'continue';

/** Tiny legal line pinned to the bottom of every auth surface. */
export function AuthLegalFooter({ variant = 'default' }: { variant?: AuthLegalFooterVariant }) {
  const t = useTranslations('auth');
  const onLegalClick = (event: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    if (openExternalRoute(href)) event.preventDefault();
  };
  const terms = (
    <Link
      href="/legal/terms"
      onClick={(event) => onLegalClick(event, '/legal/terms')}
      className="hover:text-foreground transition-colors"
    >
      {t('termsOfService')}
    </Link>
  );
  const privacy = (
    <Link
      href="/legal?tab=privacy"
      onClick={(event) => onLegalClick(event, '/legal?tab=privacy')}
      className="hover:text-foreground transition-colors"
    >
      {t('privacyPolicy')}
    </Link>
  );

  return (
    <footer className="text-muted-foreground mx-auto max-w-[380px] px-6 pb-10 text-center text-sm text-balance">
      {variant === 'continue'
        ? t.rich('byContinuingYouAgree', {
            termsOfService: () => terms,
            privacyPolicy: () => privacy,
          })
        : variant === 'signup'
          ? t.rich('unified.legal.signup', {
              termsOfService: () => terms,
              privacyPolicy: () => privacy,
            })
          : t.rich('unified.legal.default', {
              termsOfService: () => terms,
              privacyPolicy: () => privacy,
            })}
    </footer>
  );
}

/**
 * The quiet page frame every auth surface shares: mark, centered column, legal
 * footer. The frame has no sidebar and many of its screens have no in-page
 * exit; the root layout's `DesktopBackButton` is their exit on the desktop
 * shell. `backHref` tells that Back where this flow started.
 */
export function AuthFrame({
  children,
  footerVariant = 'default',
  backHref,
  showShowcase,
}: {
  children: React.ReactNode;
  /**
   * `none` drops the legal line. Reserve it for frames whose resolved screen is
   * not an auth surface — on a real auth flow the footer stays pinned so the
   * page does not jump when the column above it swaps.
   */
  footerVariant?: AuthLegalFooterVariant | 'none';
  /**
   * Where Back goes, when the page knows where its flow started. Without it,
   * Back returns to the previous in-app page, else the app home.
   */
  backHref?: string;
  /**
   * Whether to render the inspirational sovereign showcase split-panel on desktop.
   * Defaults to true whenever footerVariant !== 'none'.
   */
  showShowcase?: boolean;
}) {
  useDesktopBackTarget(backHref);
  const enableShowcase = showShowcase ?? (footerVariant !== 'none');

  if (enableShowcase) {
    return (
      <div className="bg-background relative flex min-h-svh w-full flex-col overflow-hidden lg:grid lg:grid-cols-12">
        {/* Ambient atmospheric backdrop for mobile & left column */}
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(rgba(0,0,0,0.03)_1px,transparent_1px)] dark:bg-[radial-gradient(rgba(255,255,255,0.05)_1px,transparent_1px)] [background-size:24px_24px] lg:col-span-5" />
        <div className="pointer-events-none absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[380px] h-[380px] rounded-full bg-gradient-to-b from-red-500/10 via-orange-500/5 to-transparent blur-3xl lg:hidden" />

        {/* Left Column: Focused Elevated Authentication Portal */}
        <div className="relative z-10 flex min-h-svh flex-1 flex-col justify-between px-6 py-12 sm:px-10 lg:col-span-5 xl:col-span-5 lg:px-12">
          <AuthMobileLogo />
          <main className="flex flex-1 flex-col items-center justify-center my-auto py-8 w-full">
            <div className="w-full max-w-[420px] rounded-2xl border border-border/80 bg-card/75 dark:bg-card/45 backdrop-blur-xl p-8 sm:p-10 shadow-[0_12px_40px_rgba(0,0,0,0.05)] dark:shadow-[0_20px_50px_rgba(0,0,0,0.4)] transition-all">
              {children}
            </div>
          </main>
          {footerVariant === 'none' ? null : <AuthLegalFooter variant={footerVariant} />}
        </div>

        {/* Right Column: Sovereign Architectural Showcase */}
        <aside className="relative hidden lg:col-span-7 xl:col-span-7 lg:flex flex-col justify-between overflow-hidden border-l border-white/[0.08] bg-[#080808] p-12 xl:p-16 text-white selection:bg-red-500/30 selection:text-white">
          {/* Background dot lattice & atmospheric ambient fire blooms */}
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(rgba(255,255,255,0.07)_1px,transparent_1px)] [background-size:24px_24px]" />
          <div className="pointer-events-none absolute -top-32 -right-32 h-[420px] w-[420px] rounded-full bg-gradient-to-br from-red-600/20 via-orange-500/10 to-transparent blur-3xl" />
          <div className="pointer-events-none absolute -bottom-20 left-10 h-80 w-80 rounded-full bg-gradient-to-tr from-red-500/15 via-orange-600/5 to-transparent blur-3xl" />

          {/* Top Status Header */}
          <div className="relative z-10 flex items-center justify-between">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-1.5 text-xs font-mono tracking-wider text-neutral-300 backdrop-blur-md">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              SOVEREIGN AGENT HARNESS
            </div>
            <span className="font-mono text-xs tracking-wider text-neutral-300">
              DOSCO TEK · COMPANYOS
            </span>
          </div>

          {/* Center Manifesto & Live Telemetry Card */}
          <div className="relative z-10 my-auto max-w-xl py-10">
            <h2 className="text-3xl font-semibold tracking-tight text-white xl:text-4xl leading-tight">
              The harness that powers companies that run agents.
            </h2>
            <p className="mt-4 text-base leading-relaxed text-neutral-400 xl:text-lg">
              Sovereign cloud execution, persistent workspace drives, and zero-leak orchestration.
              Built for high-agency teams who demand total ownership.
            </p>

            {/* Live Agent Telemetry Card */}
            <div className="mt-8 rounded-xl border border-white/10 bg-black/70 p-5 font-mono text-xs text-neutral-300 shadow-2xl backdrop-blur-md">
              <div className="mb-3 flex items-center justify-between border-b border-white/10 pb-3 text-neutral-300">
                <div className="flex items-center gap-2">
                  <div className="flex gap-1.5">
                    <div className="size-2.5 rounded-full bg-red-500/80" />
                    <div className="size-2.5 rounded-full bg-amber-500/80" />
                    <div className="size-2.5 rounded-full bg-emerald-500/80" />
                  </div>
                  <span className="ml-2 font-mono text-neutral-200">dosco-runtime · v2.4</span>
                </div>
                <span className="font-semibold tracking-wider text-[10px] text-emerald-400">
                  HEROKU · E2B DYNOS
                </span>
              </div>
              <div className="space-y-2 text-[11px] leading-relaxed">
                <div className="flex items-center gap-2 text-neutral-300">
                  <span className="text-red-400 font-bold">❯</span>
                  <span>System agent:</span>
                  <span className="font-medium text-white">Orchestrator (&quot;The Orc&quot;)</span>
                  <span className="text-emerald-400">[ONLINE]</span>
                </div>
                <div className="flex items-center gap-2 text-neutral-300">
                  <span className="text-red-400 font-bold">❯</span>
                  <span>Default workspace:</span>
                  <span className="font-medium text-white">Xera (@xera)</span>
                  <span className="text-neutral-300">xera@dosco.live</span>
                </div>
                <div className="flex items-center gap-2 text-neutral-300">
                  <span className="text-red-400 font-bold">❯</span>
                  <span>Sandbox execution:</span>
                  <span className="text-neutral-200">E2B cloud microVM isolation</span>
                </div>
                <div className="flex items-center gap-2 text-neutral-300">
                  <span className="text-red-400 font-bold">❯</span>
                  <span>Storage provider:</span>
                  <span className="text-neutral-200">Supabase sovereign drive volumes</span>
                </div>
              </div>
            </div>
          </div>

          {/* Bottom Architectural Pillars */}
          <div className="relative z-10 grid grid-cols-3 gap-6 border-t border-white/10 pt-6 font-mono text-xs text-neutral-400">
            <div>
              <div className="text-sm font-medium text-white">Sovereign Cloud</div>
              <div className="mt-1 text-[11px] text-neutral-300">Zero vendor lock-in</div>
            </div>
            <div>
              <div className="text-sm font-medium text-white">Persistent Drives</div>
              <div className="mt-1 text-[11px] text-neutral-300">Decoupled volumes</div>
            </div>
            <div>
              <div className="text-sm font-medium text-white">Full Ownership</div>
              <div className="mt-1 text-[11px] text-neutral-300">End-to-end agency</div>
            </div>
          </div>
        </aside>
      </div>
    );
  }

  return (
    <div className="bg-background relative flex min-h-svh flex-col overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(rgba(0,0,0,0.03)_1px,transparent_1px)] dark:bg-[radial-gradient(rgba(255,255,255,0.05)_1px,transparent_1px)] [background-size:24px_24px]" />
      <AuthMobileLogo />
      <main className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 py-24">
        <div className="w-full max-w-[420px] rounded-2xl border border-border/80 bg-card/75 dark:bg-card/45 backdrop-blur-xl p-8 sm:p-10 shadow-[0_12px_40px_rgba(0,0,0,0.05)] dark:shadow-[0_20px_50px_rgba(0,0,0,0.4)]">
          {children}
        </div>
      </main>
      {footerVariant === 'none' ? null : <AuthLegalFooter variant={footerVariant} />}
    </div>
  );
}

export function AuthCardShell({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  /** Optional footer below the content (e.g. a "Back to sign in" link). */
  footer?: React.ReactNode;
}) {
  const prefersReducedMotion = useReducedMotion();
  const rise = (delay = 0) => ({
    initial: { opacity: 0, y: prefersReducedMotion ? 0 : 8 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.3, delay, ease: EASE },
  });

  return (
    <AuthFrame>
      <m.div {...rise(0)}>
        <div className="mb-8">
          <div className="hidden md:block">
            <KortixLogo variant="icon" size={24} className="text-foreground" />
          </div>
          <h1 className="text-foreground text-2xl font-semibold tracking-tight text-balance md:mt-6">
            {title}
          </h1>
          <p className="text-muted-foreground mt-2 text-sm text-pretty">{description}</p>
        </div>
      </m.div>

      <m.div {...rise(0.06)}>
        {children}
        {footer ? <div className="mt-8">{footer}</div> : null}
      </m.div>
    </AuthFrame>
  );
}

/** Consistent "Back to sign in" link used across the auth sub-flows. */
export function BackToSignIn() {
  const t = useTranslations('auth');
  return (
    <Link
      href="/auth"
      className="text-muted-foreground hover:text-foreground -m-2 inline-flex items-center gap-1 rounded-sm p-2 text-sm transition-colors"
    >
      <ChevronLeft className="size-4" />
      {t('backToSignIn')}
    </Link>
  );
}
