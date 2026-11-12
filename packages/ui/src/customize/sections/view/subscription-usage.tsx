'use client';

import { useCallback } from 'react';
import type { AccountSecretResource, SubscriptionConnection, SubscriptionUsage, SubscriptionUsageWindow } from '@kortix/sdk';
import { useSubscriptionConnections, useSubscriptionUsage, useSubscriptionUsages } from '@kortix/sdk/react';
import { useLocale, useTranslations } from '../../../i18n';
import { cn } from '../../../lib/utils';
import { Badge } from '../../../primitives/badge';
import { Progress } from '../../../primitives/progress';
import {
  accountLine,
  currentWindows as current,
  isBlockingWindow,
  loginLimit,
  modelName,
  usageTone,
  weeklyModel,
  windowLabel,
  type UsageTone,
} from '../../../session/models/subscription-windows';

export { accountLine, isBlockingWindow, loginLimit, modelName, usageTone, weeklyModel, windowLabel, type UsageTone };

/** Providers whose stored value is a subscription login with plan windows. */
const SUBSCRIPTION_PROVIDERS = new Set(['codex', 'claude-agent', 'antigravity']);

/** The provider-list row that carries each subscription login's usage. */
export const SUBSCRIPTION_ROW: Readonly<Record<string, string>> = { codex: 'openai', 'claude-agent': 'anthropic' };

/** A snapshot older than this says when it was observed. */
const STALE_MS = 10 * 60 * 1000;

const TONE_BAR: Record<UsageTone, string> = { ok: 'bg-primary', near: 'bg-kortix-orange', critical: 'bg-kortix-red', limited: 'bg-kortix-red' };

/**
 * A reset time a person reads at a glance: the clock time today, the weekday
 * and time within a week, else the date.
 */
export function formatReset(iso: string, now: number, locale: string): string {
  const at = new Date(iso);
  const ms = at.getTime() - now;
  if (Number.isNaN(ms)) return '';
  const sameDay = new Date(now).toDateString() === at.toDateString();
  const options: Intl.DateTimeFormatOptions = sameDay ? { hour: 'numeric', minute: '2-digit' }
    : ms < 6 * 24 * 60 * 60 * 1000 ? { weekday: 'short', hour: 'numeric', minute: '2-digit' }
      : { month: 'short', day: 'numeric' };
  return new Intl.DateTimeFormat(locale, options).format(at);
}

/** The usage to show: the live read when it answered, else the snapshot the list carried. */
export function shownUsage(live: SubscriptionUsage | null | undefined, listed: SubscriptionUsage | null | undefined): SubscriptionUsage | null {
  if (live && listed) return Date.parse(live.observed_at) >= Date.parse(listed.observed_at) ? live : listed;
  return live ?? listed ?? null;
}

/** The login's email and plan, under its name: the live read when it answered, else the list's. */
export function SubscriptionAccountLine({ accountId, projectId, secret }: { accountId: string; projectId: string; secret: AccountSecretResource }) {
  const live = useSubscriptionUsage(accountId, secret.secret_id, { projectId, storage: 'account_resource', enabled: isSubscriptionLogin(secret) && usable(secret) });
  const line = accountLine(live.data?.provider_account ?? secret.provider_account, secret.label);
  return line ? <span className="text-muted-foreground block truncate text-xs font-normal">{line}</span> : null;
}

export function isSubscriptionLogin(secret: Pick<AccountSecretResource, 'provider_id'>): boolean {
  return Boolean(secret.provider_id && SUBSCRIPTION_PROVIDERS.has(secret.provider_id));
}

/** A login the gateway can route to: active, readable, signed in. */
export function usable(secret: Pick<SubscriptionConnection, 'active' | 'needs_reauth_at' | 'status'>): boolean {
  return secret.active && !secret.needs_reauth_at && secret.status !== 'undecryptable';
}

