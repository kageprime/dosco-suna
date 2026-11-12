'use client';

/**
 * In-session Connect card, docked above the composer beside
 * `SessionApprovalPrompt` and `SessionAccessPrompt`.
 *
 * An agent runs `kortix connectors connect <app>` and stops: the sign-in it
 * started is a raw provider link, and nothing in Kortix finished the
 * connection when the person came back (2026-11-11). The API records which
 * session asked on the account row (`requesting_session_id`); this card reads
 * those rows (`listSessionConnectRequests`) and finishes each one through
 * `connectionSignInSteps`: the window opens inside the click, the first request
 * records a sign-in that already finished at the provider, and only an
 * unfinished one goes to a new sign-in page. Finalize tells the session that
 * asked, so the agent continues on its own.
 *
 * Shown: every request still to sign in, and each one that connected while
 * this page was open ("Connected as …"). A request that was connected before
 * the page loaded is history and stays hidden.
 */

import {
  connectionSignInSteps,
  listSessionConnectRequests,
  type SessionConnectRequest,
} from '@kortix/sdk';
import { CheckIcon, PlugsConnectedIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from '../../i18n';
import { cn } from '../../lib/utils';
import { runConnectLinkFlow } from '../../internal/hooks/connectors/use-connect-link';
import { ConnectorAppMark } from '../../markdown/setup-links/connector-handshake';
import { Button } from '../../primitives/button';
import Loading from '../../primitives/loading';
import { errorToast } from '../../primitives/toast';

/** While the agent runs, a new request can land at any moment. */
const BUSY_POLL_MS = 8_000;
/** A card whose sign-in the person may finish in another tab. */
const PENDING_POLL_MS = 10_000;

/** Stable id of one request: its account row, or the connector on an older server. */
export function sessionConnectRequestKey(request: SessionConnectRequest): string {
  return request.connection_id ?? request.slug;
}

/**
 * The requests on screen: every pending one, plus those that connected after
 * `seenPending` first saw them pending. Pure; exported for tests.
 */
export function sessionConnectRequestsOnScreen(
  requests: readonly SessionConnectRequest[],
  seenPending: ReadonlySet<string>,
): SessionConnectRequest[] {
  return requests.filter(
    (request) => !request.connected || seenPending.has(sessionConnectRequestKey(request)),
  );
}

export function SessionConnectPrompt({
  projectId,
  sessionId,
  busy,
  onDockedChange,
}: {
  projectId: string;
  sessionId: string;
  /** The agent is running: poll faster, and read again when it stops. */
  busy: boolean;
  /** True while a card is on screen: the composer docks onto it. */
  onDockedChange?: (docked: boolean) => void;
}) {
  const seenPending = useRef(new Set<string>());
  const query = useQuery({
    queryKey: ['session-connect-requests', projectId, sessionId],
    queryFn: () => listSessionConnectRequests(projectId, sessionId),
    enabled: Boolean(projectId && sessionId),
    staleTime: 2_000,
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: (state) =>
      busy
        ? BUSY_POLL_MS
        : (state.state.data ?? []).some((request) => !request.connected)
          ? PENDING_POLL_MS
          : false,
  });
  const { refetch } = query;
  // The agent stops right after it starts a sign-in: read once more then.
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) void refetch();
    wasBusy.current = busy;
  }, [busy, refetch]);

  const requests = query.data ?? [];
  for (const request of requests) {
    if (!request.connected) seenPending.current.add(sessionConnectRequestKey(request));
  }
  const shown = sessionConnectRequestsOnScreen(requests, seenPending.current);
  const docked = shown.length > 0;
  useEffect(() => {
    onDockedChange?.(docked);
  }, [docked, onDockedChange]);
  useEffect(() => () => onDockedChange?.(false), [onDockedChange]);

  if (!docked) return null;
  return (
    <SessionConnectNotice
      requests={shown}
      projectId={projectId}
      onSettled={() => void refetch()}
    />
  );
}

/** The card itself: one row per request. */
export function SessionConnectNotice({
  requests,
  projectId,
  onSettled,
}: {
  requests: readonly SessionConnectRequest[];
  projectId: string;
  onSettled: () => void;
}) {
  const t = useTranslations('connectSignIn');
  const allConnected = requests.every((request) => request.connected);
  return (
    // `w-full`, or the composer's `items-center` strip shrinks this to its content width.
    <div className="relative isolate z-10 w-full" data-testid="session-connect-prompt">
      <div className="text-muted-foreground flex min-h-6 items-center gap-1.5 px-3 py-1 text-xs">
        <PlugsConnectedIcon
          className={cn('size-3.5 shrink-0', allConnected ? 'text-kortix-green' : 'text-kortix-orange')}
        />
        <span className="min-w-0 truncate">{allConnected ? t('signInFinished') : t('cardHeadline')}</span>
      </div>
      <ul className="flex flex-col gap-1 px-3 pt-0.5 pb-2.5">
        {requests.map((request) => (
          <SessionConnectRow
            key={sessionConnectRequestKey(request)}
            request={request}
            projectId={projectId}
            onSettled={onSettled}
          />
        ))}
      </ul>
    </div>
  );
}

function SessionConnectRow({
  request,
  projectId,
  onSettled,
}: {
  request: SessionConnectRequest;
  projectId: string;
  onSettled: () => void;
}) {
  const t = useTranslations('connectSignIn');
  const [phase, setPhase] = useState<'idle' | 'waiting'>('idle');
  const name = request.name?.trim() || request.app || request.slug;
  const shared = request.owner_type === 'project';

  const connect = async () => {
    if (!request.connection_id) return;
    setPhase('waiting');
    try {
      const steps = connectionSignInSteps(projectId, request.slug, {
        connection_id: request.connection_id,
        owner_type: request.owner_type ?? 'member',
      });
      await runConnectLinkFlow(steps.start, steps.finalize);
    } catch (error) {
      errorToast(error instanceof Error && error.message ? error.message : t('cardFailed', { app: name }));
    } finally {
      setPhase('idle');
      onSettled();
    }
  };

  return (
    <li
      className="border-border flex min-w-0 items-center gap-3 rounded-sm border px-3 py-2"
      data-testid="session-connect-row"
      data-connected={request.connected || undefined}
    >
      <ConnectorAppMark
        name={name}
        slug={request.slug}
        iconUrl={`https://logos.composio.dev/api/${encodeURIComponent(request.app || request.slug)}`}
        size="md"
      />
      <div className="min-w-0 flex-1">
        <p className="text-foreground truncate text-sm font-medium">{t('cardTitle', { app: name })}</p>
        <p className="text-muted-foreground truncate text-xs">
          {request.connected
            ? request.connected_as
              ? t('connectedAs', { account: request.connected_as })
              : t('connected')
            : phase === 'waiting'
              ? t('signingIn', { app: name })
              : shared
                ? t('cardShared')
                : t('cardPrivate')}
        </p>
      </div>
      {request.connected ? (
        <CheckIcon weight="bold" className="text-kortix-green size-4 shrink-0" aria-label={t('connected')} />
      ) : (
        <Button
          type="button"
          size="sm"
          className="shrink-0"
          disabled={phase === 'waiting' || !request.connection_id}
          onClick={() => void connect()}
        >
          {phase === 'waiting' ? <Loading className="size-4 shrink-0" /> : null}
          {t('connect')}
        </Button>
      )}
    </li>
  );
}
