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
import { KortixLogo } from '../../primitives/kortix-logo';
import { UiLink as Link } from '../../providers/ui-provider';

import { useDesktopBackTarget } from '../desktop/desktop-back-button';
import { AuthArt } from './auth-art';
import { AuthFrameHasTopLogoContext, Rise, StepHeader } from './auth-primitives';
import { openExternalRoute } from '../lib/desktop';
import { cn } from '../lib/utils';

// The phone-verification page builds its own frame around a sign-out control.
export { AuthArt };

/** Inline legal agreement sentence shared by the footer and the entry form container. */
export function AuthLegalCopy({ className }: { className?: string }) {
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
    <p className={className}>
      {t.rich('byContinuingYouAgree', {
        termsOfService: () => terms,
        privacyPolicy: () => privacy,
      })}
    </p>
  );
}

/** Tiny legal line pinned to the bottom of auth sub-flows. */
export function AuthLegalFooter() {
  return (
    <footer className="text-muted-foreground mx-auto w-full max-w-[380px] pb-6 text-xs text-balance">
      <AuthLegalCopy />
    </footer>
  );
}

function AuthTopLogo() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="kx-auth-mobile-logo">
      <Link
        href="/"
        aria-label={tHardcodedUi.raw('i18nComplete.text7ecec93ed268')}
        className="focus-visible:ring-ring inline-flex items-center rounded-sm focus-visible:ring-2 focus-visible:outline-none"
      >
        <KortixLogo variant="brandmark" size={22} className="text-foreground" />
      </Link>
    </div>
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
  showcase,
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
  /**
   * Replaces the showcase photo with a full-bleed panel of the caller's own
   * art (the Dosco Deep Forest on `/auth`). The panel keeps its desktop-only
   * cell; the art fills the cell edge to edge, with no frame or radius.
   */
  showcase?: React.ReactNode;
}) {
  useDesktopBackTarget(backHref);
  const enableShowcase = showcase
    ? true
    : (showShowcase ?? (art !== false && footerVariant !== 'none'));

  if (enableShowcase) {
    return (
      <AuthFrameHasTopLogoContext.Provider value={true}>
        <div className="bg-background relative flex min-h-svh w-full flex-col lg:grid lg:grid-cols-2">
          <div className="flex min-h-svh flex-col justify-between px-6 py-6 sm:px-10 lg:px-12">
            <AuthTopLogo />
            <main className="my-auto flex w-full flex-1 flex-col items-center justify-center py-8">
              <div className="w-full max-w-[380px]">{children}</div>
            </main>
            {footerVariant === 'none' ? <div className="h-6" aria-hidden /> : <AuthLegalFooter />}
          </div>

          <aside
            aria-hidden
            className={cn(
              'hidden lg:sticky lg:top-0 lg:flex lg:h-svh',
              showcase ? 'p-0' : 'p-4 lg:p-6',
            )}
          >
            <div
              className={cn(
                'relative h-full w-full overflow-hidden',
                showcase ? '' : 'border-border rounded-xl border',
              )}
            >
              {showcase ?? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src="/images/auth-editorial.jpg"
                  alt=""
                  draggable={false}
                  className="h-full w-full object-cover select-none"
                />
              )}
            </div>
          </aside>
        </div>
      </AuthFrameHasTopLogoContext.Provider>
    );
  }

  return (
    <AuthFrameHasTopLogoContext.Provider value={true}>
      <div className="bg-background relative flex min-h-svh overflow-hidden">
        <div className="relative flex min-h-svh flex-1 flex-col justify-between px-6 py-6 sm:px-10">
          <AuthTopLogo />
          <main className="my-auto flex flex-1 flex-col items-center justify-center py-8">
            <div className="w-full max-w-[380px]">{children}</div>
          </main>
          {footerVariant === 'none' ? <div className="h-6" aria-hidden /> : <AuthLegalFooter />}
        </div>
        {art ? <AuthArt className="sticky top-0 hidden h-svh w-1/2 shrink-0 lg:block" /> : null}
      </div>
    </AuthFrameHasTopLogoContext.Provider>
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