export interface SubscriptionSummary {
  total: number;
  /** Logins that can take a model call now, by their reported usage. */
  available: number;
  /** Usable logins with no usage reported yet: neither available nor limited. */
  unknown: number;
  limited: number;
  /** When the first limited login gets capacity back. */
  nextBack: string | null;
  /** The fullest blocking window across the available logins. */
  peak: SubscriptionUsageWindow | null;
}

/**
 * One provider's logins in one line: how many can work now, when the next
 * one is back, and the fullest window of the ones that can.
 */
export function summarizeSubscriptions(logins: Array<{ secret: Pick<SubscriptionConnection, 'active' | 'needs_reauth_at' | 'status'>; usage: SubscriptionUsage | null }>, now: number): SubscriptionSummary {
  let available = 0;
  let unknown = 0;
  let limited = 0;
  let nextBack: string | null = null;
  let peak: SubscriptionUsageWindow | null = null;
  for (const { secret, usage } of logins) {
    if (!usable(secret)) continue;
    // Only a plan window says whether the login can work; extra usage or code review alone does not.
    if (!usage || !current(usage, now).some((window) => isBlockingWindow(window.id))) {
      unknown += 1;
      continue;
    }
    const limit = loginLimit(usage, now);
    if (limit.limited) {
      limited += 1;
      if (limit.until && (!nextBack || Date.parse(limit.until) < Date.parse(nextBack))) nextBack = limit.until;
      continue;
    }
    available += 1;
    for (const window of usage ? current(usage, now) : []) {
      if (isBlockingWindow(window.id) && (!peak || window.used_percent > peak.used_percent)) peak = window;
    }
  }
  return { total: logins.length, available, unknown, limited, nextBack, peak };
}

/** Every ChatGPT and Claude login this project can use, by provider-list row. */
export function useSubscriptionLogins(accountId: string | null | undefined, projectId: string) {
  const resources = useSubscriptionConnections(accountId, projectId);
  const logins = (resources.data?.subscriptions ?? []).filter((secret) => secret.can_use && isSubscriptionLogin(secret));
  return { ...resources, logins };
}

/**
 * The provider list's line for ChatGPT or Claude: `70% weekly · resets Wed`,
 * `1 of 3 at limit · back Fri 4:30 AM`, or null when nothing is reported.
 */
export function useSubscriptionRowSummary() {
  const t = useTranslations('subscriptionUsage');
  const locale = useLocale();
  return useCallback((summary: SubscriptionSummary | undefined, now: number): { text: string; percent: number; tone: UsageTone } | null => {
    if (!summary || summary.total === 0) return null;
    const back = summary.nextBack ? formatReset(summary.nextBack, now, locale) : null;
    if (summary.limited > 0 && summary.available === 0 && summary.unknown === 0) {
      return { text: back ? t('rowAllLimitedBack', { time: back }) : t('rowAllLimited'), percent: 100, tone: 'limited' };
    }
    if (summary.limited > 0) {
      const text = back ? t('rowSomeLimitedBack', { limited: summary.limited, total: summary.total, time: back })
        : t('rowSomeLimited', { limited: summary.limited, total: summary.total });
      // The bar is the logins that still work: their fullest window.
      return { text, percent: Math.round(summary.peak?.used_percent ?? 0), tone: summary.peak ? usageTone(summary.peak, false) : 'ok' };
    }
    if (!summary.peak) return null;
    const percent = Math.round(summary.peak.used_percent);
    return {
      text: t('rowPeak', { percent, window: windowLabel(summary.peak.id, t) }),
      percent,
      tone: usageTone(summary.peak, false),
    };
  }, [t, locale]);
}

/** The provider list's mini meter beside its summary line. */
export function SubscriptionRowMeter({ text, percent, tone }: { text: string; percent: number; tone: UsageTone }) {
  return (
    <span className="text-muted-foreground flex shrink-0 items-center gap-2 text-xs tabular-nums" data-subscription-usage-row="">
      <span className="bg-muted block h-1 w-10 overflow-hidden rounded-full" aria-hidden>
        <span className={cn('block h-full', TONE_BAR[tone])} style={{ width: `${Math.min(100, percent)}%` }} />
      </span>
      <span className="max-w-72 truncate">{text}</span>
    </span>
  );
}

