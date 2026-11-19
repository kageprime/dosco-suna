'use client';

import { getProject, type SubscriptionConnection } from '@kortix/sdk';
import {
  contract,
  qk,
  useSubscriptionConnections,
  useSubscriptionUsage,
} from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { ArrowClockwiseIcon, ArrowLeftIcon, CaretRightIcon } from '@phosphor-icons/react';

import { useLocale, useTranslations } from '../../i18n';
import { ProviderLogo } from '../../internal/lib/provider-branding';
import { cn } from '../../lib/utils';
import { Badge } from '../../primitives/badge';
import Loading from '../../primitives/loading';
import { Progress } from '../../primitives/progress';
import {
  accountLine,
  formatReset,
  loginLimit,
  shownUsage,
  USAGE_TONE_BAR,
  usageTone,
  windowLabel,
} from './subscription-windows';

const SCROLLBAR_HIDE_CLASS =
  'scrollbar-hide [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden';

const SUBSCRIPTION_PROVIDER_IDS = new Set(['antigravity', 'codex', 'claude-agent']);

const PROVIDER_LOGO_ID: Record<string, { id: string; name: string }> = {
  antigravity: { id: 'google', name: 'Google Antigravity' },
  codex: { id: 'chatgpt', name: 'ChatGPT' },
  'claude-agent': { id: 'anthropic', name: 'Claude' },
};

const isUsableLogin = (secret: Pick<SubscriptionConnection, 'active' | 'needs_reauth_at' | 'status'>) =>
  secret.active && !secret.needs_reauth_at && secret.status !== 'undecryptable';

function LoginQuotaCard({
  accountId,
  projectId,
  secret,
  listUpdatedAt,
}: {
  accountId: string;
  projectId: string;
  secret: SubscriptionConnection;
  listUpdatedAt: number;
}) {
  const t = useTranslations('subscriptionUsage');
  const locale = useLocale();
  const enabled = isUsableLogin(secret) && secret.can_use;
  const live = useSubscriptionUsage(accountId, secret.secret_id, {
    projectId,
    storage: secret.storage,
    enabled,
  });
  const usage = shownUsage(live.data?.usage, secret.usage);
  const observedAt = usage?.observed_at ? Date.parse(usage.observed_at) : 0;
  const now = Math.max(live.dataUpdatedAt, listUpdatedAt, Number.isFinite(observedAt) ? observedAt : 0);
  const limit = loginLimit(usage, now);
  const windows = usage?.windows ?? [];
  const line = accountLine(live.data?.provider_account ?? secret.provider_account, secret.label);
  const logo = PROVIDER_LOGO_ID[secret.provider_id ?? ''] ?? { id: 'google', name: 'Subscription' };

  return (
    <div className="border-border/60 bg-background/40 flex flex-col gap-2.5 rounded-lg border p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <ProviderLogo
            providerID={logo.id}
            name={logo.name}
            size="xs"
            className="size-4 shrink-0 rounded-none bg-transparent"
          />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-foreground truncate text-xs font-medium">{secret.label}</span>
              {limit.limited ? (
                <Badge size="sm" variant="destructive">
                  {t('limitReached')}
                </Badge>
              ) : null}
            </div>
            {line ? <p className="text-muted-foreground truncate text-[11px]">{line}</p> : null}
          </div>
        </div>
        {enabled ? (
          <button
            type="button"
            aria-label="Refresh usage"
            disabled={live.isFetching}
            onClick={() => void live.refetch()}
            className="text-muted-foreground hover:bg-hover hover:text-foreground flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors disabled:opacity-50"
          >
            <ArrowClockwiseIcon className={cn('size-3.5', live.isFetching && 'animate-spin')} />
          </button>
        ) : null}
      </div>

      {!enabled ? (
        <p className="text-muted-foreground text-xs">
          {secret.active ? t('reconnectToSee') : t('inactive')}
        </p>
      ) : windows.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          {live.isFetching ? t('checking') : live.isError ? t('loadFailed') : t('noUsageYet')}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {windows.map((window) => {
            const percent = Math.round(Math.min(100, Math.max(0, window.used_percent)));
            const passed = Boolean(window.resets_at && Date.parse(window.resets_at) <= now);
            const tone = usageTone(window, limit.limited);
            const reset = window.resets_at && !passed ? formatReset(window.resets_at, now, locale) : null;
            const detail = passed
              ? t('resetPassed')
              : reset
                ? t('percentResets', { percent, time: reset })
                : t('percent', { percent });
            const label = windowLabel(window.id, t);
            return (
              <div key={window.id} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-2 text-[11px]">
                  <span className="text-foreground truncate font-medium">{label}</span>
                  <span className="text-muted-foreground shrink-0 tabular-nums">{detail}</span>
                </div>
                <Progress
                  value={passed ? 0 : percent}
                  aria-label={t('meterLabel', { label, percent })}
                  className="bg-muted h-1"
                  indicatorClassName={passed ? 'bg-muted-foreground' : USAGE_TONE_BAR[tone]}
                />
              </div>
            );
          })}
          {live.isError ? <p className="text-muted-foreground text-[11px]">{t('refreshFailed')}</p> : null}
        </div>
      )}
    </div>
  );
}

