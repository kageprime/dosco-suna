'use client';

/**
 * `PanelCard` — one section of the session's docked column. Outputs, Changes,
 * Context, Preview, Plan, Background tasks and Change requests are all this
 * component with different contents.
 *
 * A section is a plain title over its rows, always open. No header button, no
 * caret, no count chip: the rows ARE the count. Sections are divided by one
 * hairline on the column's inset (`mx-3`), never full-bleed.
 *
 * The column's one text edge is `px-3`. Rows sit on `mx-1` and pad `px-2`, so
 * their text starts on the same x as the title and their hover fill reaches a
 * little past it — see `PANEL_ROW`.
 */

import { cn } from '../../../lib/utils';
import type { ReactNode } from 'react';

/** The row every section draws: one height, one hover, one text edge. Its
 *  parent is a flex row (`<li className="flex">`) so `flex-1` fills it. */
export const PANEL_ROW = cn(
  'mx-1 flex h-8 flex-1 min-w-0 items-center gap-3 rounded-md px-2 text-left text-sm',
  'hover:bg-hover transition-colors duration-(--duration-fast) ease-out',
  'disabled:cursor-default disabled:hover:bg-transparent',
);

/** The fixed leading slot, so every row's label starts on one x. */
export const PANEL_ROW_ICON = 'text-muted-foreground flex w-5 shrink-0 items-center justify-center [&_svg]:size-4';

export interface PanelCardProps {
  title: string;
  /** Stands beside the title: Plan's "3 of 6" dial. */
  indicator?: ReactNode;
  /** Second line under the title — Plan uses it for its live step label. */
  subtitle?: ReactNode;
  children?: ReactNode;
  emptyText?: string;
  /** Extra content under `emptyText` — the empty Context section's "Add context". */
  emptyActions?: ReactNode;
  isEmpty: boolean;
  /** Override the body padding — a full-bleed list wants none. */
  contentClassName?: string;
  /** A control on the title's right edge (Outputs' "download all"). */
  headerAction?: ReactNode;
  /**
   * This section absorbs the column's leftover height: it is the only one the
   * flex algorithm may shrink, and when it shrinks its BODY scrolls while its
   * title stays put. Exactly ONE section in the column may set it.
   */
  fill?: boolean;
}

export function PanelCard({
  title,
  indicator,
  subtitle,
  children,
  emptyText,
  emptyActions,
  isEmpty,
  contentClassName = 'pb-3',
  headerAction,
  fill = false,
}: PanelCardProps) {
  return (
    <section
      aria-label={title}
      className={cn(
        'text-foreground group/section',
        fill ? 'flex min-h-0 flex-col' : 'shrink-0',
      )}
    >
      {/* Between sections only: the first section draws no rule above it. */}
      <div className="border-border mx-3 border-t group-first/section:hidden" aria-hidden />
      <header className="flex min-h-8 shrink-0 items-center justify-between gap-2 px-3 pt-4 pb-1.5">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <h3 className="text-foreground truncate text-sm font-medium">{title}</h3>
            {indicator && <span className="flex shrink-0">{indicator}</span>}
          </span>
          {subtitle}
        </span>
        {headerAction && <span className="flex shrink-0 items-center">{headerAction}</span>}
      </header>
      <div className={cn(fill && 'flex min-h-0 flex-col', contentClassName)}>
        {isEmpty ? (
          <div className="flex flex-col items-start gap-2 px-3">
            {emptyText && <p className="text-muted-foreground text-sm text-pretty">{emptyText}</p>}
            {emptyActions}
          </div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}
