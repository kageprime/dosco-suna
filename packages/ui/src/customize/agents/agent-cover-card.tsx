'use client';

import type { ReactNode } from 'react';
import { CaretRightIcon } from '@phosphor-icons/react';

import { UiLink as Link } from '../../providers/ui-provider';
import { AgentMarkGlyph, agentMarkVars } from '../../internal/components/agent-mark';
import { cn } from '../../internal/lib/utils';

/**
 * An Agents-page card led by the agent's pixel-mark identity header, body, and
 * capability spec footer. Gives every agent a distinct visual signature while
 * surfacing its slug, description, and runtime facts at a glance.
 */
export function AgentCoverCard({
  slug,
  href,
  onClick,
  onIntent,
  title,
  description,
  badges,
  meta,
  coverLabel,
  action,
}: {
  slug: string;
  href: string;
  onClick?: () => void;
  onIntent?: () => void;
  title: ReactNode;
  description?: string | null;
  badges?: ReactNode;
  meta?: ReactNode;
  /** A short pill on the cover's top-right corner — "Default". */
  coverLabel?: string;
  /** A control on the cover's top-right corner (the pin). A sibling of the
   *  card's link, never inside it: a button may not sit in a link. */
  action?: ReactNode;
}) {
  const handleClick = (e: React.MouseEvent) => {
    if (onClick) {
      e.preventDefault();
      onClick();
    }
  };

  return (
    <div className="group/card relative flex">
      <Link
        href={href}
        prefetch
        onClick={handleClick}
        onPointerEnter={onIntent}
        onFocus={onIntent}
        style={agentMarkVars(slug)}
        className={cn(
          'group bg-popover border-border flex flex-1 flex-col overflow-hidden rounded-md border text-left cursor-pointer',
          'hover:bg-hover transition-colors duration-(--duration-normal) ease-out',
          'focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none',
        )}
      >
        <span className="border-border relative flex h-20 items-center justify-between border-b bg-(--mark-tile) px-4">
          <span className="flex items-center gap-3">
            <AgentMarkGlyph slug={slug} size={42} />
          </span>
          <span className="flex items-center gap-1.5">
            {coverLabel ? (
              <span className="bg-background/20 rounded-sm px-2 py-0.5 text-xs font-medium text-(--mark-ink) backdrop-blur-sm">
                {coverLabel}
              </span>
            ) : null}
            <CaretRightIcon
              aria-hidden
              className="size-4 text-(--mark-ink) transition-transform duration-(--duration-fast) ease-out group-hover:translate-x-0.5"
            />
          </span>
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1.5 px-4 pt-3.5 pb-3.5">
          <span className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="text-foreground truncate text-sm font-medium">{title}</span>
              {badges}
            </span>
            <span className="text-muted-foreground shrink-0 font-mono text-xs">@{slug}</span>
          </span>
          {description ? (
            <span className="text-muted-foreground line-clamp-2 text-xs leading-relaxed text-pretty">
              {description}
            </span>
          ) : null}
          {meta ? (
            <span className="border-border text-muted-foreground mt-auto flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-t pt-2.5 text-xs">
              {meta}
            </span>
          ) : null}
        </span>
      </Link>
      {action ? <span className="absolute top-2 right-2">{action}</span> : null}
    </div>
  );
}
