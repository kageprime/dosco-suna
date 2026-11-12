'use client';

import { AccountStorageCard } from './account-storage';
import { COST_TYPE_COLOR } from './cost-explorer/cost-type-color';
import type { UiTranslator } from '@/i18n/translator';
import { useLocale, useTranslations } from '@/i18n/use-translations';
/**
 * The account overview block at the top of the Billing tab: what you can
 * spend, what plan you are on, what you spent this period, and the limits
 * that plan enforces.
 *
 * **Restyle (2026-08-13).** This used to render three separate labelled
 * sections — "Plan" (a two-up of two bordered cards), "Spend this period" (a
 * bordered divided table), and "Limits" (a bordered panel of progress bars) —
 * inside a tab that then wrapped the whole thing in a fourth "Plan, wallet and
 * spend" heading. Five headings and four boxes to say three numbers. Jay's
 * brief: less crowded, less nesting, no jargon.
 *
 * What it renders now:
 *
 * 1. **One balance card.** The number you actually came here for is the
 *    largest thing on the pane — available balance in credits, with its
 *    dollar equivalent under it — and the plan sits opposite it as a quiet right-hand
 *    column (plan name, then status or renewal date). A hairline splits off a
 *    three-column strip for this period's spend: Compute, LLM, Total. That
 *    strip replaces the old bordered spend table entirely.
 * 2. **One limits group**, only when the API reports limits. Hairline rows,
 *    `active / limit` right-aligned, red at the cap. The progress bars are
 *    gone: a bar under every row tripled the block's height to restate a
 *    fraction the numbers already give exactly.
 *
 * **Credits are the unit (2026-10-16).** Everything the account holds or
 * spent reads in credits (1 credit = $0.01): the balance and the spend strip.
 * Prices stay in dollars: the plan's `$3,000/mo`. The API sends USD; only
 * the display converts.
 *
 * Wording: "wallet" → "Available balance", and the "Sandbox runtime" /
 * "Inference" hints under Compute and LLM are dropped — they explained the
 * words to nobody who did not already know them.
 */

import { Skeleton } from '@kortix/ui/skeleton';
import { formatWholeUsd } from '@kortix/ui/internal/billing/compute-pricing';
import { useAccountState } from '@kortix/ui/internal/billing/use-account-state';
import { cn } from '@kortix/ui';
import { CreditExpiry } from '@/features/billing/credit-expiry';
import { FreeGrantNotice } from '@/features/billing/free-grant-notice';
import { resolvedPlan, type AccountState } from '@kortix/sdk';
import { formatUsdAsCredits } from '@kortix/shared';
import {
  DEFAULT_PLAN_STATUS_COPY,
  PlanStatusDot,
  formatIsoDate,
  formatShortDate,
  usePlanStatusCopy,
  type PlanStatusCopy,
} from './plan-status';

type LimitRow = {
  id: string;
  label: string;
  active: number;
  limit: number;
};

interface AccountOverviewTabProps {
  /** Scope the balance/limits/spend display to a specific account.
   *  Required on /accounts/[id]; omit on global surfaces. */
  accountId?: string;
}

/** Container: owns the account-state read, renders the view. */
export function AccountOverviewTab({ accountId }: AccountOverviewTabProps = {}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const accountState = useAccountState({ accountId });

  if (accountState.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-[9.5rem] w-full rounded-md" />
        <Skeleton className="h-28 w-full rounded-md" />
      </div>
    );
  }

  const state = accountState.data;
  if (!state) {
    return <p className="text-muted-foreground text-sm">{tI18nComplete.raw('text68b8f8d47a7a')}</p>;
  }

  // Two cards side by side from `lg`: what you have, and what your files hold.
  // `items-start`: each card is as tall as its content. Stretched to the taller
  // storage card, the balance card had a hole in the middle on real data.
  return (
    <div className="space-y-6">
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <AccountOverviewView state={state} />
        <AccountStorageCard accountId={accountId} />
      </div>
      <AccountLimits state={state} />
    </div>
  );
}

