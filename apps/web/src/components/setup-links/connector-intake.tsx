'use client';

import { Button } from '@kortix/ui/button';
import { Alert as BannerAlert, AlertTitle as BannerAlertTitle, AlertMedia as BannerAlertMedia } from '@kortix/ui/alert';
import Loading from '@kortix/ui/loading';
import { SessionDotMatrix } from '@kortix/ui/dot-matrix/session-dot-matrix';
import { SolidCheckIcon } from '@kortix/ui/internal/icons/solid-check-icon';
import { StepHeader } from '@kortix/ui/internal/auth/auth-primitives';
import { useLocalizedUiCatalog } from '@kortix/ui/i18n';
import { useTranslations } from '@/i18n/use-translations';
import { useConnectorSetup, type ConnectorSetupPhase } from '@kortix/sdk/react';
import { connectorHeadline } from '@kortix/sdk';
import type { ConnectorSetupLinkInfo } from '@kortix/sdk';
import { ArrowSquareOutIcon, WarningIcon } from '@phosphor-icons/react';
import { useEffect } from 'react';
import { ConnectorAppMark, ConnectorHandshake } from '@kortix/ui/markdown/setup-links/connector-handshake';
import { setupLinkApiBase } from '@kortix/ui/markdown/setup-links/api-base';
import { browserLinkInfoStorage } from '@kortix/ui/markdown/setup-links/util';

const COPY = {
  title: 'Connect {app}',
  titleToProject: 'Connect {app} to {project}',
  readyDescription: 'Your agent asked for access to {app}. You sign in on {app} directly.',
  openedTitle: 'Finish in the new window',
  openedDescription: 'Sign in to {app} in the window that opened. This page updates by itself.',
  waiting: 'Waiting for {app}…',
  reopen: 'Reopen window',
  connectedTitle: '{app} connected',
  alreadyConnectedTitle: '{app} is already connected',
  connectedDescription: 'Your agent can use {app} now and continues on its own.',
  connectedAs: 'Connected as {account}',
  closeTab: 'You can close this tab.',
  errorTitle: 'This link no longer works',
  errorDescription: 'Ask your agent for a new connect link.',
  loading: 'Loading…',
  connect: 'Connect {app}',
  opening: 'Opening…',
  privacy: 'Kortix never sees your password. No key is pasted into chat or stored in the repo.',
  fallbackApp: 'the app',
} as const;

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '');
}

/**
 * Renders 1-click authorization for an agent-minted connect link.
 *
 * Provider-agnostic on purpose. The server decides who brokers the connector —
 * Composio or Pipedream — and hands back whichever hosted page applies; this
 * component only knows "open the url /start returned, then poll". Naming a
 * provider here is what left a Composio connector reading "via Pipedream".
 *
 * On connect we POST /start for a FRESH url, because the durable link must
 * never hand out a stale provider token, and open it in a popup.
 *
 * The popup is on the provider's origin and cannot call back into us, so once
 * it is open we poll POST /finalize — the one call that persists the credential
 * and notifies the session that asked for the connector. The Pipedream connect
 * webhook does the same thing server-side, but only as redundancy; this poll is
 * what tells THIS window it worked. Shared by the public /connect/[token] page
 * and the in-chat modal, so both run the same start/poll/finalize rules.
 *
 * The lifecycle itself — the link-info cache, the start outcome and the bounded
 * finalize poll — lives in `@kortix/sdk` (`useConnectorSetup`, KRTX-1012). This
 * module keeps the presentation and the host adapters: the API base, the
 * browser's storage and the popup window itself.
 */
/**
 * An empty window, opened now, that `useConnectorSetup` sends to the hosted
 * page. Null when the browser blocked it. `noopener` is not passed: with it,
 * `window.open` returns null and the window could not be navigated. The
 * opener is cut by hand instead, before the window leaves this origin.
 */
function reserveSignInWindow() {
  const popup = window.open('', '_blank', 'popup,width=520,height=720');
  if (!popup) return null;
  try {
    popup.opener = null;
  } catch {
    // A read-only `opener` (some WindowProxy implementations).
  }
  return {
    navigate: (url: string) => popup.location.replace(url),
    close: () => {
      try {
        popup.close();
      } catch {
        // A browser policy can refuse close(); the flow result still stands.
      }
    },
  };
}

export function useConnectorIntake(
  token: string,
  { onOpened, returned }: { onOpened?: () => void; returned?: boolean } = {},
) {
  return useConnectorSetup(token, {
    backendUrl: setupLinkApiBase(),
    storage: browserLinkInfoStorage(),
    openPopup: (url) => window.open(url, '_blank', 'noopener,noreferrer,width=520,height=720'),
    // Opened inside the click, before the start request: a window opened after
    // an await is blocked by the browser without a message.
    reservePopup: reserveSignInWindow,
    returned,
    onOpened,
  });
}

export function ConnectorIntake({
  token,
  onOpened,
  onConnected,
  returned,
}: {
  token: string;
  onOpened?: () => void;
  /** Back from the provider's page: finish the sign-in on load. */
  returned?: boolean;
  /** Fired once the finalize poll confirms the connection landed. */
  onConnected?: () => void;
}) {
  const { phase, info, error, connectedAs, alreadyConnected, blockedUrl, connect } = useConnectorIntake(
    token,
    { onOpened, returned },
  );

  useEffect(() => {
    if (phase === 'connected') onConnected?.();
  }, [phase, onConnected]);

  return (
    <ConnectorIntakeView
      phase={phase}
      info={info}
      error={error}
      connectedAs={connectedAs}
      alreadyConnected={alreadyConnected}
      blockedUrl={blockedUrl}
      returned={returned}
      onConnect={connect}
    />
  );
}

