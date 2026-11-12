'use client';

import type { ComponentType } from 'react';

import {
  ArrowDownLeftIcon,
  ClockCounterClockwiseIcon,
  CpuIcon,
  HardDrivesIcon,
  SlidersHorizontalIcon,
  SparkleIcon,
} from '@phosphor-icons/react';

import { cn } from '@kortix/ui';
import { InlineMetaTime } from '@kortix/ui/inline-meta';
import { formatUsdAsCredits } from '@kortix/shared';

import { useLocale, useTranslations } from '@/i18n/use-translations';
import {
  creditTransactionBadge,
  formatSignedCredits,
  localizedTransactionBadges,
  type CreditTransactionRow,
} from './transactions-table';

/**
 * What kind of ledger entry a row is, for its tile. Five kinds, each with one
 * `kortix-*` accent: the three cost types in the colours the Session costs tab
 * gives them (compute blue, LLM orange, storage purple), credits coming in
 * green, and everything else (expiry, adjustment, proxy) neutral.
 */
export type CreditActivityKind = 'compute' | 'llm' | 'storage' | 'credit' | 'other';

const CREDIT_IN_TYPES = new Set([
  'tier_grant',
  'free_tier_grant',
  'purchase',
  'auto_topup',
  'topup_bonus',
  'machine_bonus',
  'admin_grant',
  'promotional',
  'daily_refresh',
  'refund',
  'compute_refund',
]);

/**
 * The kind of a ledger row. Typed debits say what they are. A generic `usage`
 * row does not, so its description decides: the API writes compute charges as
 * `Sandbox compute · …` and storage charges as `Files storage · …` (older rows
 * `Storage …`); any other usage row is model traffic, e.g. `LLM gateway
 * admission hold`.
 */
export function creditActivityKind(type: string, description: string | null): CreditActivityKind {
  // Any `*_refund` gives credits back, e.g. the LLM gateway returning an
  // admission hold (`llm_reservation_refund`), which is most of a busy ledger.
  if (CREDIT_IN_TYPES.has(type) || type.endsWith('_refund')) return 'credit';
  if (type === 'compute_debit') return 'compute';
  if (type === 'storage_debit') return 'storage';
  if (type === 'llm_debit' || type === 'token_deduction' || type === 'token_overage') return 'llm';
  if (type === 'usage') {
    const text = (description ?? '').trim().toLowerCase();
    if (text.startsWith('sandbox compute')) return 'compute';
    if (text.startsWith('storage') || text.startsWith('files storage')) return 'storage';
    return 'llm';
  }
  return 'other';
}

const KIND_STYLE: Record<
  CreditActivityKind,
  { tile: string; glyph: string; Icon: ComponentType<{ className?: string; weight?: 'fill' }> }
> = {
  compute: { tile: 'bg-kortix-blue/15', glyph: 'text-kortix-blue', Icon: CpuIcon },
  llm: { tile: 'bg-kortix-orange/15', glyph: 'text-kortix-orange', Icon: SparkleIcon },
  storage: { tile: 'bg-kortix-purple/15', glyph: 'text-kortix-purple', Icon: HardDrivesIcon },
  credit: { tile: 'bg-kortix-green/15', glyph: 'text-kortix-green', Icon: ArrowDownLeftIcon },
  other: { tile: 'bg-muted', glyph: 'text-muted-foreground', Icon: SlidersHorizontalIcon },
};

const UUID = /\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * A ledger description with every full UUID cut to its first eight hex
 * characters. A 36-character id is unreadable in a sentence and pushed the
 * figure off a narrow row; the prefix is enough to match it in a log.
 */
export function shortenLedgerIds(description: string): string {
  return description.replace(UUID, '$1');
}

/**
 * When an entry happened, short: `Nov 10, 06:30 PM` this year, with the year
 * for any other (`Dec 30, 2025, 11:02 PM`), so two entries a year apart never
 * read the same. The full timestamp with its time zone is in the hint.
 */
export function entryTimeFormatter(locale: string, currentYear: number) {
  const base = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } as const;
  const thisYear = new Intl.DateTimeFormat(locale, base);
  const otherYear = new Intl.DateTimeFormat(locale, { ...base, year: 'numeric' });
  return (date: Date) => (date.getFullYear() === currentYear ? thisYear : otherYear).format(date);
}

