'use client';

import { useLocale, useTranslations } from '../../../i18n';
import type {
  AccountSecretResource,
  SubscriptionConnection,
  SubscriptionUsage,
  SubscriptionUsageWindow,
} from '@kortix/sdk';
import {
  useSubscriptionConnections,
  useSubscriptionUsage,
} from '@kortix/sdk/react';
import { ArrowClockwiseIcon, ChartBarIcon } from '@phosphor-icons/react';
import { usePooledProviderIds } from '../../providers/provider-connect';
import { Button } from '../../../primitives/button';
import { Badge } from '../../../primitives/badge';
import { EmptyState } from '../../../primitives/empty-state';
import Loading from '../../../primitives/loading';
import { ProviderLogo } from '../../../internal/lib/provider-branding';
import { Progress } from '../../../primitives/progress';
import {
  isSubscriptionLogin,
  shownUsage,
  formatReset,
  weeklyModel,
  usageTone,
} from './subscription-usage';

const PROVIDER_NAME: Record<string, string> = {
  codex: 'ChatGPT',
  'claude-agent': 'Claude Code',
};

const TONE_BAR = {
  ok: 'bg-primary',
  near: 'bg-kortix-orange',
  critical: 'bg-kortix-red',
  limited: 'bg-kortix-red',
} as const;

/** One plan window: its name, how much is used, a bar, and when it resets. */
function UsageWindowMeter({
  window,
  limited,
  now,
  lead,
}: {
  window: SubscriptionUsageWindow;
  limited: boolean;
  now: number;
  /** The window closest to its limit: the percent is the card's headline. */
  lead?: boolean;
}) {
  const locale = useLocale();
  const t = useTranslations('subscriptionUsage');
  const model = weeklyModel(window.id);
  const label =
    window.id === 'five_hour'
      ? t('fiveHour')
      : window.id === 'weekly'
        ? t('weekly')
        : model
          ? t('weeklyModel', { model })
          : window.id.replaceAll('_', ' ');
  const expired = Boolean(
    window.resets_at && Date.parse(window.resets_at) <= now,
  );
  const percent = Math.max(0, Math.min(100, Math.round(window.used_percent)));
  return (
    <div className="flex flex-col gap-2">
      {lead ? (
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-2xl font-semibold tracking-tight tabular-nums">
            {percent}%
          </span>
          <span className="text-xs text-muted-foreground">{label}</span>
        </div>
      ) : (
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <span>{label}</span>
          <span className="tabular-nums font-medium">{percent}%</span>
        </div>
      )}
      <Progress
        value={percent}
        aria-label={t('meterLabel', { label, percent })}
        className="h-1.5 bg-muted"
        indicatorClassName={
          expired ? 'bg-muted-foreground' : TONE_BAR[usageTone(window, limited)]
        }
      />
      <p className="text-xs text-muted-foreground">
        {expired
          ? t('text9')
          : window.resets_at
            ? t('resets', { time: formatReset(window.resets_at, now, locale) })
            : t('text10')}
      </p>
      {model === 'Fable' && (
        <p className="text-xs text-muted-foreground">{t('fableIncluded')}</p>
      )}
    </div>
  );
}

