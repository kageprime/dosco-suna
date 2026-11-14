'use client';

/**
 * The subscription pane of the model picker: which ChatGPT or Claude login
 * pays for the selected subscription model in this session, and how much of
 * its allowance is spent.
 *
 * The choice IS the session's provider key pool for that provider, pinned to
 * one login — the same pool Customize → Models and the session-overrides
 * "Provider keys" row read and write (`useSessionProviderSecretPools`). No
 * second source of truth: picking a login here writes the pool, and the
 * gateway resolves the turn's credential from it (resolve-candidates'
 * `selectedPool`). "Workspace default" clears the pin, handing the provider
 * back to rotation.
 *
 * Data comes from the same reads those surfaces use: `useProviderKeyChoices`
 * (the account's usable gateway logins, personal-key scoped to this session)
 * and the pool list. The usage shown per login is the snapshot those reads
 * carry — the same numbers the provider sheet renders (`subscription-usage`);
 * a login the provider has not reported on yet shows none.
 *
 * Only an existing session can switch: a pool belongs to a session, so a
 * pre-create composer renders nothing.
 */

import type { SubscriptionUsage, SubscriptionUsageWindow } from '@kortix/sdk';
import { useSessionProviderSecretPools, type FlatModel } from '@kortix/sdk/react';
import { useTranslations } from '../../i18n';
import { needsReconnection } from '../../internal/lib/account-secret-access';
import { SolidCheckIcon } from '../../internal/icons/solid-check-icon';
import { cn } from '../../lib/utils';
import { useSessionIds } from '../../providers/session-ids';
import { isClaudeSubscriptionModel, isSubscriptionModel } from './model-tags';
import Loading from '../../primitives/loading';
import {
  accountLine,
  isBlockingWindow,
  loginLimit,
  USAGE_TONE_BAR,
  usageTone,
  windowLabel,
  type UsageTone,
} from './subscription-windows';
import { useProviderKeyChoices } from '../overrides/provider-secret-pool-editor';

/** The provider whose pooled logins pay for a subscription model. Null for every other model. */
export function subscriptionProviderOf(
  model: Pick<FlatModel, 'providerID' | 'modelID'> & { provider?: string | null },
): 'codex' | 'claude-agent' | null {
  if (isSubscriptionModel(model)) return 'codex';
  if (isClaudeSubscriptionModel(model)) return 'claude-agent';
  return null;
}

/**
 * The window to show beside a login: the fullest one still in force that
 * gates its model calls (`isBlockingWindow`, the rule the provider sheet's
 * summary and the gateway's limit state share). Null when nothing is reported.
 */
export function peakBlockingWindow(
  usage: SubscriptionUsage | null | undefined,
  now: number,
): SubscriptionUsageWindow | null {
  if (!usage) return null;
  let peak: SubscriptionUsageWindow | null = null;
  for (const window of usage.windows) {
    if (!isBlockingWindow(window.id)) continue;
    if (window.resets_at && Date.parse(window.resets_at) <= now) continue;
    if (!peak || window.used_percent > peak.used_percent) peak = window;
  }
  return peak;
}