/**
 * Compact live subscription usage view rendered inside the model picker
 * popover when "View Usage" is triggered, prioritizing Google Antigravity
 * logins and deep-linking directly to the provider sheet for account setup.
 */
export function PickerUsageView({
  projectId,
  preferredProvider,
  onBack,
  onManageProviders,
}: {
  projectId: string | null;
  preferredProvider?: 'antigravity' | 'codex' | 'claude-agent' | null;
  onBack: () => void;
  onManageProviders?: (providerId?: string) => void;
}) {
  const t = useTranslations('subscriptionUsage');
  const projectRow = useQuery({
    queryKey: qk.project.summary(projectId ?? ''),
    queryFn: () => getProject(projectId as string),
    enabled: !!projectId,
    ...contract('config'),
  });
  const accountId = projectRow.data?.account_id ?? null;
  const connections = useSubscriptionConnections(accountId, projectId ?? '');

  const logins = (connections.data?.subscriptions ?? [])
    .filter((secret) => secret.provider_id && SUBSCRIPTION_PROVIDER_IDS.has(secret.provider_id))
    .sort((a, b) => {
      const target = preferredProvider ?? 'antigravity';
      const aMatch = a.provider_id === target ? 0 : 1;
      const bMatch = b.provider_id === target ? 0 : 1;
      if (aMatch !== bMatch) return aMatch - bMatch;
      return (a.provider_id ?? '').localeCompare(b.provider_id ?? '');
    });

  const manageTarget =
    preferredProvider === 'codex'
      ? 'openai'
      : preferredProvider === 'claude-agent'
        ? 'anthropic'
        : 'google';

  return (
    <div
      className="bg-popover text-popover-foreground flex min-w-0 flex-col rounded-lg font-sans"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onBack();
        }
      }}
    >
      <div className="border-border/60 flex items-center justify-between gap-2 border-b px-2.5 py-2">
        <button
          type="button"
          onClick={onBack}
          className="text-muted-foreground hover:bg-hover hover:text-foreground flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-medium transition-colors"
        >
          <ArrowLeftIcon className="size-3.5 shrink-0" />
          <span>{t('title')}</span>
        </button>
        {onManageProviders ? (
          <button
            type="button"
            onClick={() => onManageProviders(manageTarget)}
            className="text-muted-foreground hover:bg-hover hover:text-foreground flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-xs transition-colors"
          >
            <span>Manage</span>
            <CaretRightIcon className="size-3 shrink-0" />
          </button>
        ) : null}
      </div>

      <div className={cn(SCROLLBAR_HIDE_CLASS, 'max-h-[min(22rem,55vh)] min-h-0 flex-1 space-y-2.5 overflow-y-auto p-2.5')}>
        {connections.isLoading || projectRow.isLoading ? (
          <div className="flex items-center justify-center py-6">
            <Loading className="size-4" />
          </div>
        ) : logins.length > 0 && accountId && projectId ? (
          logins.map((secret) => (
            <LoginQuotaCard
              key={`${secret.storage}:${secret.secret_id}`}
              accountId={accountId}
              projectId={projectId}
              secret={secret}
              listUpdatedAt={connections.dataUpdatedAt}
            />
          ))
        ) : (
          <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed p-3">
            <p className="text-muted-foreground text-xs">{t('noUsageYet')}</p>
            {onManageProviders ? (
              <button
                type="button"
                onClick={() => onManageProviders('google')}
                className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors"
              >
                <span>Connect Google Antigravity</span>
                <CaretRightIcon className="size-3" />
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
