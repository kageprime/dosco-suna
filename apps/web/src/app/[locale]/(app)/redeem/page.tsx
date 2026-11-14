'use client';

/**
 * `/redeem?code=FRONTIER` — the link a campaign shares.
 *
 * A signed-out visitor goes through `/auth` and comes back here, so one link
 * serves a new sign-up and an existing user. The code arrives prefilled; the
 * person confirms with one click, so opening a link never spends a code by
 * itself. The credits go to the caller's primary account (the API's default
 * when no `account_id` is sent). Other accounts redeem from their Credits pane.
 */

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState, useSyncExternalStore } from 'react';

import { Button } from '@kortix/ui/button';
import { AuthFrame } from '@kortix/ui/internal/auth/auth-card-shell';
import { AuthPendingScreen, OutcomeTitle } from '@kortix/ui/internal/auth/auth-consent';
import { Rise, StepHeader } from '@kortix/ui/internal/auth/auth-primitives';
import { PROJECT_LANDING_PATH } from '@kortix/ui/internal/lib/onboarding/landing-destination';
import { useAppHome } from '@kortix/ui/internal/lib/onboarding/use-app-home';
import type { RedeemCreditCodeResult } from '@kortix/sdk';
import { dollarsToCredits, formatCredits } from '@kortix/shared';
import { RedeemCodeForm } from '@/features/billing/redeem-code-form';
import { useAuth } from '@/features/providers/auth-provider';
import { useSignedOutRedirect } from '@/lib/auth/use-signed-out-redirect';
import { useLocale, useTranslations } from '@/i18n/use-translations';

const subscribeToNothing = () => () => {};

function RedeemContent() {
  const t = useTranslations('billing.redeem');
  const locale = useLocale();
  const searchParams = useSearchParams();
  const code = searchParams.get('code') ?? '';
  const { user, isLoading: authLoading } = useAuth();
  const appHome = useAppHome();
  // `appHome` comes from a cookie: the server snapshot keeps the first render
  // equal to the server's (same as the invite page).
  const homeHref = useSyncExternalStore(subscribeToNothing, () => appHome, () => PROJECT_LANDING_PATH);
  const [result, setResult] = useState<RedeemCreditCodeResult | null>(null);

  useSignedOutRedirect();

  if (authLoading || !user) return <AuthPendingScreen footer={false} art={false} />;

  if (result) {
    const credits = formatCredits(dollarsToCredits(result.amount_usd), { locale });
    const balance = formatCredits(dollarsToCredits(result.balance), { locale });
    return (
      <AuthFrame footerVariant="none" art={false}>
        <Rise>
          <StepHeader
            title={<OutcomeTitle tone="success">{t('successTitle', { credits })}</OutcomeTitle>}
            description={t('successDescription', { balance })}
          />
        </Rise>
        <Rise delay={0.06}>
          <Button asChild size="lg" className="w-full">
            <Link href={homeHref} replace prefetch>
              {t('openKortix')}
            </Link>
          </Button>
        </Rise>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame footerVariant="none" art={false}>
      <Rise>
        <StepHeader title={t('pageTitle')} description={t('pageDescription')} />
      </Rise>
      <Rise delay={0.06} className="space-y-3">
        <RedeemCodeForm initialCode={code} autoFocus={!code} size="lg" onRedeemed={setResult} />
        <Button asChild size="lg" variant="secondary" className="w-full">
          <Link href={homeHref} replace prefetch>
            {t('backToKortix')}
          </Link>
        </Button>
      </Rise>
    </AuthFrame>
  );
}

export default function RedeemPage() {
  // `useSearchParams` needs a Suspense boundary, or Next refuses to prerender.
  return (
    <Suspense fallback={<AuthPendingScreen footer={false} art={false} />}>
      <RedeemContent />
    </Suspense>
  );
}
