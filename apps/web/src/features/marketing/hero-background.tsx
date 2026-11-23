'use client';

import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import { cn } from '@kortix/ui/lib/utils';
import { useEffect, useState } from 'react';

/** What owns the surface under the fold's type: `scene` is the Dosco Deep Forest
 *  architectural canopy (dark pine in both themes), while `pending` (SSR) and
 *  `fallback` (brandmark wallpaper) sit on the theme's canvas background. */
export type HeroMediaMode = 'pending' | 'fallback' | 'scene';

export function HeroBackground({
  className,
  onMediaChange,
}: {
  className?: string;
  onMediaChange?: (mode: HeroMediaMode) => void;
}) {
  const [mode, setMode] = useState<HeroMediaMode>('pending');
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      setMode('fallback');
      return;
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setMode('fallback');
      return;
    }
    setMode('scene');
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  /* The parent swaps the fold's ink pair for the scene-foreground pair on
     `scene` (globals.css); on `pending` and `fallback` it keeps the theme ink. */
  useEffect(() => {
    onMediaChange?.(mode);
  }, [mode, onMediaChange]);

  return (
    <div
      className={cn('pointer-events-none absolute inset-0 overflow-hidden', className)}
      aria-hidden
      data-a11y-decorative
    >
      {mode === 'fallback' && <WallpaperBackground wallpaperId="brandmark" />}
      {mode === 'scene' && (
        <div
          className={cn(
            'dark bg-background absolute inset-0 transition-opacity duration-500 ease-out',
            visible ? 'opacity-100' : 'opacity-0',
          )}
        >
          {/* Major architectural rule lines */}
          <div
            className="absolute inset-0 opacity-60"
            style={{
              backgroundImage:
                'linear-gradient(to right, oklch(from var(--foreground) l c h / 0.05) 1px, transparent 1px), linear-gradient(to bottom, oklch(from var(--foreground) l c h / 0.05) 1px, transparent 1px)',
              backgroundSize: '144px 144px',
            }}
          />
          {/* Fine 36px blueprint subdivision */}
          <div
            className="absolute inset-0 opacity-50"
            style={{
              backgroundImage:
                'linear-gradient(to right, oklch(from var(--foreground) l c h / 0.025) 1px, transparent 1px), linear-gradient(to bottom, oklch(from var(--foreground) l c h / 0.025) 1px, transparent 1px)',
              backgroundSize: '36px 36px',
            }}
          />
          {/* Volumetric forest canopy illumination */}
          <div
            className="absolute -top-1/4 left-1/2 h-[78vh] w-[115vw] -translate-x-1/2 rounded-full blur-3xl"
            style={{
              background:
                'radial-gradient(ellipse at 50% 42%, oklch(from var(--kortix-base) l c h / 0.42) 0%, oklch(from var(--kortix-base) calc(l * 0.65) c h / 0.24) 44%, transparent 76%)',
            }}
          />
          {/* Lower emerald horizon mist */}
          <div
            className="absolute -bottom-32 left-1/4 h-[42vh] w-[55vw] rounded-full blur-3xl"
            style={{
              background:
                'radial-gradient(circle, oklch(from var(--kortix-base) l c h / 0.16) 0%, oklch(from var(--kortix-base) l c h / 0.06) 50%, transparent 75%)',
            }}
          />
          {/* Subtle top & bottom framing vignette */}
          <div
            className="absolute inset-0"
            style={{
              background:
                'linear-gradient(to bottom, oklch(from var(--background) l c h / 0.6), transparent, oklch(from var(--background) l c h / 0.75))',
            }}
          />
        </div>
      )}
    </div>
  );
}
