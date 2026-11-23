'use client';

import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import { cn } from '@kortix/ui/lib/utils';
import { useEffect, useState } from 'react';

import { ForestScene } from './kit/forest-scene';

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
      {mode === 'scene' && <ForestScene visible={visible} />}
    </div>
  );
}