export function formatEntryTime(date: Date, currentYear: number, locale: string): string {
  return entryTimeFormatter(locale, currentYear)(date);
}

/** An expiring grant's recorded lapse date, or null when it has none. */
function formatLapse(expiresAt: string | null | undefined, locale: string): string | null {
  if (!expiresAt || !Number.isFinite(Date.parse(expiresAt))) return null;
  return new Date(expiresAt).toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * The one credit ledger UI: the customer's Usage → Credit ledger tab and the
 * admin account sheet both render it, so an operator reading a support ticket
 * and the customer reading their own history see identical rows.
 *
 * The credit ledger as an activity feed: one row per entry, a tinted tile that
 * says what kind of entry it is, the description as the title, then when, the
 * entry type and the credit pool on one muted line. The signed amount and the
 * balance after sit on the right in ink: a debit is not an error, so neither
 * figure is red or green.
 */
export function CreditActivityFeed({ rows }: { rows: CreditTransactionRow[] }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const locale = useLocale();
  const badges = localizedTransactionBadges(tI18nComplete);
  const amountLabel = tI18nComplete.raw('text2a6b24ad2872');
  const balanceLabel = tHardcodedUi.raw('componentsBillingCreditTransactions.line200JsxTextCreditsAfter');
  // Two formatters per render, not one per row.
  const formatTime = entryTimeFormatter(locale, new Date().getFullYear());

  return (
    <div className="bg-popover rounded-md border">
      {/* One header names the two figures at the end of every row, from `sm`
          where both show. Each row repeats the names for a screen reader. */}
      <div
        aria-hidden="true"
        className="border-border text-muted-foreground hidden items-center gap-3 border-b px-4 py-2 text-xs sm:flex"
      >
        <span className="flex-1" />
        <span className="shrink-0 text-right">{amountLabel}</span>
        <span className="w-24 shrink-0 text-right">{balanceLabel}</span>
      </div>
      <ul className="divide-border divide-y">
        {rows.map((row) => {
          const kind = creditActivityKind(row.type, row.description);
          const { tile, glyph, Icon } =
            row.type === 'expired'
              ? { ...KIND_STYLE.other, Icon: ClockCounterClockwiseIcon }
              : KIND_STYLE[kind];
          const label = (badges[row.type] ?? creditTransactionBadge(row.type)).label;
          const title = row.description
            ? shortenLedgerIds(row.description)
            : tHardcodedUi.raw('i18nComplete.textbcd8cc53f40e');
          const created = row.createdAt ? new Date(row.createdAt) : null;
          const meta = [
            label,
            row.isExpiring === undefined
              ? null
              : row.isExpiring
                ? [tI18nComplete.raw('textff44a401445c'), formatLapse(row.expiresAt, locale)]
                    .filter(Boolean)
                    .join(' ')
                : tI18nComplete.raw('text455a95491f40'),
          ].filter(Boolean);

          return (
            <li key={row.id} className="flex items-center gap-3 px-4 py-3">
              <span
                aria-hidden="true"
                className={cn('flex size-9 shrink-0 items-center justify-center rounded-sm', tile)}
              >
                <Icon weight="fill" className={cn('size-4', glyph)} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-foreground truncate text-sm" title={title}>
                  {title}
                </p>
                {/* The time sits outside the truncated span: `InlineMetaTime`
                    is a focusable <time>, and `truncate` (overflow hidden)
                    would cut off its focus ring. */}
                <p className="text-muted-foreground flex min-w-0 gap-1 text-xs">
                  {created && !Number.isNaN(created.getTime()) ? (
                    <span className="shrink-0">
                      <InlineMetaTime date={created} locale={locale}>
                        {formatTime(created)}
                      </InlineMetaTime>
                      {meta.length > 0 ? ' ·' : null}
                    </span>
                  ) : null}
                  <span className="min-w-0 truncate">{meta.join(' · ')}</span>
                </p>
              </div>
              <span
                className={cn(
                  'text-foreground shrink-0 text-sm tabular-nums',
                  row.amount > 0 && 'font-medium',
                )}
              >
                <span className="sr-only">{amountLabel} </span>
                {formatSignedCredits(row.amount)}
              </span>
              <span className="text-muted-foreground hidden w-24 shrink-0 text-right text-xs tabular-nums sm:block">
                <span className="sr-only">{balanceLabel} </span>
                {formatUsdAsCredits(row.balanceAfter)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