/**
 * The page body for each phase of the connect link: the Kortix ··· App
 * handshake as the header mark, one title, one sentence, one action.
 * Stateless, so `/debug/connect` can render every phase side by side.
 */
export function ConnectorIntakeView({
  phase,
  info,
  error,
  connectedAs,
  alreadyConnected,
  blockedUrl = null,
  returned = false,
  onConnect,
}: {
  phase: ConnectorSetupPhase;
  info: ConnectorSetupLinkInfo | null | undefined;
  error: string | null;
  connectedAs: string | null;
  alreadyConnected: boolean;
  /** The hosted page the browser refused to open in a window: shown as a link. */
  blockedUrl?: string | null;
  /** Back from the provider's page: the poll reads as a check, not a wait for a window. */
  returned?: boolean;
  onConnect: () => void;
}) {
  const copy = useLocalizedUiCatalog(COPY);
  const tSignIn = useTranslations('connectSignIn');
  const headline = info ? connectorHeadline(info) : null;
  const app = headline?.app || copy.fallbackApp;
  const connected = phase === 'connected';
  const opened = phase === 'opened';
  const starting = phase === 'starting';
  const failed = phase === 'error';

  // Connected, the handshake gives way to one solid check: the page's whole answer.
  const mark = failed ? null : connected ? (
    <SolidCheckIcon className="text-kortix-green size-10" />
  ) : (
    <ConnectorHandshake
      name={app}
      iconUrl={phase === 'loading' ? undefined : (info?.icon_url ?? null)}
      size="lg"
      collapsible={false}
    />
  );

  const title = failed
    ? copy.errorTitle
    : connected
      ? fill(alreadyConnected ? copy.alreadyConnectedTitle : copy.connectedTitle, { app })
      : opened
        ? blockedUrl
          ? tSignIn('blockedTitle', { app })
          : returned
            ? tSignIn('checkingTitle')
            : copy.openedTitle
        : headline?.project
          ? fill(copy.titleToProject, { app, project: headline.project })
          : fill(copy.title, { app });

  const description = failed
    ? copy.errorDescription
    : connected
      ? fill(copy.connectedDescription, { app })
      : opened
        ? blockedUrl
          ? tSignIn('blockedDescription')
          : returned
            ? tSignIn('checkingDescription', { app })
          : fill(copy.openedDescription, { app })
        : phase === 'loading'
          ? copy.loading
          : fill(copy.readyDescription, { app });

  return (
    <div data-testid="connector-intake" data-phase={phase}>
      <StepHeader
        mark={mark ?? undefined}
        markOnMobile
        title={title}
        description={description}
      />

      {failed ? (
        error ? (
          <BannerAlert variant="destructive" ><BannerAlertMedia>{<WarningIcon weight="fill" />}</BannerAlertMedia><BannerAlertTitle>{error}</BannerAlertTitle></BannerAlert>
        ) : null
      ) : connected ? (
        <div className="bg-muted flex items-center gap-3 rounded-md px-4 py-3">
          <ConnectorAppMark name={app} iconUrl={info?.icon_url ?? null} size="md" />
          <div className="min-w-0">
            <p className="text-foreground truncate text-sm font-medium" data-testid="connector-intake-connected-as">
              {connectedAs ? fill(copy.connectedAs, { account: connectedAs }) : fill(copy.connectedTitle, { app })}
            </p>
            <p className="text-muted-foreground text-xs">{copy.closeTab}</p>
          </div>
        </div>
      ) : opened ? (
        <div className="space-y-3">
          <div className="bg-muted flex items-center gap-3 rounded-md px-4 py-3">
            <Loading className="size-4 shrink-0" />
            <p className="text-foreground text-sm">{fill(copy.waiting, { app })}</p>
          </div>
          {blockedUrl ? (
            // A click on a link is its own user activation, so this opens
            // where the blocked window did not.
            <div data-testid="connector-intake-blocked">
              <Button asChild className="w-full">
                <a href={blockedUrl} target="_blank" rel="noopener noreferrer">
                  <ArrowSquareOutIcon className="size-4" />
                  {tSignIn('openSignIn', { app })}
                </a>
              </Button>
            </div>
          ) : (
            <Button variant="outline-ghost" className="w-full" onClick={onConnect}>
              <ArrowSquareOutIcon className="size-4" />
              {copy.reopen}
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {error ? (
            <BannerAlert variant="destructive" ><BannerAlertMedia>{<WarningIcon weight="fill" />}</BannerAlertMedia><BannerAlertTitle>{error}</BannerAlertTitle></BannerAlert>
          ) : null}
          <Button
            className="w-full"
            onClick={onConnect}
            disabled={starting || phase === 'loading'}
          >
            {starting ? <SessionDotMatrix className="size-4 shrink-0" /> : null}
            {starting ? copy.opening : fill(copy.connect, { app })}
          </Button>
          <p className="text-muted-foreground text-center text-xs text-pretty">{copy.privacy}</p>
        </div>
      )}
    </div>
  );
}
