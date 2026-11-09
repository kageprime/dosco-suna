'use client';

/**
 * The one grammar every block on /design-system is written in.
 *
 * A block is a `Spec`: one name, one optional info icon, one optional source
 * path, then rows. A row is a `SpecRow`: a short label in a fixed left column
 * and the rendered thing on the right. Parallel blocks read as a table, and
 * the explanation sits behind the info icon (`InfoHint`, a hover card) instead
 * of a description paragraph under every title. The rule is in
 * `.agents/skills/kortix-design-system/SKILL.md`, "Spec grammar".
 *
 * Nothing here holds a value: colors, spacing and type come from the tokens.
 */

import { cn } from '@kortix/ui';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@kortix/ui/hover-card';
import { InfoIcon } from '@phosphor-icons/react';
import { useId, useState, type ReactNode } from 'react';

/**
 * The info icon with a hover card. The only way a block on this page explains
 * itself beyond its name. It opens on hover and on keyboard focus (a button),
 * and on tap (read on pointerdown, because the Radix trigger cancels the click
 * on touch). The card is the one
 * animated floating panel (motion.md, D4a). The content carries an id and the
 * trigger points at it with `aria-describedby`, so a screen reader hears the
 * explanation when the card is open.
 */
export function InfoHint({
  children,
  label = 'About',
  className,
}: {
  children: ReactNode;
  /** Accessible name of the trigger: "About <the thing>". */
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={150} closeDelay={100}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-expanded={open}
          aria-describedby={open ? contentId : undefined}
          // Touch: Radix's trigger calls preventDefault on touchstart, which
          // cancels the synthesized click, so the tap is read on pointerdown,
          // which fires first. Outside taps and Escape close through Radix's
          // dismiss layer. Mouse hover and keyboard focus open through Radix's
          // own timers. A mouse click does nothing, so it never races them; a
          // keyboard activation (click with detail 0) reopens after Escape.
          onPointerDown={(event) => {
            if (event.pointerType !== 'touch') return;
            event.preventDefault();
            setOpen((v) => !v);
          }}
          onClick={(event) => {
            if (event.detail === 0) setOpen(true);
          }}
          className={cn(
            'text-muted-foreground hover:text-foreground focus-visible:ring-ring duration-fast inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm transition-colors focus-visible:ring-1 focus-visible:outline-none',
            className,
          )}
        >
          <InfoIcon className="size-3.5" />
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        id={contentId}
        side="top"
        align="start"
        className="text-muted-foreground [&_code]:text-foreground w-72 text-xs leading-relaxed [&_code]:font-mono"
      >
        {children}
      </HoverCardContent>
    </HoverCard>
  );
}

/** "About Button" when the name is a string; "About" when it is a node. */
export function aboutLabel(name: ReactNode): string {
  return typeof name === 'string' || typeof name === 'number' ? `About ${name}` : 'About';
}

/** One documented thing: a component, a pattern, a token family. */
export function Spec({
  id,
  name,
  about,
  source,
  children,
  className,
}: {
  id: string;
  name: ReactNode;
  /** The explanation. Rendered behind the info icon, never as a paragraph. */
  about?: ReactNode;
  /** The import path or file, in mono. */
  source?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={cn('scroll-mt-24 space-y-3', className)}>
      <div className="flex min-w-0 items-center gap-1.5">
        <h4 className="text-foreground truncate text-sm font-medium">{name}</h4>
        {about ? <InfoHint label={aboutLabel(name)}>{about}</InfoHint> : null}
        {source ? (
          <code className="text-muted-foreground ml-auto hidden truncate font-mono text-xs sm:block">
            {source}
          </code>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/**
 * One row inside a Spec: a label column, then the demo. Every row in every
 * block shares the same column, so a visitor scans down one edge.
 */
export function SpecRow({
  label,
  about,
  children,
  className,
}: {
  label: ReactNode;
  about?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'grid gap-x-4 gap-y-2 sm:grid-cols-[7rem_minmax(0,1fr)] sm:items-start',
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-1 sm:pt-2">
        <span className="text-muted-foreground text-xs leading-snug break-words">{label}</span>
        {about ? <InfoHint label={aboutLabel(label)}>{about}</InfoHint> : null}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** The frame a demo sits in: the page surface plus a hairline (color.md, in-flow). */
export function DemoContainer({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'bg-background border-border max-w-full min-w-0 rounded-md border p-5',
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Parallel cells, for the things that must be compared side by side: the four
 * states of a list, the hover and press of a control, light beside dark.
 */
export function SpecGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid gap-3 sm:grid-cols-2', className)}>{children}</div>;
}

/** One cell of a SpecGrid: a label row, then the thing, centred. */
export function SpecCell({
  label,
  about,
  children,
  className,
  contentClassName,
}: {
  label: ReactNode;
  about?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <div
      className={cn(
        'bg-background border-border flex min-w-0 flex-col overflow-hidden rounded-md border',
        className,
      )}
    >
      <div className="border-border flex items-center gap-1 border-b px-4 py-2">
        <span className="text-muted-foreground truncate text-xs">{label}</span>
        {about ? <InfoHint label={aboutLabel(label)}>{about}</InfoHint> : null}
      </div>
      <div className={cn('flex min-h-32 flex-1 items-center justify-center p-5', contentClassName)}>
        {children}
      </div>
    </div>
  );
}