function UsageWindowMeter({ window, limited, now, modelWeekly }: { window: SubscriptionUsageWindow; limited: boolean; now: number; modelWeekly: boolean }) {
  const t = useTranslations('subscriptionUsage');
  const locale = useLocale();
  const label = windowLabel(window.id, t, { modelWeekly });
  const percent = Math.round(Math.min(100, Math.max(0, window.used_percent)));
  const passed = Boolean(window.resets_at && Date.parse(window.resets_at) <= now);
  const blocking = isBlockingWindow(window.id);
  // A full window that stops nothing else (code review, extra usage, one
  // model) is red, but says when it resets, not that the login is back.
  const tone = blocking ? usageTone(window, limited) : window.used_percent >= 95 ? 'critical' : usageTone(window, false);
  const reset = window.resets_at && !passed ? formatReset(window.resets_at, now, locale) : null;
  const detail = passed ? t('resetPassed')
    : tone === 'limited' && reset ? t('percentBack', { percent, time: reset })
      : reset ? t('percentResets', { percent, time: reset }) : t('percent', { percent });
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-usage-window={window.id}>
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-foreground min-w-0 truncate">{label}</span>
        <span className={cn('shrink-0 tabular-nums', tone === 'limited' && !passed ? 'text-foreground' : 'text-muted-foreground')}>{detail}</span>
      </div>
      <Progress
        value={passed ? 0 : percent}
        aria-label={t('meterLabel', { label, percent })}
        className="bg-muted h-1"
        indicatorClassName={passed ? 'bg-muted-foreground' : TONE_BAR[tone]}
      />
    </div>
  );
}

/** Claude reports no 5-hour window until a message opens one: say so instead of hiding the limit. */
function NotStartedWindow({ id }: { id: string }) {
  const t = useTranslations('subscriptionUsage');
  const label = windowLabel(id, t);
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-usage-window={id}>
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-foreground min-w-0 truncate">{label}</span>
        <span className="text-muted-foreground shrink-0">{t('notStarted')}</span>
      </div>
      <Progress value={0} aria-label={t('meterLabel', { label, percent: 0 })} className="bg-muted h-1" />
    </div>
  );
}

/** Every window of one login, one per line, with the states around them. Props only: the design-system preview can use it. */
export function SubscriptionLoginWindows({
  providerId,
  usage,
  loading,
  error,
  now,
}: {
  providerId: string | null | undefined;
  usage: SubscriptionUsage | null;
  loading: boolean;
  error: boolean;
  now: number;
}) {
  const t = useTranslations('subscriptionUsage');
  const locale = useLocale();
  const limit = loginLimit(usage, now);
  const windows = usage?.windows ?? [];
  const missingFiveHour = providerId === 'claude-agent' && usage?.source === 'usage_endpoint' && windows.length > 0
    && !windows.some((window) => window.id === 'five_hour');
  const stale = usage && now - Date.parse(usage.observed_at) > STALE_MS;
  const modelWeekly = windows.some((window) => weeklyModel(window.id) !== null);
  if (!windows.length) {
    return <p className="text-muted-foreground text-xs">{loading ? t('checking') : error ? t('loadFailed') : t('noUsageYet')}</p>;
  }
  return (
    <div className="flex flex-col gap-3" data-subscription-windows="">
      {missingFiveHour ? <NotStartedWindow id="five_hour" /> : null}
      {windows.map((window) => <UsageWindowMeter key={window.id} window={window} limited={limit.limited} now={now} modelWeekly={modelWeekly} />)}
      {error ? <p className="text-muted-foreground text-xs">{t('refreshFailed')}</p>
        : stale ? <p className="text-muted-foreground text-xs">{t('observed', { time: formatReset(usage!.observed_at, now, locale) })}</p> : null}
    </div>
  );
}

