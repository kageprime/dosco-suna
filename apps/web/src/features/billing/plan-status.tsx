'use client';

/**
 * The plan-status presentation vocabulary: the copy contract, the two ISO
 * date formatters, the status dot, and the translated copy hook. Every
 * surface that says where a plan stands (`PlanCard`, `PlanSummary`) reads
 * this module instead of carrying its own copy of the same ten keys, date
 * arithmetic, or dot markup.
 */

import { cn } from '@kortix/ui';
import { useLocale, useTranslations } from '@/i18n/use-translations';

export interface PlanStatusCopy {
  locale: string;
  /** `$100/mo` — a whole-dollar amount in, the monthly form out. */
  perMonth: (amount: string) => string;
  cancels: (date: string) => string;
  cancelsAtPeriodEnd: string;
  renews: (date: string) => string;
  active: string;
  noSubscription: string;
  status: (status: string) => string;
  /** `SSO stays on until Nov 28` — the grace after Enterprise access ended. */
  graceUntil?: (date: string) => string;
  /** `→ $3,000/mo from Nov 14` — the amount is a monthly price, in dollars. */
  scheduledFrom?: (amount: string, date: string) => string;
  /** `No charge until Nov 28, then Free` — a split-off workspace's comped plan. */
  compedUntil?: (date: string) => string;
}

export const DEFAULT_PLAN_STATUS_COPY: PlanStatusCopy = {
  locale: 'en-US',
  perMonth: (amount) => `${amount}/mo`,
  cancels: (date) => `Cancels ${date}`,
  cancelsAtPeriodEnd: 'Cancels at period end',
  renews: (date) => `Renews ${date}`,
  active: 'Active',
  noSubscription: 'No subscription',
  status: (status) => status.replace(/_/g, ' '),
  graceUntil: (date) => `SSO stays on until ${date}`,
  scheduledFrom: (amount, date) => `→ ${amount}/mo from ${date}`,
  compedUntil: (date) => `No charge until ${date}, then Free`,
};

/** `Nov 14` — a renewal-side date from an ISO timestamp, no year. */
export function formatShortDate(iso: string | null | undefined, locale?: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

/** `Nov 14, 2026` — a calendar date from an ISO timestamp. */
export function formatIsoDate(iso: string | null | undefined, locale?: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** The status dot beside a live plan name: green, orange while winding down. */
export function PlanStatusDot({
  isActive,
  isWindingDown,
}: {
  isActive: boolean;
  isWindingDown: boolean;
}) {
  return isActive ? (
    // Optical, not geometric: a 6px dot centred on a 20px line box sits
    // a hair high against the x-height of the text beside it.
    <span
      aria-hidden
      className={cn(
        'mt-px size-1.5 shrink-0 rounded-full',
        isWindingDown ? 'bg-kortix-orange' : 'bg-kortix-green',
      )}
    />
  ) : null;
}

/** The billing.plan copy `describePlanStatus` reads, in the active locale. */
export function usePlanStatusCopy(): PlanStatusCopy {
  const t = useTranslations('billing.plan');
  const locale = useLocale();
  return {
    locale,
    perMonth: (amount) => t('perMonth', { amount }),
    cancels: (date) => t('cancels', { date }),
    cancelsAtPeriodEnd: t('cancelsAtPeriodEnd'),
    renews: (date) => t('renews', { date }),
    active: t('active'),
    noSubscription: t('noSubscription'),
    graceUntil: (date) => t('graceUntil', { date }),
    scheduledFrom: (amount, date) => t('scheduledFrom', { amount, date }),
    compedUntil: (date) => t('compedUntil', { date }),
    status: (status) =>
      t.has(`statuses.${status}`)
        ? t(`statuses.${status}`)
        : t('status', { status: status.replace(/_/g, ' ') }),
  };
}
