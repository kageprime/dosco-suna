'use client';

// The flowing backdrop behind the headline is the "Flow gradient" WebGL scene
// from Unicorn Studio, vendored from onlook-dev/onlook (Apache-2.0):
// apps/web/client/src/app/_components/hero/unicorn-background.tsx serves
// apps/web/client/public/scenes/flow-background.json, and the same scene file
// ships here at public/scenes/flow-background.json. Four deliberate diffs from
// Onlook's wrapper:
//   1. Their wheel-event forwarding is gone: the scene has `trackMouse: 0` —
//      nothing in it follows the pointer — so the page's native scrolling and
//      touch stay untouched here.
//   2. The scene crossfades over the brandmark wallpaper instead of fading in
//      against bare page background: the wallpaper covers the engine's load
//      window and any runtime error, and stays under the opaque canvas after.
//   3. prefers-reduced-motion keeps the wallpaper permanently; Onlook animates
//      regardless of the preference.
//   4. Narrow viewports render at 30 fps — the flow is slow, so half the frame
//      rate halves GPU and battery cost with no visible difference.

import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import { cn } from '@/lib/utils';
import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';

const UnicornScene = dynamic(
  () => import('unicornstudio-react/next').then((m) => m.default),
  // The engine is ~heavy and only ever runs in a real browser; it must not sit
  // in the server bundle or the first paint.
  { ssr: false },
);

const HERO_SCENE_URL = '/scenes/flow-background.json';

export function HeroBackground({ className }: { className?: string }) {
  const [mode, setMode] = useState<'fallback' | 'scene'>('fallback');
  const [loaded, setLoaded] = useState(false);
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // A browser without WebGL holds the fallback: headless shells and
    // driverless machines get the static brandmark, not a blank canvas.
    const probe = document.createElement('canvas');
    if (!(probe.getContext('webgl2') ?? probe.getContext('webgl'))) return;
    setNarrow(window.matchMedia('(max-width: 767px)').matches);
    setMode('scene');
  }, []);

  return (
    <div
      data-a11y-decorative
      className={cn('pointer-events-none absolute inset-0 overflow-hidden', className)}
    >
      {/* The wallpaper stays mounted under the canvas: it covers the engine's
          load window, remains visible if the scene errors, and is the whole
          surface for reduced-motion users. `mode` flips after effects run, so
          the SSR/test markup is exactly the fallback — no hydration mismatch. */}
      <WallpaperBackground wallpaperId="brandmark" />
      {mode === 'scene' && (
        <div
          className={cn(
            'absolute inset-0 transition-opacity duration-700',
            loaded ? 'opacity-100' : 'opacity-0',
          )}
        >
          <UnicornScene
            jsonFilePath={HERO_SCENE_URL}
            width="100%"
            height="100%"
            scale={1}
            dpi={1}
            fps={narrow ? 30 : 60}
            altText=""
            ariaLabel=""
            production={true}
            lazyLoad={false}
            onLoad={() => setLoaded(true)}
            onError={() => setMode('fallback')}
          />
        </div>
      )}
    </div>
  );
}
