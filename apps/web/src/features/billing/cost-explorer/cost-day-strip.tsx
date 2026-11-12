'use client';

import type { CostSeriesPoint } from '@kortix/sdk';

import { cn } from '@kortix/ui';
import { Skeleton } from '@kortix/ui/skeleton';
import { formatSessionCostCredits } from '@kortix/ui/internal/billing/session-cost-format';

/**
 * Five steps of one `kortix-blue` ramp, light to dark. Step 0 is a day with no
 * spend: the neutral well, so an idle day reads as empty rather than as the
 * palest blue. One hue on purpose: the strip encodes magnitude, and a second
 * hue would read as a second category.
 */
const LEVEL_CLASS = [
  'bg-muted',
  // /25, not the /15 status tint: on the dark surface /15 measured within a
  // shade of the idle well, so a low-spend day read as no spend at all.
  'bg-kortix-blue/25', // audit:allow sequential chart ramp step, not a status tint
  'bg-kortix-blue/40', // audit:allow sequential chart ramp step, not a status tint
  'bg-kortix-blue/70', // audit:allow sequential chart ramp step, not a status tint
  'bg-kortix-blue',
] as const;

export type HeatLevel = 0 | 1 | 2 | 3 | 4;

/**
 * Which of the five steps a day's spend falls in, against the largest day on
 * the page. Any spend at all is at least step 1, so a tiny day never draws as
 * an idle one. `max` is shared by every row on the page, so two rows compare.
 *
 * On a square-root scale: spend is spiky, and on a linear one a single heavy
 * day (measured locally: 4,500 credits against typical days of 50 to 300) put
 * every other day of the page on the palest step.
 */
export function heatLevel(value: number, max: number): HeatLevel {
  if (!(value > 0) || !(max > 0)) return 0;
  const ratio = Math.sqrt(Math.min(1, value / max));
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.25) return 2;
  return 1;
}

/** The largest daily total across every series on the page. */
export function maxDailyCost(
  series: readonly (readonly CostSeriesPoint[] | null | undefined)[],
): number {
  let max = 0;
  for (const points of series) {
    for (const point of points ?? []) max = Math.max(max, point.total_cost);
  }
  return max;
}

function formatDay(day: string, locale: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export interface CostDayStripProps {
  /** Every UTC day of the window, oldest first: the account series' days, so
   *  every row has the same columns even where a workspace was idle. */
  days: readonly string[];
  /** This workspace's daily series. `undefined` while it loads, `null` when
   *  it could not be read: the cell then stays empty. */
  series: readonly CostSeriesPoint[] | null | undefined;
  max: number;
  locale: string;
  /** The strip's accessible summary, from its busiest day (formatted date and
   *  USD), or `null` when the workspace had no spend in the window. */
  describe: (peak: { day: string; usd: number } | null) => string;
}

/**
 * One row of the workspace-by-day heatmap: a cell per day, its fill the day's
 * spend. Cells are square with a 1px gap; the strip rounds as a whole, so a
 * 17px cell does not round into a dot. Each cell's figure is in a native `title`, not a `Hint`: a page holds
 * up to 25 rows of 30 cells, and 750 tooltip instances cost more than they
 * explain. Assistive technology gets one summary for the whole strip.
 */
export function CostDayStrip({ days, series, max, locale, describe }: CostDayStripProps) {
  if (days.length === 0 || series === null) return null;
  if (!series) {
    return <Skeleton className="h-5 w-full rounded-sm" />;
  }

  const byDay = new Map(series.map((point) => [point.day, point.total_cost]));
  const peak = series.reduce<CostSeriesPoint | null>(
    (best, point) => (point.total_cost > (best?.total_cost ?? 0) ? point : best),
    null,
  );
  const summary = describe(peak ? { day: formatDay(peak.day, locale), usd: peak.total_cost } : null);

  return (
    <div role="img" aria-label={summary} className="flex h-5 w-full gap-px overflow-hidden rounded-sm">
      {days.map((day) => {
        const value = byDay.get(day) ?? 0;
        return (
          <span
            key={day}
            title={`${formatDay(day, locale)} · ${formatSessionCostCredits(value, locale)}`}
            className={cn('min-w-0 flex-1', LEVEL_CLASS[heatLevel(value, max)])}
          />
        );
      })}
    </div>
  );
}

/** The ramp as a key: `Less ▢▢▢▢▢ More`, the words passed in by the caller. */
export function CostDayStripLegend({ less, more }: { less: string; more: string }) {
  return (
    <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
      {less}
      {LEVEL_CLASS.map((className) => (
        <span key={className} aria-hidden="true" className={cn('size-2.5', className)} />
      ))}
      {more}
    </span>
  );
}
