'use client';

import { sessionViews, SessionCard } from './session-cards';
import type { LoopView } from '@/features/marketing/one-prompt/loops-content';

/**
 * The strip below the landing fold: the roles' runs as conversation cards,
 * moving left as one endless row. It is the loopmaxxing fold's own device —
 * the work is the proof, not a screenshot of a dashboard.
 *
 * Two identical children each translate by their own width plus the gap, so
 * the seam never shows. Reduced motion holds the strip still at the first card.
 */
export function SessionCarousel({ roles }: { roles: LoopView[] }) {
  const views = sessionViews(roles);
  return (
    <div
      role="region"
      aria-label="Agent runs"
      className="relative overflow-hidden [mask-image:linear-gradient(to_right,transparent,#000_6%,#000_94%,transparent)]"
    >
      <div className="flex gap-4">
        {[0, 1].map((copy) => (
          <div
            key={copy}
            aria-hidden={copy === 1}
            className="animate-marquee flex gap-4 [--duration:80s] [--gap:1rem] motion-reduce:[animation:none]"
          >
            {views.map((view) => (
              <SessionCard key={`${copy}-${view.id}`} view={view} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
