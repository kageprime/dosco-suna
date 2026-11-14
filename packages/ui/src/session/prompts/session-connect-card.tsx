'use client';

/**
 * The Connect card of a connector sign-in the agent started, drawn in the
 * transcript under the call that started it: `kortix connectors connect <app>`
 * in the shell, or the `kortix_connectors` tool's `connect` (the SDK reads
 * both, `connectorSignInCalls`). The SDK keeps that call out of every fold, so
 * the card stays in view the way a pasted `/connect/<token>` link did.
 *
 * #12500 (2026-11-12) docked this card above the composer. A sign-in the
 * person never finished stayed docked for the life of the session: a person
 * who connected the app another way (the native Supabase connector instead of
 * the Composio toolkit the agent picked) kept the card over the input, with
 * nothing to dismiss it (2026-11-13). In the transcript it stays where the
 * agent asked, scrolls away with its turn, and reads "Connected as …" once done.
 *
 * The API records which session asked on the account row
 * (`requesting_session_id`). `SessionConnectRequestsProvider` reads those rows
 * once per session (`listSessionConnectRequests`); each card picks the ones its
 * call names (`connectorSignInRequests`) and finishes each through
 * `connectionSignInSteps`: the window opens inside the click, the first request
 * records a sign-in that already finished at the provider, and only an
 * unfinished one goes to a new sign-in page. Finalize tells the session that
 * asked, so the agent continues on its own.
 */

import {
  connectionSignInSteps,
  connectorSignInRequests,
  listSessionConnectRequests,
  type ConnectorSignInCall,
  type SessionConnectRequest,
} from '@kortix/sdk';
import { CheckIcon, PlugsConnectedIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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

const NO_REQUESTS: readonly SessionConnectRequest[] = Object.freeze([]);

/** Stable id of one request: its account row, or the connector on an older server. */
export function sessionConnectRequestKey(request: SessionConnectRequest): string {
  return request.connection_id ?? request.slug;
}

interface SessionConnectRequests {
  projectId: string;
  requests: readonly SessionConnectRequest[];
  refetch: () => void;
}

const SessionConnectRequestsContext = createContext<SessionConnectRequests | null>(null);

/**
 * The session's connect requests, read once for every card in its transcript.
 * Without a project and session (a read-only view) it provides nothing, and no
 * call draws a card.
 */
export function SessionConnectRequestsProvider({
  projectId,
  sessionId,
  busy,
  children,
}: {
  projectId: string | null | undefined;
  sessionId: string | null | undefined;
  /** The agent is running: poll faster, and read again when it stops. */
  busy: boolean;
  children: ReactNode;
}) {
  const enabled = Boolean(projectId && sessionId);
  const query = useQuery({
    queryKey: ['session-connect-requests', projectId, sessionId],
    queryFn: () => listSessionConnectRequests(projectId!, sessionId!),
    enabled,
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
  const { refetch, data } = query;
  // The agent stops right after it starts a sign-in: read once more then.
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (enabled && wasBusy.current && !busy) void refetch();
    wasBusy.current = busy;
  }, [busy, enabled, refetch]);

  const value = useMemo<SessionConnectRequests | null>(
    () =>
      enabled && projectId
        ? { projectId, requests: data ?? NO_REQUESTS, refetch: () => void refetch() }
        : null,
    [enabled, projectId, data, refetch],
  );
  return <SessionConnectRequestsContext.Provider value={value}>{children}</SessionConnectRequestsContext.Provider>;
}

/** The session's connect requests, or null outside a session that can finish them. */
export function useSessionConnectRequests(): SessionConnectRequests | null {
  return useContext(SessionConnectRequestsContext);
}

/**
 * The Connect card under a call that started connector sign-ins: one row per
 * request the call names. Nothing when the session holds no such request
 * (another member's private sign-in, an account removed since).
 */
export function SessionConnectCard({
  calls,
  className,
}: {
  calls: readonly ConnectorSignInCall[];
  className?: string;
}) {
  const context = useSessionConnectRequests();
  if (!context || calls.length === 0) return null;
  const requests = connectorSignInRequests(context.requests, calls);
  if (requests.length === 0) return null;
  return (
    <SessionConnectNotice
      requests={requests}
      projectId={context.projectId}
      onSettled={context.refetch}
      className={className}
    />
  );
}

/** The card itself: a headline, then one row per request. */
export function SessionConnectNotice({
  requests,
  projectId,
  onSettled,
  className,
}: {
  requests: readonly SessionConnectRequest[];
  projectId: string;
  onSettled: () => void;
  className?: string;
}) {
  const t = useTranslations('connectSignIn');
  const allConnected = requests.every((request) => request.connected);
  return (
    <div className={cn('w-full', className)} data-testid="session-connect-card">
      <div className="text-muted-foreground flex min-h-6 items-center gap-1.5 py-1 text-xs">
        <PlugsConnectedIcon
          className={cn('size-3.5 shrink-0', allConnected ? 'text-kortix-green' : 'text-kortix-orange')}
        />
        <span className="min-w-0 truncate">{allConnected ? t('signInFinished') : t('cardHeadline')}</span>
      </div>
      <ul className="flex flex-col gap-1 pt-0.5">
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
