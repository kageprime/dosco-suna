'use client';

import { ShaderWallpaper } from '@/components/ui/shader-wallpaper';
import { cn } from '@kortix/ui';
import { GradientWallpaper } from '@kortix/ui/gradient-wallpaper';
import { useUserPreferencesStore } from '@kortix/ui/internal/stores/user-preferences-store';
import { GrainShader, NeuroShader } from '@kortix/ui/paper-wallpaper-shaders';
import {
  customGradientConfig,
  DEFAULT_WALLPAPER_ID,
  getSelectableWallpaper,
  getWallpaperById,
  normalizeCustomWallpaper,
  normalizePresetOverrides,
  presetWithOverride,
  Wallpaper,
  type GradientConfig,
  type PresetOverride,
} from '@kortix/ui/theme';
import { DitherShader, SilkShader } from '@kortix/ui/wallpaper-shaders';
import Image from 'next/image';
import { memo, useMemo, type ComponentType } from 'react';

// The shader compositions that predate the gradient engine: Dither (the
// default) and the wallpapers retired from the picker. Unknown shader ids
// fall back to the Pixel Beams preset in ShaderWallpaper.
const SHADER_WALLPAPERS: Partial<
  Record<Wallpaper['id'], ComponentType<{ maxPixelCount?: number }>>
> = {
  silk: SilkShader,
  dither: DitherShader,
  grain: GrainShader,
  neuro: NeuroShader,
};

interface WallpaperBackgroundProps {
  wallpaperId?: Wallpaper['id'];
  preview?: boolean;
  showBrandMark?: boolean;
  /**
   * Raises the Paper Shader pixel cap for still-image exports. App surfaces
   * leave it unset and keep the 2 MP cap — see `paper-wallpaper-shaders.tsx`.
   */
  maxPixelCount?: number;
}

export const WallpaperBackground = memo(function WallpaperBackground({
  wallpaperId: wallpaperIdProp,
  preview = false,
  showBrandMark = true,
  maxPixelCount,
}: WallpaperBackgroundProps = {}) {
  const storeWallpaperId = useUserPreferencesStore(
    (s) => s.preferences.wallpaperId ?? DEFAULT_WALLPAPER_ID,
  );
  const storedCustom = useUserPreferencesStore((s) => s.preferences.customWallpaper);
  // A prop names any wallpaper that can render. A stored preference names
  // only what the picker offers: a retired id resolves to the default.
  const wallpaper = wallpaperIdProp
    ? getWallpaperById(wallpaperIdProp)
    : getSelectableWallpaper(storeWallpaperId);
  const storedOverrides = useUserPreferencesStore((s) => s.preferences.wallpaperOverrides);
  const overrides = useMemo(() => normalizePresetOverrides(storedOverrides), [storedOverrides]);
  const customGradient = useMemo(
    () => customGradientConfig(normalizeCustomWallpaper(storedCustom)),
    [storedCustom],
  );

  const centerTopClass = preview ? 'top-[50%]' : 'top-[46%]';

  // 'Blank' — intentionally render nothing; the page background shows
  // through untouched.
  if (wallpaper.type === 'none') {
    return null;
  }

  if (wallpaper.type === 'svg') {
    // The brandmark renders as ambient light rather than a hard wireframe:
    // a heavily-blurred bloom layer underneath a gently softened outline,
    // both dissolved by a radial mask so the mark's sharp arm tips fade out
    // long before the viewport crops them.
    const brandMarkMask =
      '[mask-image:radial-gradient(ellipse_58%_52%_at_50%_50%,black_32%,transparent_78%)]';
    const brandMarkLayout = cn(
      'absolute left-1/2 h-auto w-[120%] -translate-x-1/2 -translate-y-1/2 object-contain select-none sm:w-[135%] lg:w-[138%]',
      centerTopClass,
      brandMarkMask,
    );
    return (
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        {showBrandMark && (
          <>
            {/* Bloom — the mark as a soft glow behind the line work. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={wallpaper.svgUrl}
              alt=""
              className={cn(brandMarkLayout, 'opacity-60 blur-lg invert dark:invert-0')}
              draggable={false}
            />
            {/* Line work — softened so the 1px stroke reads as light, not bone. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={wallpaper.svgUrl}
              alt=""
              className={cn(
                brandMarkLayout,
                'opacity-90 blur-[1px] invert dark:opacity-100 dark:invert-0',
              )}
              draggable={false}
            />
          </>
        )}
      </div>
    );
  }

  // ── Gradient wallpapers: the ten presets and the user's own ──────────
  if (wallpaper.type === 'gradient' || wallpaper.type === 'custom') {
    if (wallpaper.type === 'custom') return <GradientWallpaper config={customGradient} />;
    return wallpaper.gradient ? (
      <PresetGradient
        config={wallpaper.gradient}
        override={overrides[wallpaper.id as keyof typeof overrides]}
      />
    ) : null;
  }

  // ── WebGL shader compositions ────────────────────────────────────────
  // Each shader wallpaper has its own preset picked by id. Shader
  // wallpapers render without the logomark overlay — the composition is
  // the wallpaper.
  if (wallpaper.type === 'shader') {
    const ShaderComponent = SHADER_WALLPAPERS[wallpaper.id] ?? ShaderWallpaper;
    return (
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        <ShaderComponent maxPixelCount={maxPixelCount} />
      </div>
    );
  }

  // ── Fallback: Image wallpaper ─────────────────────────────────────────
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      <div className="absolute inset-0 hidden dark:block">
        <Image
          src={wallpaper.darkUrl!}
          alt=""
          fill
          sizes="100vw"
          className="object-cover select-none"
          unoptimized
          priority
          draggable={false}
        />
      </div>
      <div className="absolute inset-0 dark:hidden">
        <Image
          src={wallpaper.lightUrl!}
          alt=""
          fill
          sizes="100vw"
          className="object-cover select-none"
          unoptimized
          priority
          draggable={false}
        />
      </div>
      <div className="absolute inset-0 bg-black/5 dark:bg-black/20" />
    </div>
  );
});

/** A preset with the person's override. Memoized so the shader keeps its
 *  params object, and with it its uniforms, until the override changes. */
function PresetGradient({
  config,
  override,
}: {
  config: GradientConfig;
  override?: PresetOverride;
}) {
  const applied = useMemo(() => presetWithOverride(config, override), [config, override]);
  return <GradientWallpaper config={applied} />;
}
