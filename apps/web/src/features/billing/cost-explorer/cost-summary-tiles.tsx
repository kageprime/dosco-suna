import { useLocale, useTranslations } from '@/i18n/use-translations';
import type { CostSummary } from '@kortix/sdk';

import { Skeleton } from '@kortix/ui/skeleton';

import { formatSessionCostCredits } from '@kortix/ui/internal/billing/session-cost-format';
import { COST_TYPE_COLOR } from './cost-type-color';

export interface CostSummaryTile {
  label: string;
  value: string;
  /** Muted unit beside the value (`credits`). Absent for a count or a duration. */
  unit?: string;
}

export interface CostSummaryTilesProps {
  summary: CostSummary | undefined;
  isLoading: boolean;
  extraTiles: CostSummaryTile[];
}

interface PeriodDelta {
  label: string;
  /** Never map to colour — a cost delta has no good/bad direction. Spending
   *  less is not inherently "good", so green-up/red-down would editorialise a
   *  fact. Kept only for callers that need the sign for non-colour purposes
   *  (e.g. an aria-label or a neutral glyph), not for styling. */
  direction: 'up' | 'down' | 'flat';
}

export function formatPeriodDelta(current: number, previous: number): PeriodDelta | null {
  // A percentage against zero is meaningless, not infinite. Show nothing.
  if (previous <= 0) return null;
  const change = Math.round(((current - previous) / previous) * 100);
  if (change === 0) return { label: '0%', direction: 'flat' };
  return { label: `${change > 0 ? '+' : ''}${change}%`, direction: change > 0 ? 'up' : 'down' };
}

/**
 * The hero of every cost level: one total, its change against the window
 * before, and the split by cost type beside it. Replaces a four-tile grid in
 * which the total and its own parts read at the same weight, so nothing said
 * which figure was the answer.
 *
 * Each part carries the `kortix-*` swatch its bars use in the chart below
 * (`COST_TYPE_COLOR`), and a share of the total. The delta stays ink: a cost
 * change has no good or bad direction (see `PeriodDelta`).
 */
export function CostSummaryTiles({ summary, isLoading, extraTiles }: CostSummaryTilesProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tCredits = useTranslations('settings.credits');
  const locale = useLocale();

  if (isLoading || !summary) {
    return (
      <div
        className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4"
        aria-label={tI18nComplete.raw('textb400f4160d8e')}
      >
        <div className="space-y-2">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-7 w-32" />
        </div>
        <div className="flex gap-8">
          {Array.from({ length: 3 + extraTiles.length }, (_, index) => (
            <div key={index} className="space-y-2">
              <Skeleton className="h-3 w-14" />
              <Skeleton className="h-4 w-20" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const totals = summary.totals;
  const total = totals.total_cost;
  const delta = formatPeriodDelta(total, summary.previous.total_cost);
  const unit = (usd: number) => tCredits('unit', { count: usd * 100 });
  const parts = [
    { key: 'compute_cost', label: tI18nComplete.raw('textcedc516df056'), value: totals.compute_cost },
    { key: 'llm_cost', label: 'LLM', value: totals.llm_cost },
    { key: 'storage_cost', label: tCredits('storage'), value: totals.storage_cost ?? 0 },
  ] as const;

  return (
    <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
      <div className="min-w-0">
        <p className="text-muted-foreground text-xs">{tI18nComplete.raw('textc9b3c38247f7')}</p>
        <p className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-foreground text-2xl font-semibold tracking-tight tabular-nums">
            {formatSessionCostCredits(total, locale)}
          </span>
          <span className="text-muted-foreground text-sm">{unit(total)}</span>
          {delta ? (
            <span
              className="text-muted-foreground text-xs tabular-nums"
              aria-label={tI18nComplete('textaf82ae6a8d73', { value0: delta.label })}
            >
              {delta.label}
            </span>
          ) : null}
        </p>
      </div>

      <dl className="flex flex-wrap gap-x-8 gap-y-3">
        {parts.map((part) => (
          <div key={part.key} className="min-w-0">
            <dt className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: COST_TYPE_COLOR[part.key] }}
              />
              {part.label}
            </dt>
            <dd className="text-foreground mt-1 text-sm font-medium tabular-nums">
              {formatSessionCostCredits(part.value, locale)}
              <span className="text-muted-foreground ml-1 text-xs font-normal">
                {formatShare(part.value, total)}
              </span>
            </dd>
          </div>
        ))}
        {extraTiles.map((tile) => (
          <div key={tile.label} className="min-w-0">
            <dt className="text-muted-foreground text-xs">{tile.label}</dt>
            <dd className="text-foreground mt-1 text-sm font-medium tabular-nums">
              {tile.value}
              {tile.unit ? (
                <span className="text-muted-foreground ml-1 text-xs font-normal">{tile.unit}</span>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** A part's share of the total as a whole percent. `<1%` for a real but tiny
 *  part, so storage at 0.02% does not read as nothing; empty for a zero total,
 *  where a share has no meaning. */
export function formatShare(part: number, total: number): string {
  if (total <= 0 || part <= 0) return total > 0 ? '0%' : '';
  const share = (part / total) * 100;
  if (share < 1) return '<1%';
  return `${Math.round(share)}%`;
}
