'use client';

import { heroDeliverables } from '@/features/marketing/landing/content';

/** A light "finished work" strip under the hero — one artifact per role, all
 *  stamped FINAL, replacing the old chat/product-surface frame. Keeps the hero
 *  pure-typographic while still showing the deliverable, not a chat bubble. */
export function DeliverableRow() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {heroDeliverables.map((d) => (
        <div
          key={d.id}
          className="flex flex-col items-center justify-center rounded-xl border border-border/60 bg-background/40 px-4 py-6 text-center backdrop-blur-sm"
        >
          <span className="text-muted-foreground text-xs uppercase tracking-[0.18em]">
            {d.role}
          </span>
          <span className="text-foreground mt-1 text-sm font-medium">
            {d.artifact}
          </span>
          <span className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-[10px] font-semibold tracking-wide text-emerald-600">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            {d.note} · 100%
          </span>
        </div>
      ))}
    </div>
  );
}