/**
 * Presentational only — no hooks, no data fetching, no query client. The same
 * container/view split `billing-tab.tsx` and `profile-tab.tsx` use, and for
 * the same reason: the shapes worth reviewing (a credits plan, out of credits,
 * negative balance) cannot be produced locally without provisioning three
 * accounts and a Stripe subscription, so the view has to be renderable against
 * a fixed `AccountState` with no API, no auth, and no billing flag.
 */
export function AccountOverviewView({ state }: { state: AccountState }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tCredits = useTranslations('settings.credits');
  const locale = useLocale();
  const wallet = state.credits?.total ?? 0;
  const isNegative = wallet < 0;
  const usage = state.usage_this_period;

  return (
    <section className="bg-popover flex min-w-0 flex-col gap-4 rounded-md border px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h3 className="text-foreground text-sm font-medium">
            {tI18nComplete.raw('text3ab7dd8428d1')}
          </h3>
          {/* `tabular-nums`, deliberately NOT `font-mono`. Tabular figures
              give the equal-width digits a balance wants; a monospace face
              gives the ',' the same advance as a '0' too, which opens visible
              gaps mid-number. */}
          <p className="mt-2 flex flex-wrap items-baseline gap-x-2">
            <span
              className={cn(
                'truncate text-2xl leading-none font-semibold tracking-tight tabular-nums',
                isNegative ? 'text-kortix-red' : 'text-foreground',
              )}
            >
              {formatUsdAsCredits(wallet, { locale })}
            </span>
            <span className="text-muted-foreground text-sm">
              {tCredits('unit', { count: Math.abs(wallet) * 100 })} · ≈{' '}
              {formatUsd(Math.abs(wallet), locale)}
              {isNegative ? ` ${tI18nComplete.raw('text4fef65587333')}` : ''}
            </span>
          </p>
          {state.credits.monthly > 0 && <CreditExpiry expiresAt={state.credits.expires_at} />}
          <FreeGrantNotice state={state} className="mt-1.5 max-w-md" />
        </div>
        <PlanSummary state={state} />
      </div>

      {usage ? <PeriodSpend usage={usage} locale={locale} /> : null}
    </section>
  );
}

/**
 * This period's spend: the total, then its parts with the swatch each one has
 * on the Session costs chart, and one bar of the split. The bar is in
 * proportion to the parts, not to the total: the total also holds charges the
 * account state does not break down, so a bar against it would leave a gap the
 * reader cannot name.
 */