/** One login's live read: the same query the sheet's summary and the provider list read. */
function useLoginUsage(accountId: string, projectId: string, secretId: string, storage: SubscriptionConnection['storage'], enabled: boolean) {
  return useSubscriptionUsage(accountId, secretId, { projectId, storage, enabled });
}

/**
 * The usage under one ChatGPT or Claude account in the provider sheet's
 * account list: the limit state, then every window. The row above it already
 * names the login.
 */
export function SubscriptionAccountUsage({ accountId, projectId, secret }: { accountId: string; projectId: string; secret: AccountSecretResource }) {
  const t = useTranslations('subscriptionUsage');
  const live = useLoginUsage(accountId, projectId, secret.secret_id, 'account_resource', usable(secret));
  const usage = shownUsage(live.data?.usage, secret.usage);
  // The clock of the newest read, the account list's included: a failed live
  // read must not keep a passed reset looking current.
  const listed = useSubscriptionLogins(accountId, projectId).dataUpdatedAt;
  const now = Math.max(live.dataUpdatedAt, listed);
  if (!usable(secret)) return null;
  return (
    <div className="mt-2.5 flex flex-col gap-2.5 font-normal" data-subscription-login="">
      {loginLimit(usage, now).limited ? <Badge size="sm" variant="destructive" className="self-start">{t('limitReached')}</Badge> : null}
      <SubscriptionLoginWindows providerId={secret.provider_id} usage={usage} loading={live.isFetching} error={live.isError} now={now} />
    </div>
  );
}

/** A project-stored login (made before pooled accounts) has no row in the account list: it gets its own block here. */
function LegacyLogin({ accountId, projectId, secret, now }: { accountId: string; projectId: string; secret: SubscriptionConnection; now: number }) {
  const t = useTranslations('subscriptionUsage');
  const live = useLoginUsage(accountId, projectId, secret.secret_id, secret.storage, secret.can_use && usable(secret));
  const usage = shownUsage(live.data?.usage, secret.usage);
  const line = accountLine(live.data?.provider_account ?? secret.provider_account, secret.label);
  const at = Math.max(now, live.dataUpdatedAt);
  return (
    <li className="border-border flex min-w-0 flex-col gap-2.5 rounded-md border px-3 py-2" data-subscription-login="">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <p className="min-w-0 text-sm">
          <span className="text-foreground font-medium">{secret.label}</span>
          {line ? <span className="text-muted-foreground block truncate text-xs">{line}</span> : null}
        </p>
        {!usable(secret) ? <span className="text-muted-foreground shrink-0 text-xs">{secret.active ? t('reconnectToSee') : t('inactive')}</span>
          : loginLimit(usage, at).limited ? <Badge size="sm" variant="destructive">{t('limitReached')}</Badge> : null}
      </div>
      {usable(secret) ? <SubscriptionLoginWindows providerId={secret.provider_id} usage={usage} loading={live.isFetching} error={live.isError} now={at} /> : null}
    </li>
  );
}

/**
 * Every login's shown usage for a summary: the live read when it answered
 * (a project-stored login's list snapshot stays empty), else the list's.
 */
export function useLiveSubscriptionUsages(accountId: string | null | undefined, projectId: string, logins: SubscriptionConnection[]) {
  const reads = useSubscriptionUsages(accountId, projectId, logins);
  const usages = logins.map((secret, index) => ({ secret, usage: shownUsage(reads[index]?.data?.usage, secret.usage) }));
  const updatedAt = Math.max(0, ...reads.map((read) => read.dataUpdatedAt));
  return { usages, updatedAt };
}

/**
 * "Subscription usage" on top of the ChatGPT (OpenAI) or Claude (Anthropic)
 * provider sheet: how many logins can work now and when the next one is back,
 * shown once there is more than one login or one is at its limit. Each
 * account's own windows sit under it in the account list; a project-stored
 * login that list does not carry is shown here.
 */
