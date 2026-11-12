'use client';

/**
 * In-session "My Kortix asks to give a colleague access" card, docked above
 * the composer beside `SessionApprovalPrompt`.
 *
 * My Kortix starts a colleague (a child session) with extra connectors and
 * project secrets only after a person allows that exact list. The API parks
 * the request as a session ask of kind `access`; this card shows it and
 * decides it with `{ decision: 'allow' | 'deny' }`. The decision reaches My
 * Kortix as a message, and on Allow My Kortix starts the colleague itself.
 *
 * What the card shows, so the question can be answered: who asks (My Kortix),
 * the colleague's task, each connector and each secret on its own row with
 * its kind, and the limit (only these, for this one task). Two choices: Deny
 * and Allow. One ask at a time with a `1 / 2` pager, the same chrome as
 * `SessionApprovalNotice`. Review's ask deck renders the same notice.
 */

import type { SessionAsk } from '@kortix/sdk';
import { useAnswerSessionAsk } from '@kortix/sdk/react';
import {
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  KeyIcon,
  PlugsConnectedIcon,
  ShieldWarningIcon,
} from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from '../../i18n';
import { cn } from '../../lib/utils';
import { Button } from '../../primitives/button';
import Loading from '../../primitives/loading';
import { errorToast, successToast } from '../../primitives/toast';

export type AccessDecision = 'allow' | 'deny';

/** The ask being decided and how: its buttons are off while the request runs. */
export interface AccessDeciding {
  askId: string;
  decision: AccessDecision;
}

/**
 * The asks on screen: the open `access` asks, plus the one being decided.
 * `useAnswerSessionAsk` drops a decided ask from the cached list at once; the
 * card keeps it in place until the request settles, so its disabled buttons
 * stay in view. Oldest first. Pure; exported for tests.
 */
export function accessAsksOnScreen(asks: readonly SessionAsk[], deciding: SessionAsk | null): SessionAsk[] {
  const open = asks.filter((ask) => ask.kind === 'access' && ask.access);
  if (!deciding || open.some((ask) => ask.id === deciding.id)) return open;
  return [...open, deciding].sort((a, b) => (a.asked_at < b.asked_at ? -1 : a.asked_at > b.asked_at ? 1 : 0));
}

/**
 * The connected card for one session: decides through the asks API and
 * reports the result in a toast. On a refusal the toast shows the API's own
 * text (a member who allows a connector or secret no workspace agent holds
 * gets "Only a workspace manager can allow it").
 */
export function SessionAccessPrompt({
  projectId,
  asks,
  onDockedChange,
}: {
  projectId: string;
  /** The session's open asks (`useSessionNeedsYou`); only `access` asks render. */
  asks: readonly SessionAsk[];
  /** True while an access ask is on screen: the composer docks onto the card. */
  onDockedChange?: (docked: boolean) => void;
}) {
  const t = useTranslations('hardcodedUi.colleagueAccess');
  const answer = useAnswerSessionAsk(projectId);
  const [current, setCurrent] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<{ ask: SessionAsk; decision: AccessDecision } | null>(null);
  // A second click before the first settles is ignored, not sent twice.
  const decidingRef = useRef(false);

  const shown = accessAsksOnScreen(asks, deciding?.ask ?? null);
  const docked = shown.length > 0;
  useEffect(() => {
    onDockedChange?.(docked);
  }, [docked, onDockedChange]);
  useEffect(() => () => onDockedChange?.(false), [onDockedChange]);

  const decide = (ask: SessionAsk, decision: AccessDecision) => {
    if (decidingRef.current) return;
    decidingRef.current = true;
    setDeciding({ ask, decision });
    answer.mutate(
      { askId: ask.id, answer: { decision } },
      {
        onSuccess: () =>
          successToast(decision === 'allow' ? t('allowed') : t('denied'), {
            description: decision === 'allow' ? t('allowedDescription') : t('deniedDescription'),
          }),
        onError: (cause: unknown) =>
          errorToast(cause instanceof Error && cause.message ? cause.message : t('failed')),
        onSettled: () => {
          decidingRef.current = false;
          setDeciding(null);
        },
      },
    );
  };

  return (
    <SessionAccessNotice
      asks={shown}
      current={deciding?.ask.id ?? current}
      deciding={deciding ? { askId: deciding.ask.id, decision: deciding.decision } : null}
      onSelect={setCurrent}
      onDecide={decide}
    />
  );
}

const ICON_BUTTON_CLASS =
  'text-muted-foreground hover:text-foreground hover:bg-muted hit-area-2 inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors disabled:pointer-events-none disabled:opacity-30';

interface SessionAccessNoticeProps {
  /** Open `access` asks, oldest first. Empty: nothing renders. */
  asks: readonly SessionAsk[];
  /** The ask on screen. Null, or one no longer listed, shows the first. */
  current: string | null;
  /** The ask whose decision is in flight: every button is off. */
  deciding: AccessDeciding | null;
  onSelect: (askId: string) => void;
  onDecide: (ask: SessionAsk, decision: AccessDecision) => void;
}

