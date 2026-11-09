"use client";

import { Hint } from "./hint";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./hover-card";
import { useState } from "react";
import { cn } from "../lib/utils";
import { Children, Fragment, isValidElement, type ReactNode } from "react";

export interface InlineMetaProps {
  className?: string;
  children: ReactNode;
}

export function InlineMeta({ className, children }: InlineMetaProps) {
  const items = Children.toArray(children).filter(
    (c) => c !== null && c !== undefined && c !== "",
  );
  return (
    <div
      className={cn(
        "text-muted-foreground flex flex-wrap items-center gap-2 text-xs",
        "min-w-0",
        className,
      )}
    >
      {items.map((child, i) => (
        <Fragment key={isValidElement(child) ? (child.key ?? i) : i}>
          {i > 0 && (
            <span
              aria-hidden="true"
              className="bg-muted-foreground size-1 shrink-0 rounded-full"
            />
          )}
          <span className="min-w-0">{child}</span>
        </Fragment>
      ))}
    </div>
  );
}

/** Optional detail for metadata that benefits from an explanation. */
export function InlineMetaHint({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={300}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onPointerDown={(event) => {
            if (event.pointerType !== "touch") return;
            event.preventDefault();
            setOpen((value) => !value);
          }}
          onClick={(event) => {
            if (event.detail === 0) setOpen(true);
          }}
          aria-expanded={open}
          className="hover:text-foreground focus-visible:ring-ring rounded-sm text-left focus-visible:ring-2 focus-visible:outline-none"
        >
          {label}
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        align="start"
        className="max-h-64 overflow-y-auto text-xs"
      >
        {children}
      </HoverCardContent>
    </HoverCard>
  );
}

/** Relative label with an exact, localized date and time on hover or focus. */
export function InlineMetaTime({
  date,
  children,
  locale,
}: {
  date: Date | string | number;
  children: ReactNode;
  locale?: string;
}) {
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return <span>{children}</span>;
  const full = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(value);
  return (
    <Hint label={full} side="top" align="start" alignOffset={0}>
      <time dateTime={value.toISOString()} tabIndex={0} className="rounded-sm focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none">{children}</time>
    </Hint>
  );
}