function PeriodSpend({
  usage,
  locale,
}: {
  usage: NonNullable<AccountState['usage_this_period']>;
  locale: string;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tCredits = useTranslations('settings.credits');
  const parts = [
    { key: 'compute_cost', label: tI18nComplete.raw('textcedc516df056'), value: usage.compute_usd },
    { key: 'llm_cost', label: 'LLM', value: usage.llm_usd },
    { key: 'storage_cost', label: tCredits('storage'), value: usage.storage_usd ?? 0 },
  ] as const;
  const partsTotal = parts.reduce((sum, part) => sum + Math.max(0, part.value), 0);

  return (
    <div className="border-border space-y-3 border-t pt-4">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <SpendStat
          label={tI18nComplete.raw('text97c8335e2880')}
          value={usage.total_usd}
          locale={locale}
          strong
        />
        {parts.map((part) => (
          <SpendStat
            key={part.key}
            label={part.label}
            value={part.value}
            locale={locale}
            color={COST_TYPE_COLOR[part.key]}
          />
        ))}
      </dl>
      {partsTotal > 0 ? (
        <div className="flex h-1.5 w-full gap-px overflow-hidden rounded-full" aria-hidden="true">
          {parts.map((part) =>
            part.value > 0 ? (
              <span
                key={part.key}
                className="h-full min-w-[2px]"
                style={{
                  width: `${(part.value / partsTotal) * 100}%`,
                  backgroundColor: COST_TYPE_COLOR[part.key],
                }}
              />
            ) : null,
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Concurrency and count limits, at or near their cap. Below the two cards,
 *  because a limit is about what you can run, not what you have spent. */
function AccountLimits({ state }: { state: AccountState }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const limits = buildLimitRows(state.limits, tI18nComplete);
  if (limits.length === 0) return null;
  return (
    <section className="space-y-2">
      <h3 className="text-foreground text-sm font-medium">{tI18nComplete.raw('textdffb64dc7001')}</h3>
      <div className="bg-popover divide-border divide-y rounded-md border">
        {limits.map((row) => {
          const atCap = row.limit > 0 && row.active >= row.limit;
          return (
            <div key={row.id} className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
              <span className="text-foreground min-w-0 truncate">{row.label}</span>
              <span
                className={cn(
                  'shrink-0 font-medium tabular-nums',
                  atCap ? 'text-kortix-red' : 'text-muted-foreground',
                )}
              >
                {row.active} / {row.limit}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export interface PlanStatus {
  /** Plan name as the product names it: Free or Credits. */
  name: string;
  /** Qualifier under the name: the credits plan's monthly amount, e.g. `$100/mo`. */
  sublabel: string | null;
  /** `Renews Sep 24` · `Cancels Sep 24` · `Active` · `past due`. */
  detail: string;
  /** A live subscription — drives the status dot, which is absent otherwise. */
  isActive: boolean;
  /** Winding down at period end: the dot goes orange rather than green. */
  isWindingDown: boolean;
  /** `→ $3,000/mo from Nov 14` — a scheduled credits-plan cut, or null. */
  scheduled: string | null;
}

/** Where the plan stands, in one line — one early return per case, in the
 *  precedence order the old nested ternary read: grace → cancel-at-period-end
 *  → renews → active → raw status → no subscription. */
function planStatusDetail(
  sub: AccountState['subscription'],
  text: PlanStatusCopy,
  periodEnd: string | null,
  graceEnds: string | null,
): string {
  if (graceEnds) return text.graceUntil!(graceEnds);
  if (sub?.cancel_at_period_end) {
    return periodEnd ? text.cancels(periodEnd) : text.cancelsAtPeriodEnd;
  }
  if (sub?.status === 'active') {
    return periodEnd ? text.renews(periodEnd) : text.active;
  }
  // Raw Stripe statuses are snake_case ('past_due', 'incomplete_expired').
  // Shown to a person, so they read as words.
  if (sub?.status) return text.status(sub.status);
  return text.noSubscription;
}

export function describePlanStatus(
  state: AccountState,
  copy: PlanStatusCopy = DEFAULT_PLAN_STATUS_COPY,
): PlanStatus {
  const plan = resolvedPlan(state);
  const sub = state.subscription;
  const text = { ...DEFAULT_PLAN_STATUS_COPY, ...copy };

  const periodEnd = sub?.current_period_end
    ? formatDate(sub.current_period_end, text.locale)
    : null;
  const isActive = sub?.status === 'active';
  const graceEnds = formatIsoDate(state.grace?.ends_at, text.locale);
  // A cut waits for the renewal (an upgrade is instant), so the plan line
  // names what it changes to and when. The amount is a price: dollars.
  const scheduledUsd = sub?.scheduled_change?.target_tier.monthly_usd;
  const scheduledOn = formatShortDate(sub?.scheduled_change?.effective_date, text.locale);
  // A split-off workspace's comped plan: no subscription, it ends on a date.
  const compedUntil = formatIsoDate(state.plan_comp?.until, text.locale);
  if (compedUntil) {
    return {
      name: plan.label,
      sublabel: plan.monthlyUsd != null ? text.perMonth(formatWholeUsd(plan.monthlyUsd, text.locale)) : plan.sublabel,
      detail: text.compedUntil!(compedUntil),
      isActive: true,
      isWindingDown: true,
      scheduled: null,
    };
  }

  return {
    name: plan.label,
    sublabel:
      plan.monthlyUsd != null
        ? text.perMonth(formatWholeUsd(plan.monthlyUsd, text.locale))
        : plan.sublabel,
    detail: planStatusDetail(sub, text, periodEnd, graceEnds),
    isActive,
    isWindingDown: Boolean(sub?.cancel_at_period_end),
    scheduled:
      scheduledUsd != null && scheduledOn
        ? text.scheduledFrom!(formatWholeUsd(scheduledUsd, text.locale), scheduledOn)
        : null,
  };
}

/** The right-hand column of the balance card: plan name, then the one line
 *  that says where that plan stands — renewal date when there is a live
 *  subscription, status otherwise. */
function PlanSummary({ state }: { state: AccountState }) {
  const planCopy = usePlanStatusCopy();
  const { name, sublabel, detail, isActive, isWindingDown, scheduled } = describePlanStatus(
    state,
    planCopy,
  );

  return (
    // Right-aligned beside the balance; left-aligned once the row wraps under
    // it on a narrow pane, where a right-aligned block below a left-aligned
    // one has nothing to align to.
    <div className="flex min-w-0 shrink-0 flex-col items-start gap-0.5 text-left sm:items-end sm:text-right">
      <span className="flex items-center gap-1.5">
        <PlanStatusDot isActive={isActive} isWindingDown={isWindingDown} />
        <span className="text-foreground truncate text-sm leading-5 font-medium">{name}</span>
      </span>
      {sublabel ? <span className="text-muted-foreground text-xs">{sublabel}</span> : null}
      <span className="text-muted-foreground text-xs first-letter:capitalize">{detail}</span>
      {scheduled ? (
        <span className="text-muted-foreground text-xs tabular-nums">{scheduled}</span>
      ) : null}
    </div>
  );
}

function SpendStat({
  label,
  value,
  locale,
  strong,
  color,
}: {
  label: string;
  value: number;
  locale: string;
  strong?: boolean;
  /** The cost type's swatch, matching its bars on the Session costs chart. */
  color?: string;
}) {
  const tCredits = useTranslations('settings.credits');
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
        {color ? (
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: color }}
          />
        ) : null}
        <span className="min-w-0 truncate">{label}</span>
      </dt>
      <dd
        className={cn(
          'text-foreground mt-1 text-sm tabular-nums',
          strong ? 'font-semibold' : 'font-medium',
        )}
      >
        {formatUsdAsCredits(value, { locale })}
        <span className="text-muted-foreground ml-1 text-xs font-normal">
          {tCredits('unit', { count: Math.abs(value) * 100 })}
        </span>
      </dd>
    </div>
  );
}

function buildLimitRows(
  limits: NonNullable<ReturnType<typeof useAccountState>['data']>['limits'],
  tI18nComplete: UiTranslator,
): LimitRow[] {
  if (!limits) return [];
  const rows: LimitRow[] = [];
  if (limits.concurrent_runs) {
    rows.push({
      id: 'runs',
      label: tI18nComplete.raw('texte03d3314ccda'),
      active: limits.concurrent_runs.running_count,
      limit: limits.concurrent_runs.limit,
    });
  }
  if (limits.ai_worker_count) {
    rows.push({
      id: 'workers',
      label: tI18nComplete.raw('textd165df0008b1'),
      active: limits.ai_worker_count.current_count,
      limit: limits.ai_worker_count.limit,
    });
  }
  if (limits.custom_mcp_count) {
    rows.push({
      id: 'mcps',
      label: tI18nComplete.raw('text49b3a401c749'),
      active: limits.custom_mcp_count.current_count,
      limit: limits.custom_mcp_count.limit,
    });
  }
  return rows;
}

/**
 * `$99,891.85` — grouped, two decimals, minus before the symbol (`-$3.20`).
 * Since credits became the unit (2026-10-16) this is the quiet `≈ $868.15`
 * line under a balance, never the headline.
 *
 * It used to be `` `$${n.toFixed(2)}` ``, which printed `$99891.85`: no
 * thousands separator, so a five-figure balance had to be counted digit by
 * digit.
 *
 * `style: 'currency'` rather than hand-assembling the string: it is what puts
 * the minus outside the dollar sign instead of producing `$-3.20`. Callers
 * pass the same locale they pass `formatUsdAsCredits`, so the credits number
 * and this line group their digits the same way.
 */
export function formatUsd(amount: number | null | undefined, locale = 'en-US'): string {
  const n = typeof amount === 'number' && Number.isFinite(amount) ? amount : 0;
  return n.toLocaleString(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** `Sep 19` — no year, because a billing period always lands inside one. */
function formatDate(unixSeconds: number, locale?: string): string | null {
  const ms = unixSeconds * 1000;
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return formatShortDate(date.toISOString(), locale);
}