/**
 * The card itself: no data fetching, no mutation, so every state renders in a
 * test. A quiet `1 / 2 · headline` line collapses the body; the body names
 * the task, lists each connector and secret, states the limit, then Deny and
 * Allow.
 */
export function SessionAccessNotice({ asks, current, deciding, onSelect, onDecide }: SessionAccessNoticeProps) {
  const t = useTranslations('hardcodedUi.colleagueAccess');
  const tCommon = useTranslations('common');
  const [collapsed, setCollapsed] = useState(false);
  const open = asks.filter((ask) => ask.kind === 'access' && ask.access);
  if (open.length === 0) return null;

  const index = Math.max(
    0,
    open.findIndex((ask) => ask.id === current),
  );
  const ask = open[index];
  const access = ask.access!;
  const total = open.length;
  const panelId = `${ask.id}-access-panel`;
  const busy = deciding !== null;
  const items = [
    ...access.connectors.map((name) => ({ name, kind: 'connector' as const })),
    ...access.secrets.map((name) => ({ name, kind: 'secret' as const })),
  ];

  return (
    // `w-full`, or the composer's `items-center` strip shrinks this to its
    // content width (composer.tsx). Same reason `SessionApprovalNotice` carries it.
    <div className="relative isolate z-10 w-full">
      <div className="flex w-full items-center gap-2 px-3 py-1 pr-1.5">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          aria-controls={panelId}
          className="text-muted-foreground hover:text-foreground flex min-h-6 min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left text-xs transition-colors"
        >
          <ShieldWarningIcon className="text-kortix-orange size-3.5 shrink-0" />
          {total > 1 && (
            <span className="shrink-0 tabular-nums">
              {index + 1} / {total}
            </span>
          )}
          <span className={cn('min-w-0 truncate', collapsed && 'text-foreground')}>
            {total > 1 && (
              <span aria-hidden="true" className="text-muted-foreground">
                ·{' '}
              </span>
            )}
            {collapsed ? access.colleague : t('headline')}
          </span>
          <CaretDownIcon
            className={cn(
              'duration-normal size-3 shrink-0 transition-transform ease-out motion-reduce:transition-none',
              collapsed && '-rotate-90',
            )}
          />
        </button>
        {total > 1 && !collapsed && (
          <div className="flex shrink-0 items-center">
            <button
              type="button"
              onClick={() => onSelect(open[index - 1].id)}
              disabled={index === 0 || busy}
              aria-label={tCommon('back')}
              className={ICON_BUTTON_CLASS}
            >
              <CaretLeftIcon className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onSelect(open[index + 1].id)}
              disabled={index === total - 1 || busy}
              aria-label={tCommon('next')}
              className={ICON_BUTTON_CLASS}
            >
              <CaretRightIcon className="size-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* The 0fr/1fr grid row animates the collapse without measuring height. */}
      <div
        className={cn(
          'duration-normal grid transition-[grid-template-rows] ease-out motion-reduce:transition-none',
          collapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]',
        )}
      >
        <div
          id={panelId}
          inert={collapsed}
          className={cn(
            'duration-normal min-h-0 overflow-y-auto transition-opacity ease-out motion-reduce:transition-none',
            collapsed ? 'opacity-0' : 'max-h-[420px]',
          )}
        >
          <div key={ask.id} className="flex flex-col gap-2 px-3 pt-0.5 pb-2.5">
            <p className="min-w-0 text-sm">
              <span className="text-muted-foreground">{t('task')} </span>
              <span className="text-foreground font-medium wrap-anywhere">{access.colleague}</span>
            </p>
            {items.length > 0 ? (
              <ul className="border-border divide-border divide-y overflow-hidden rounded-sm border">
                {items.map((item) => (
                  <li key={`${item.kind}:${item.name}`} className="flex min-w-0 items-center gap-2 px-3 py-2 text-xs">
                    {item.kind === 'connector' ? (
                      <PlugsConnectedIcon className="text-muted-foreground size-3.5 shrink-0" />
                    ) : (
                      <KeyIcon className="text-muted-foreground size-3.5 shrink-0" />
                    )}
                    <code className="text-foreground min-w-0 flex-1 truncate font-mono" title={item.name}>
                      {item.name}
                    </code>
                    <span className="text-muted-foreground shrink-0">
                      {item.kind === 'connector' ? t('connector') : t('secret')}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="text-muted-foreground text-xs text-pretty">{t('onlyThis')}</p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onDecide(ask, 'deny')}>
                {deciding?.askId === ask.id && deciding.decision === 'deny' ? (
                  <Loading className="size-4 shrink-0" />
                ) : null}
                {t('deny')}
              </Button>
              <Button type="button" size="sm" disabled={busy} onClick={() => onDecide(ask, 'allow')}>
                {deciding?.askId === ask.id && deciding.decision === 'allow' ? (
                  <Loading className="size-4 shrink-0" />
                ) : null}
                {t('allow')}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
