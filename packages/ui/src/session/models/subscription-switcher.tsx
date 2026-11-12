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
import {
  accountLine,
  isBlockingWindow,
  loginLimit,
  usageTone,
  windowLabel,
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
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const radios = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    const index = radios.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    radios[(index + step + radios.length) % radios.length]?.focus();
  };

  return (
    <div>
      <div className="text-muted-foreground flex h-9 shrink-0 items-center border-b px-3 text-sm">
        {t('subscriptionSwitcher')}
      </div>
      <div role="radiogroup" aria-label={t('subscriptionSwitcher')} onKeyDown={onKeyDown} className="flex flex-col gap-px p-1.5">
        {rows.map((row) => {
          const checked = row.secretId === pinnedId || (row.secretId === null && pinnedId === null);
          const tone = row.window ? usageTone(row.window, row.limited) : 'ok';
          return (
            <button
              key={row.secretId ?? 'default'}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={row.secretId ? t('subscriptionSwitcherUse', { label: row.label }) : undefined}
              tabIndex={checked ? 0 : -1}
              disabled={!canEdit || pending}
              onClick={() => pick(row.secretId)}
              className={cn(
                'flex cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1 text-left text-sm outline-none',
                'hover:bg-hover focus-visible:bg-hover focus-visible:ring-kortix-base focus-visible:ring-2',
                'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-60',
                checked && 'bg-active hover:bg-active',
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="text-foreground min-w-0 flex-1 truncate font-medium">{row.label}</span>
                {row.limited ? (
                  <span className="text-foreground shrink-0 text-xs">{tUsage('limitReached')}</span>
                ) : row.window ? (
                  <span
                    className={cn('shrink-0 text-xs tabular-nums', tone === 'ok' ? 'text-muted-foreground' : 'text-foreground')}
                  >
                    {windowLabel(row.window.id, tUsage)} · {tUsage('percent', { percent: Math.round(row.window.used_percent) })}
                  </span>
                ) : null}
                {checked ? <SolidCheckIcon className="text-ring size-4 shrink-0" /> : null}
              </span>
              <span className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs">
                {row.line ? <span className="min-w-0 truncate">{row.line}</span> : null}
                {row.broken ? <span className={row.line ? 'shrink-0' : 'min-w-0 truncate'}>{t('needsReconnection')}</span> : null}
                {!row.line && !row.broken && row.secretId && !row.window ? (
                  <span className="min-w-0 truncate">{tUsage('noUsageYet')}</span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
      {canEdit ? null : <p className="text-muted-foreground px-3 pb-1.5 text-xs">{t('readOnlyPool')}</p>}
    </div>
  );
}
