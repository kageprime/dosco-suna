import Image from 'next/image';

import { cn } from '@/lib/utils';

const SLOT = 'aspect-[16/10] w-full overflow-hidden border-b bg-muted';

const MOBILE_SHOTS = [
  '/images/mobile-app/app-1.png',
  '/images/mobile-app/app-2.png',
  '/images/mobile-app/app-3.png',
];

/**
 * Three phones in one 16:10 slot, so the card's image and first-row seam read
 * as one designed object.
 *
 * Each phone is HEIGHT-bound (`h-full w-auto` against the 1080x2337 ratio), not
 * width-bound. Width-bound was the first attempt and it was wrong: at a third of
 * the card's width each phone computes taller than the slot, so the bottoms
 * clipped at an arbitrary point mid-screenshot. That reads as a mistake rather
 * than a crop. Height-bound shows every phone whole.
 *
 * Borders, never shadows. The `MobileSurface` treatment in `hero-surfaces.tsx`
 * frames these same shots with `shadow-md`; that part is deliberately not
 * carried over.
 */
export function MobileCardImage() {
  return (
    <div className={cn(SLOT, 'flex items-center justify-center gap-3 px-6 py-6')}>
      {MOBILE_SHOTS.map((src, i) => (
        <div
          key={src}
          className={cn(
            'border-border bg-background relative aspect-[1080/2337] h-full w-auto',
            'overflow-hidden rounded-md border',
            // The middle phone lifts, the outer two drop. Enough to read as a
            // deliberate arrangement, not enough to look scattered.
            i === 1 ? '-translate-y-2' : 'translate-y-2',
          )}
        >
          <Image
            src={src}
            alt=""
            fill
            sizes="(min-width: 768px) 12vw, 25vw"
            className="object-cover"
          />
        </div>
      ))}
    </div>
  );
}
