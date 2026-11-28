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
import { AuthFrameContext, AuthFrameHasTopLogoContext, Rise, StepHeader } from './auth-primitives';
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
export function AuthLegalFooter({ centered = false }: { centered?: boolean } = {}) {
  return (
    <footer
      className={cn(
        'text-muted-foreground mx-auto w-full max-w-[380px] pb-6 text-xs text-balance',
        // 12px, one step under the 13px floor: the product owner asked for a quieter legal line on /auth.
        centered && 'text-center text-[0.75rem]', // audit:allow owner-requested 12px legal line
      )}
    >
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
  aside,
  centered = false,
  mark,
}: {
  children: React.ReactNode;
  /** A pane left of the form on wide screens; ignored when a showcase is supplied. */
  aside?: React.ReactNode;
  /** Centers the column, its header and the legal footer. */
  centered?: boolean;
  /** The mark every step header shows by default. */
  mark?: React.ReactNode;
  /**
   * The dither pane beside the form on wide screens. Auth and consent screens
   * keep it; an in-app gate that only borrows this frame passes false.
   */
  art?: boolean;
  footerVariant?: 'default' | 'none';
  backHref?: string;
  showShowcase?: boolean;
  showcase?: React.ReactNode;
}) {
  useDesktopBackTarget(backHref);
  const enableShowcase = showcase
    ? true
    : (showShowcase ?? (art !== false && footerVariant !== 'none'));
  const column = cn('w-full', centered ? 'max-w-[340px]' : 'max-w-[380px]');
  const legal = footerVariant === 'none' ? null : centered ? (
    // Out of flow, so the form centres level with the story pane's headline.
    <div className="absolute inset-x-0 bottom-0 px-6"><AuthLegalFooter centered /></div>
  ) : <AuthLegalFooter />;

  if (enableShowcase) {
    return (
      <AuthFrameHasTopLogoContext.Provider value={true}>
        <AuthFrameContext.Provider value={{ centered, mark }}>
          <div className="bg-background relative flex min-h-svh w-full flex-col lg:grid lg:grid-cols-2">
            <div className="flex min-h-svh flex-col justify-between px-6 py-6 sm:px-10 lg:px-12">
              <AuthTopLogo />
              <main className="my-auto flex w-full flex-1 flex-col items-center justify-center py-8">
                <div className={column}>{children}</div>
              </main>
              {footerVariant === 'none' ? <div className="h-6" aria-hidden /> : legal}
            </div>
            <aside aria-hidden className={cn('hidden lg:sticky lg:top-0 lg:flex lg:h-svh', showcase ? 'p-0' : 'p-4 lg:p-6')}>
              <div className={cn('relative h-full w-full overflow-hidden', showcase ? '' : 'border-border rounded-xl border')}>
                {showcase ?? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src="/images/auth-editorial.jpg" alt="" draggable={false} className="h-full w-full object-cover select-none" />
                )}
              </div>
            </aside>
          </div>
        </AuthFrameContext.Provider>
      </AuthFrameHasTopLogoContext.Provider>
    );
  }

  return (
    <AuthFrameHasTopLogoContext.Provider value={true}>
      <AuthFrameContext.Provider value={{ centered, mark }}>
        <div className="bg-background flex min-h-svh">
          {aside ? <div className="sticky top-0 hidden h-svh w-1/2 shrink-0 lg:block">{aside}</div> : null}
          <div className={cn('relative flex min-h-svh flex-1 flex-col justify-between px-6 py-6 sm:px-10', centered && 'items-center')}>
            <AuthTopLogo />
            <main className="my-auto flex w-full flex-1 flex-col items-center justify-center py-8">
              <div className={column}>{children}</div>
            </main>
            {footerVariant === 'none' ? <div className="h-6" aria-hidden /> : legal}
          </div>
          {art ? <AuthArt className="sticky top-0 hidden h-svh w-1/2 shrink-0 lg:block" /> : null}
        </div>
      </AuthFrameContext.Provider>
    </AuthFrameHasTopLogoContext.Provider>
  );
}

export function AuthCardShell({
  title,
  description,
  children,
  footer,
  frame,
}: {
  title: string;
  description: React.ReactNode;
  children?: React.ReactNode;
  /** Optional footer below the content (e.g. a "Back to sign in" link). */
  footer?: React.ReactNode;
  /**
   * The host's sign-in frame (story pane, centered column, app tile), so a
   * sub-flow matches the page it came from. A centered frame holds still.
   */
  frame?: {
    aside?: React.ReactNode;
    centered?: boolean;
    mark?: React.ReactNode;
  };
}) {
  const body = (
    <>
      {children}
      {footer ? <div className={cn('mt-6', frame?.centered && 'text-center')}>{footer}</div> : null}
    </>
  );
  return (
    <AuthFrame
      aside={frame?.aside}
      centered={frame?.centered}
      mark={frame?.mark}
    >
      {frame?.centered ? (
        <>
          <StepHeader title={title} description={description} />
          {body}
        </>
      ) : (
        <>
          <Rise>
            <StepHeader title={title} description={description} />
          </Rise>
          <Rise delay={0.06}>{body}</Rise>
        </>
      )}
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
