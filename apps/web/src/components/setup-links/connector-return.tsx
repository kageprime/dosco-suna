'use client';

import { Alert as BannerAlert, AlertMedia as BannerAlertMedia, AlertTitle as BannerAlertTitle } from '@kortix/ui/alert';
import { Button } from '@kortix/ui/button';
import { StepHeader } from '@kortix/ui/internal/auth/auth-primitives';
import { ConnectorHandshake } from '@kortix/ui/markdown/setup-links/connector-handshake';
import { WarningIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useEffect } from 'react';
import { useTranslations } from '@/i18n/use-translations';

/** What the API's OAuth callback put on the URL (`nativeOAuth2CallbackResponse`). */
export interface ConnectorReturnParams {
  ok: boolean;
  errorCode: string | null;
  app: string | null;
  /** A slug in `public/connector-icons/`; anything else is dropped. */
  icon: string | null;
}

export function readConnectorReturnParams(search: URLSearchParams): ConnectorReturnParams {
  const icon = search.get('icon');
  const app = search.get('app')?.trim().slice(0, 80) || null;
  return {
    ok: search.get('oauth2') === 'connected',
    errorCode: search.get('oauth2_error'),
    app,
    icon: icon && /^[a-z0-9-]{1,64}$/.test(icon) ? icon : null,
  };
}

/** A sign-in window Kortix opened closes itself once the result has been read. */
const CLOSE_AFTER_MS = 1800;

/**
 * Where a connector sign-in with no return page of its own lands: an agent's
 * raw connect link, the CLI, or the sign-in window a connect link opened.
 * One mark, one title, one sentence. A window a Kortix page opened closes
 * itself after a success; a tab the person opened stays (`window.close` is a
 * no-op there).
 */
export function ConnectorReturn({ params }: { params: ConnectorReturnParams }) {
  const { ok } = params;

  useEffect(() => {
    if (!ok) return;
    const timer = window.setTimeout(() => window.close(), CLOSE_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [ok]);

  return <ConnectorReturnView params={params} />;
}

/** Stateless, so a harness can render every result side by side. */
export function ConnectorReturnView({
  params: { ok, errorCode, app, icon },
}: {
  params: ConnectorReturnParams;
}) {
  const t = useTranslations('connectSignIn');
  const name = app ?? t('doneFallbackApp');
  const iconUrl = icon ? `/connector-icons/${icon}.svg` : null;

  const reason =
    errorCode === 'access_denied'
      ? 'denied'
      : errorCode === 'invalid_state'
        ? 'expired'
        : 'failed';

  const title = ok
    ? app
      ? t('doneTitle', { app })
      : t('doneTitleNoApp')
    : reason === 'denied'
      ? t('doneDeniedTitle')
      : reason === 'expired'
        ? t('doneExpiredTitle')
        : app
          ? t('doneFailedTitle', { app })
          : t('doneFailedTitleNoApp');

  const description = ok
    ? t('doneDescription', { app: name })
    : reason === 'denied'
      ? t('doneDeniedDescription', { app: name })
      : reason === 'expired'
        ? t('doneExpiredDescription')
        : t('doneFailedDescription');

  return (
    <div data-testid="connector-return" data-result={ok ? 'connected' : 'error'} data-reason={ok ? undefined : reason}>
      <StepHeader
        mark={
          app || icon ? (
            <ConnectorHandshake name={name} iconUrl={iconUrl} connected={ok} size="lg" collapsible={false} />
          ) : undefined
        }
        markOnMobile={Boolean(app || icon)}
        title={title}
        description={description}
      />
      {ok ? (
        <p className="text-muted-foreground text-sm">{t('doneClose')}</p>
      ) : (
        <div className="space-y-4">
          {reason === 'failed' && errorCode ? (
            <BannerAlert variant="destructive">
              <BannerAlertMedia>
                <WarningIcon weight="fill" />
              </BannerAlertMedia>
              <BannerAlertTitle data-testid="connector-return-code">{t('doneErrorCode', { code: errorCode })}</BannerAlertTitle>
            </BannerAlert>
          ) : null}
          <Button asChild variant="outline" className="w-full">
            <Link href="/">{t('doneOpenKortix')}</Link>
          </Button>
        </div>
      )}
    </div>
  );
}