export function SubscriptionSwitcher({ providerId }: { providerId: 'codex' | 'claude-agent' }) {
  const t = useTranslations('pooledSecrets');
  const tUsage = useTranslations('subscriptionUsage');
  const { projectId, sessionId } = useSessionIds();
  const pools = useSessionProviderSecretPools(projectId ?? null, sessionId ?? null);
  const keys = useProviderKeyChoices(projectId ?? '', sessionId);

  const logins = keys.keys.filter((secret) => secret.provider_id === providerId);
  // Nothing to switch (no connected login, pre-create, or a failed read): no pane.
  if (!sessionId || logins.length === 0) return null;

  const pinned = pools.data?.pools.find((pool) => pool.provider_id === providerId)?.secret_ids ?? null;
  // A pool of several logins rotates; the pane reads that as the default.
  const pinnedId = pinned && pinned.length === 1 ? pinned[0] : null;
  const canEdit = pools.data?.can_edit === true;
  const pending = pools.setPool.isPending;
  // The clock the usage reads judge resets by: the pool read's own timestamp
  // (react-query render data, what `subscription-usage` passes as `now`), so
  // the pane stays pure. A pane left open ages past it like any snapshot.
  const now = pools.dataUpdatedAt;

  const pick = (secretId: string | null) => {
    void pools.setPool.mutateAsync({ providerId, secretIds: secretId ? [secretId] : null });
  };
  // The row a save is applying: it shows the pending glyph in its check slot.
  const pendingId = pending ? (pools.setPool.variables?.secretIds?.[0] ?? null) : undefined;

  const rows: Array<{ secretId: string | null; label: string; line: string | null; window: SubscriptionUsageWindow | null; limited: boolean; broken: boolean }> = [
    { secretId: null, label: t('projectDefaultShort'), line: t('subscriptionSwitcherDefault'), window: null, limited: false, broken: false },
    ...logins.map((secret) => {
      const peak = peakBlockingWindow(secret.usage, now);
      return {
        secretId: secret.secret_id,
        label: secret.label,
        line: accountLine(secret.provider_account, secret.label),
        window: peak,
        limited: loginLimit(secret.usage ?? null, now).limited,
        broken: needsReconnection(secret),
      };
    }),
  ];

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // Same contract as the reasoning pane beside it: Escape bubbles (the
    // popover closes), modifiers and Tab stay with the panel, the arrows walk
    // the radios, every other key stops so cmdk never selects a model row.
    if (event.key === 'Escape' || event.key === 'Tab') return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    event.stopPropagation();
    const radios = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    const index = radios.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? (index + 1) % radios.length
      : event.key === 'ArrowUp' ? (index - 1 + radios.length) % radios.length
        : event.key === 'Home' ? 0
          : event.key === 'End' ? radios.length - 1
            : null;
    if (next === null) return;
    event.preventDefault();
    radios[next]?.focus();
  };

  return (
    // `border-t`: the pane spans the picker's full width under the rail, the
    // list and the effort pane, so one rule closes all three above it.
    <div className="border-t">
      <div className="text-muted-foreground flex h-9 shrink-0 items-center border-b px-3 text-sm">
        {t('subscriptionSwitcher')}
      </div>
      <div role="radiogroup" aria-label={t('subscriptionSwitcher')} onKeyDown={onKeyDown} className="flex flex-col gap-px p-1.5">
        {rows.map((row) => {
          const checked = row.secretId === pinnedId || (row.secretId === null && pinnedId === null);
          // A limit outranks the window: a provider can refuse a login while
          // no window it reports is still in force.
          const meter: { percent: number; tone: UsageTone; text: string } | null = row.limited
            ? { percent: 100, tone: 'limited', text: tUsage('limitReached') }
            : row.window
              ? {
                  percent: Math.round(row.window.used_percent),
                  tone: usageTone(row.window, false),
                  text: `${windowLabel(row.window.id, tUsage)} · ${tUsage('percent', { percent: Math.round(row.window.used_percent) })}`,
                }
              : null;
          // One status per row, in one right-hand slot: a broken login cannot
          // run a turn, so that outranks its last usage.
          const status = row.broken ? (
            <span className="text-muted-foreground shrink-0 text-xs">{t('needsReconnection')}</span>
          ) : meter ? (
            <SubscriptionRowMeter {...meter} />
          ) : row.secretId ? (
            <span className="text-muted-foreground shrink-0 text-xs">{tUsage('notReported')}</span>
          ) : null;
          return (
            <button
              key={row.secretId ?? 'default'}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={row.secretId ? t('subscriptionSwitcherUse', { label: row.label }) : undefined}
              aria-busy={pendingId === row.secretId || undefined}
              tabIndex={checked ? 0 : -1}
              // A save in flight blocks a second pick with `aria-disabled`, not
              // `disabled`: a disabled button drops the keyboard focus it holds.
              disabled={!canEdit}
              aria-disabled={pending || undefined}
              onClick={() => {
                if (!pending) pick(row.secretId);
              }}
              className={cn(
                // One line per row, the model rows' shape: the name in ink, its
                // account line muted after it, the status and the check in
                // fixed slots so every meter lines up. `h-12` (44px) is the touch row.
                'flex h-12 cursor-pointer items-center gap-3 rounded-md px-2 text-left text-sm outline-none sm:h-9',
                'hover:bg-hover focus-visible:bg-hover focus-visible:ring-kortix-base transition-colors duration-fast focus-visible:ring-2',
                // Read-only rows dim; a save in flight keeps full ink, and
                // the spinner says which row it applies.
                'disabled:pointer-events-none disabled:opacity-50',
                checked && 'bg-active hover:bg-active',
              )}
            >
              <span className="min-w-0 flex-1 truncate" title={row.line ?? undefined}>
                <span className="text-foreground font-medium">{row.label}</span>
                {row.line ? <span className="text-muted-foreground"> {row.line}</span> : null}
              </span>
              {status}
              <span className="flex size-4 shrink-0 items-center justify-center">
                {pendingId === row.secretId ? (
                  // `!`: Loading paints itself `text-background` inside a button (a filled one); this row is transparent.
                  <Loading className="text-muted-foreground! size-3.5" />
                ) : checked ? (
                  <SolidCheckIcon className="text-ring size-4" />
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
      {canEdit ? null : <p className="text-muted-foreground px-3 pb-2 text-xs">{t('readOnlyPool')}</p>}
    </div>
  );
}

/** A login's usage at a glance: a short bar in the tone's hue, then its label. */
export function SubscriptionRowMeter({ text, percent, tone }: { text: string; percent: number; tone: UsageTone }) {
  return (
    <span className="text-muted-foreground flex shrink-0 items-center gap-2 text-xs tabular-nums" data-subscription-usage-row="">
      <span className="bg-muted block h-1 w-10 overflow-hidden rounded-full" aria-hidden>
        <span className={cn('block h-full', USAGE_TONE_BAR[tone])} style={{ width: `${Math.min(100, percent)}%` }} />
      </span>
      <span className="max-w-72 truncate">{text}</span>
    </span>
  );
}