/** The props-only card also lets the design-system preview use synthetic data. */
export function SubscriptionUsageCard({
  secret,
  usage,
  fetching,
  error,
  onRefresh,
  onConnect,
  showLabel = false,
}: {
  secret: AccountSecretResource;
  usage: SubscriptionUsage | null;
  fetching: boolean;
  error: boolean;
  onRefresh: () => void;
  onConnect?: () => void;
  /** Name the login under the provider: two logins of one provider look alike otherwise. */
  showLabel?: boolean;
}) {
  const locale = useLocale();
  const t = useTranslations('subscriptionUsage');
  const now = Date.now();
  const reconnect = Boolean(
    secret.needs_reauth_at || secret.status === 'undecryptable',
  );
  // A rejection in a snapshot whose reset has passed is no current limit.
  const rejectionIsCurrent = Boolean(
    usage?.limited &&
    !usage.windows.some(
      (window) => window.resets_at && Date.parse(window.resets_at) <= now,
    ),
  );
  const exhausted =
    rejectionIsCurrent ||
    Boolean(
      usage?.windows.some(
        (w) =>
          w.used_percent >= 100 &&
          (!w.resets_at || Date.parse(w.resets_at) > now),
      ),
    );
  const stale = Boolean(
    usage && now - Date.parse(usage.observed_at) > 10 * 60_000,
  );
  // The badge appears only when something needs attention.
  const status = reconnect
    ? t('text0')
    : !secret.active
      ? t('text1')
      : error
        ? t('text2')
        : exhausted
          ? t('text4')
          : stale
            ? t('text5')
            : null;
  const windows = usage?.windows ?? [];
  // The window closest to its limit leads; the rest keep the provider's order.
  const lead = windows.reduce<SubscriptionUsageWindow | null>(
    (best, window) =>
      !best || window.used_percent > best.used_percent ? window : best,
    null,
  );
  const rest = windows.filter((window) => window !== lead);
  return (
    <article className="rounded-md border border-border p-4 flex flex-col gap-4 min-w-0">
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <ProviderLogo
            providerID={secret.provider_id ?? ''}
            size="small"
            tone="light"
          />
          <div className="min-w-0">
            <h3 className="text-sm font-medium truncate">
              {PROVIDER_NAME[secret.provider_id ?? ''] ?? secret.label}{' '}
              <span className="text-muted-foreground font-normal capitalize">
                {secret.provider_account?.plan ?? t('text7')}
              </span>
            </h3>
            {showLabel && (
              <p className="text-xs text-muted-foreground truncate">
                {secret.label}
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {status && (
            <Badge
              size="sm"
              variant={reconnect || exhausted ? 'warning' : 'secondary'}
            >
              {status}
            </Badge>
          )}
          {reconnect ? (
            <Button variant="outline" size="sm" onClick={onConnect}>
              {t('reconnect')}
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={fetching || !secret.active}
              onClick={onRefresh}
              aria-label={t('refreshLabel', { label: secret.label })}
              title={fetching ? t('text15') : t('text16')}
            >
              {fetching ? <Loading /> : <ArrowClockwiseIcon />}
            </Button>
          )}
        </div>
      </header>
      {lead && usage ? (
        <>
          <UsageWindowMeter
            window={lead}
            limited={usage.limited}
            now={now}
            lead
          />
          {rest.length > 0 && (
            <div className="flex flex-col gap-4 border-t border-border pt-4">
              {rest.map((window) => (
                <UsageWindowMeter
                  key={window.id}
                  window={window}
                  limited={usage.limited}
                  now={now}
                />
              ))}
            </div>
          )}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          {fetching ? t('text11') : error ? t('text2') : t('text12')}
        </p>
      )}
      {usage && (error || stale) && (
        <p className="text-xs text-muted-foreground">
          {error
            ? t('text13')
            : t('observed', {
                time: new Date(usage.observed_at).toLocaleString(locale, {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                }),
              })}
        </p>
      )}
    </article>
  );
}

function ConnectedSubscription({
  accountId,
  projectId,
  secret,
  onConnect,
  showLabel,
}: {
  accountId: string;
  projectId: string;
  secret: SubscriptionConnection;
  onConnect: () => void;
  showLabel: boolean;
}) {
  const live = useSubscriptionUsage(accountId, secret.secret_id, {
    projectId,
    storage: secret.storage,
    enabled:
      secret.can_use &&
      secret.active &&
      !secret.needs_reauth_at &&
      secret.status !== 'undecryptable',
  });
  return (
    <SubscriptionUsageCard
      secret={{
        ...secret,
        provider_account:
          live.data?.provider_account ?? secret.provider_account,
      }}
      usage={shownUsage(live.data?.usage, secret.usage)}
      fetching={live.isFetching}
      error={live.isError}
      onRefresh={() => void live.refetch()}
      onConnect={onConnect}
      showLabel={showLabel}
    />
  );
}

/**
 * Whether the project has a ChatGPT or Claude subscription login to report on.
 * `ready` is false until the answer is known, so a caller can wait instead of
 * hiding, then showing, the Usage tab.
 */
export function useHasSubscriptions(projectId: string, enabled = true) {
  const pooled = usePooledProviderIds(projectId, enabled);
  const resources = useSubscriptionConnections(
    enabled ? pooled.accountId : null,
    projectId,
  );
  const subscriptions = (resources.data?.subscriptions ?? []).filter(
    (secret) => secret.can_use && isSubscriptionLogin(secret),
  );
  const ready =
    !pooled.isLoading &&
    (!pooled.pooledSecretsEnabled || !pooled.accountId || !resources.isLoading);
  return { ready, has: subscriptions.length > 0 };
}

export function SubscriptionUsageTab({
  projectId,
  onConnect,
}: {
  projectId: string;
  onConnect: () => void;
}) {
  const t = useTranslations('subscriptionUsage');
  const pooled = usePooledProviderIds(projectId, true);
  const resources = useSubscriptionConnections(pooled.accountId, projectId);
  // Every connected ChatGPT and Claude login, side by side.
  const subscriptions = (resources.data?.subscriptions ?? []).filter(
    (secret) => secret.can_use && isSubscriptionLogin(secret),
  );
  return (
    <section className="@container space-y-6 pb-6">
      <h2 className="text-lg font-medium">{t('text17')}</h2>
      {pooled.isLoading || (pooled.accountId && resources.isLoading) ? (
        <Loading />
      ) : pooled.isError || resources.isError ? (
        <EmptyState
          title={t('text19')}
          description={t('text20')}
          action={
            <Button
              variant="outline"
              onClick={() => {
                void pooled.refetch();
                void resources.refetch();
              }}
            >
              {t('text21')}
            </Button>
          }
        />
      ) : !pooled.pooledSecretsEnabled ? (
        <EmptyState
          icon={ChartBarIcon}
          title={t('disabledTitle')}
          description={t('disabledDescription')}
        />
      ) : !subscriptions.length ? (
        <EmptyState
          icon={ChartBarIcon}
          title={t('text22')}
          description={t('text23')}
          action={
            <Button variant="outline" onClick={onConnect}>
              {t('text24')}
            </Button>
          }
        />
      ) : (
        <div className="grid grid-flow-dense grid-cols-1 @3xl:grid-cols-2 items-start gap-4">
          {subscriptions.map((secret) => (
            <ConnectedSubscription
              projectId={projectId}
              key={`${secret.storage}:${secret.secret_id}`}
              accountId={pooled.accountId!}
              secret={secret}
              onConnect={onConnect}
              showLabel={
                subscriptions.filter(
                  (other) => other.provider_id === secret.provider_id,
                ).length > 1
              }
            />
          ))}
        </div>
      )}
    </section>
  );
}
