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
import { UiLink as Link } from '../../providers/ui-provider';

import { useDesktopBackTarget } from '../desktop/desktop-back-button';
import { AuthArt } from './auth-art';
import { AuthMobileLogo, Rise, StepHeader } from './auth-primitives';
import { openExternalRoute } from '../lib/desktop';

// The phone-verification page builds its own frame around a sign-out control.
export { AuthArt };

/** Tiny legal line pinned to the bottom of every auth surface: one sentence on every page. */
export function AuthLegalFooter() {
  const t = useTranslations('auth');
  const onLegalClick = (event: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    if (openExternalRoute(href)) event.preventDefault();
  };
  const terms = (
    <Link
      href="/legal/terms"
      onClick={(event) => onLegalClick(event, '/legal/terms')}
      className="hover:text-foreground decoration-border whitespace-nowrap underline underline-offset-2 transition-colors"
    >
      {t('termsOfService')}
    </Link>
  );
  const privacy = (
    <Link
      href="/legal?tab=privacy"
      onClick={(event) => onLegalClick(event, '/legal?tab=privacy')}
      className="hover:text-foreground decoration-border whitespace-nowrap underline underline-offset-2 transition-colors"
    >
      {t('privacyPolicy')}
    </Link>
  );

  return (
    // The same 380px column as the form, so the legal line shares its left
    // edge. A link never breaks inside its name.
    <footer className="text-muted-foreground mx-auto w-full max-w-[380px] pb-8 text-xs text-balance">
      {t.rich('byContinuingYouAgree', {
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
  art,
}: {
  children: React.ReactNode;
  /**
   * The showcase pane beside the form on wide screens. Auth and consent screens
   * keep it; an in-app gate that only borrows this frame (a checkout, a
   * deleted-project notice, an approval card) passes `false`.
   */
  art?: boolean;
  /**
   * `none` drops the legal line. Reserve it for frames whose resolved screen is
   * not an auth surface — on a real auth flow the footer stays pinned so the
   * page does not jump when the column above it swaps.
   */
  footerVariant?: 'default' | 'none';
  /**
   * Where Back goes, when the page knows where its flow started. Without it,
   * Back returns to the previous in-app page, else the app home.
   */
  backHref?: string;
  /**
   * Whether to render the Dosco Deep Forest architectural split-panel on desktop.
   * Defaults to true when art !== false and footerVariant !== 'none'.
   */
  showShowcase?: boolean;
}) {
  useDesktopBackTarget(backHref);
  const enableShowcase = showShowcase ?? (art !== false && footerVariant !== 'none');

  if (enableShowcase) {
    return (
      <div className="bg-background relative flex min-h-svh w-full flex-col overflow-hidden lg:grid lg:grid-cols-12">
        {/* Ambient architectural hairline grid for left paper portal */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 lg:col-span-5"
          style={{
            backgroundImage:
              'linear-gradient(to right, oklch(from var(--border) l c h / 0.5) 1px, transparent 1px), linear-gradient(to bottom, oklch(from var(--border) l c h / 0.5) 1px, transparent 1px)',
            backgroundSize: '48px 48px',
          }}
        />
        <div
          aria-hidden
          className="bg-kortix-base/15 pointer-events-none absolute -top-24 left-1/2 h-[340px] w-[420px] -translate-x-1/2 rounded-full blur-3xl lg:hidden"
        />

        {/* Left Column: Warm Sand Authentication Portal */}
        <div className="relative z-10 flex min-h-svh flex-1 flex-col justify-between px-6 py-10 sm:px-10 lg:col-span-5 xl:col-span-5 lg:px-12">
          <AuthMobileLogo />
          <main className="my-auto flex w-full flex-1 flex-col items-center justify-center py-8">
            <div className="bg-pane border-border w-full max-w-[420px] rounded-xl border p-8 shadow-sm sm:p-10">
              {children}
            </div>
          </main>
          {footerVariant === 'none' ? null : <AuthLegalFooter />}
        </div>

        {/* Right Column: Dosco Deep Forest Architectural Showcase (scoped dark tokens) */}
        <aside className="dark border-border bg-background text-foreground selection:bg-kortix-base/15 relative hidden flex-col justify-between overflow-hidden border-l p-12 lg:col-span-7 lg:flex xl:col-span-7 xl:p-16">
          {/* Architectural grid + forest canopy illumination */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage:
                'linear-gradient(to right, oklch(from var(--border) l c h / 0.55) 1px, transparent 1px), linear-gradient(to bottom, oklch(from var(--border) l c h / 0.55) 1px, transparent 1px)',
              backgroundSize: '48px 48px',
            }}
          />
          <div
            aria-hidden
            className="bg-kortix-base/15 pointer-events-none absolute -top-36 -right-28 h-[460px] w-[460px] rounded-full blur-3xl"
          />
          <div
            aria-hidden
            className="bg-kortix-base/15 pointer-events-none absolute -bottom-24 left-8 h-80 w-80 rounded-full blur-3xl"
          />

          {/* Top Status Header */}
          <div className="relative z-10 flex items-center justify-between">
            <div className="border-border bg-card text-foreground inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 font-mono text-xs tracking-wide backdrop-blur-md">
              <span className="relative flex h-2 w-2">
                <span className="bg-kortix-base absolute inline-flex h-full w-full animate-ping rounded-full opacity-75" />
                <span className="bg-kortix-base relative inline-flex h-2 w-2 rounded-full" />
              </span>
              Agent workspace harness
            </div>
            <span className="text-muted-foreground font-mono text-xs tracking-wide">
              Dosco Tek · Platform
            </span>
          </div>

          {/* Center Editorial Manifesto & Runtime Topology */}
          <div className="relative z-10 my-auto max-w-xl py-10">
            <h2 className="text-foreground font-serif text-2xl leading-tight font-normal tracking-tight">
              The harness that powers companies that run agents.
            </h2>
            <p className="text-muted-foreground mt-4 max-w-lg text-base leading-relaxed">
              Isolated cloud sandboxes, persistent workspace drives, and structured orchestration.
              Built for teams who ship autonomous work end to end.
            </p>

            {/* Runtime Topology Readout */}
            <div className="border-border bg-card text-foreground mt-9 rounded-xl border p-5 font-mono text-xs shadow-xl backdrop-blur-md">
              <div className="border-border mb-3.5 flex items-center justify-between border-b pb-3">
                <div className="flex items-center gap-2.5">
                  <span className="bg-kortix-base size-2 rounded-full" aria-hidden />
                  <span className="text-foreground font-mono">dosco-runtime · session-topology</span>
                </div>
                <span className="text-kortix-base font-mono text-xs font-semibold tracking-wider">
                  E2B · SUPABASE · OPENROUTER
                </span>
              </div>
              <div className="space-y-2.5 text-xs leading-relaxed">
                <div className="text-muted-foreground flex flex-wrap items-center gap-2">
                  <span className="text-kortix-base font-semibold">›</span>
                  <span>Coordinator:</span>
                  <span className="text-foreground font-medium">Xera (@xera)</span>
                  <span className="text-muted-foreground">xera@dosco.live</span>
                  <span className="text-kortix-base">[ONLINE]</span>
                </div>
                <div className="text-muted-foreground flex items-center gap-2">
                  <span className="text-kortix-base font-semibold">›</span>
                  <span>Sandbox compute:</span>
                  <span className="text-foreground">Isolated E2B cloud microVMs</span>
                </div>
                <div className="text-muted-foreground flex items-center gap-2">
                  <span className="text-kortix-base font-semibold">›</span>
                  <span>Drive storage:</span>
                  <span className="text-foreground">Persistent Supabase Storage volumes</span>
                </div>
              </div>
            </div>
          </div>

          {/* Bottom Architectural Pillars */}
          <div className="border-border relative z-10 grid grid-cols-3 gap-6 border-t pt-6">
            <div>
              <div className="text-foreground text-sm font-medium">Isolated Compute</div>
              <div className="text-muted-foreground mt-1 font-mono text-xs">
                Per-task E2B sandboxes
              </div>
            </div>
            <div>
              <div className="text-foreground text-sm font-medium">Persistent Drives</div>
              <div className="text-muted-foreground mt-1 font-mono text-xs">
                Decoupled object volumes
              </div>
            </div>
            <div>
              <div className="text-foreground text-sm font-medium">Model Routing</div>
              <div className="text-muted-foreground mt-1 font-mono text-xs">
                OpenRouter &amp; BYOK keys
              </div>
            </div>
          </div>
        </aside>
      </div>
    );
  }

  return (
    <div className="bg-background relative flex min-h-svh overflow-hidden">
      <div className="relative flex min-h-svh flex-1 flex-col px-6">
        <AuthMobileLogo />
        <main className="flex flex-1 flex-col items-center justify-center py-24">
          <div className="w-full max-w-[380px]">{children}</div>
        </main>
        {footerVariant === 'none' ? null : <AuthLegalFooter />}
      </div>
      {art ? <AuthArt className="sticky top-0 hidden h-svh w-1/2 shrink-0 lg:block" /> : null}
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
  description: React.ReactNode;
  children?: React.ReactNode;
  /** Optional footer below the content (e.g. a "Back to sign in" link). */
  footer?: React.ReactNode;
}) {
  return (
    <AuthFrame>
      <Rise>
        <StepHeader title={title} description={description} />
      </Rise>
      <Rise delay={0.06}>
        {children}
        {footer ? <div className="mt-6">{footer}</div> : null}
      </Rise>
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