export function SubscriptionUsageSection({ accountId, projectId, providerId, compact = false }: {
  accountId: string;
  projectId: string;
  providerId: 'codex' | 'claude-agent';
  /** The quick dialog's accordion: headings there are `text-xs`. */
  compact?: boolean;
}) {
  const t = useTranslations('subscriptionUsage');
  const locale = useLocale();
  const { logins: all, dataUpdatedAt } = useSubscriptionLogins(accountId, projectId);
  const logins = all.filter((secret) => secret.provider_id === providerId);
  const live = useLiveSubscriptionUsages(accountId, projectId, logins);
  // A project-stored ChatGPT login has its own card below (its windows sit in
  // it); a project-stored Claude login has no other row.
  const legacy = providerId === 'claude-agent' ? logins.filter((secret) => secret.storage === 'project') : [];
  const now = Math.max(dataUpdatedAt, live.updatedAt);
  const summary = summarizeSubscriptions(live.usages, now);
  const showSummary = logins.length > 1 || summary.limited > 0;
  if (!showSummary && !legacy.length) return null;
  return (
    <section className="space-y-3" aria-label={t('title')} data-subscription-usage={providerId}>
      <p className={cn('text-foreground font-medium', compact ? 'text-xs' : 'text-sm')}>{t('title')}</p>
      {showSummary ? (
        <div className="bg-muted/60 flex flex-wrap gap-x-8 gap-y-2 rounded-md px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-muted-foreground text-xs">{t('availableNow')}</p>
            <p className="text-foreground text-sm font-medium tabular-nums">{t('availableCount', { available: summary.available, total: summary.total })}</p>
          </div>
          {summary.unknown > 0 ? (
            <div className="min-w-0">
              <p className="text-muted-foreground text-xs">{t('notReported')}</p>
              <p className="text-foreground text-sm font-medium tabular-nums">{summary.unknown}</p>
            </div>
          ) : null}
          {summary.nextBack ? (
            <div className="min-w-0">
              <p className="text-muted-foreground text-xs">{t('nextBack')}</p>
              <p className="text-foreground text-sm font-medium tabular-nums">{formatReset(summary.nextBack, now, locale)}</p>
            </div>
          ) : null}
        </div>
      ) : null}
      {legacy.length ? (
        <ul className="space-y-1">
          {legacy.map((secret) => (
            <LegacyLogin key={`${secret.storage}:${secret.secret_id}`} accountId={accountId} projectId={projectId} secret={secret} now={now} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** The windows of the project-stored ChatGPT login, for its legacy card in the OpenAI sheet. */
export function LegacyChatGptUsage({ accountId, projectId }: { accountId: string; projectId: string }) {
  const { logins, dataUpdatedAt } = useSubscriptionLogins(accountId, projectId);
  const secret = logins.find((login) => login.provider_id === 'codex' && login.storage === 'project');
  return secret ? <LegacyWindows accountId={accountId} projectId={projectId} secret={secret} now={dataUpdatedAt} /> : null;
}

function LegacyWindows({ accountId, projectId, secret, now }: { accountId: string; projectId: string; secret: SubscriptionConnection; now: number }) {
  const t = useTranslations('subscriptionUsage');
  const live = useLoginUsage(accountId, projectId, secret.secret_id, secret.storage, secret.can_use && usable(secret));
  const usage = shownUsage(live.data?.usage, secret.usage);
  const at = Math.max(now, live.dataUpdatedAt);
  if (!usable(secret)) return null;
  return (
    <div className="flex flex-col gap-2.5" data-subscription-login="">
      {loginLimit(usage, at).limited ? <Badge size="sm" variant="destructive" className="self-start">{t('limitReached')}</Badge> : null}
      <SubscriptionLoginWindows providerId={secret.provider_id} usage={usage} loading={live.isFetching} error={live.isError} now={at} />
    </div>
  );
}
