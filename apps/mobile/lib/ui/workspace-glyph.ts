/**
 * A workspace's glyph colour on mobile: the solid colour its glyph paints in.
 * The same eight presets as web (`--glyph-solid-*`, packages/ui/src/styles/theme.css),
 * one value per theme, or the workspace's own `#rrggbb`. The tile's wash is
 * this colour at `GLYPH_WASH_ALPHA` (web: 14% light, 20% dark, `glyph-tint.ts`).
 *
 * Pure (no React Native import), so bun test loads it.
 */
import { isProjectGlyphColor, isProjectGlyphPaletteColor, type ProjectGlyphPaletteColor } from '@kortix/shared';

// hex-allowlist: transcribed from packages/ui/src/styles/theme.css `--glyph-solid-*`
// light-dark() pairs (e.g. grey light hsl(220 6% 45%), dark hsl(220 6% 66%)); the
// mobile global.css has no glyph tokens, and these must match web exactly.
const SOLID: Record<ProjectGlyphPaletteColor, { light: string; dark: string }> = {
  grey: { light: 'hsl(220 6% 45%)', dark: 'hsl(220 6% 66%)' },
  red: { light: 'hsl(359 72% 58%)', dark: 'hsl(0 78% 63%)' },
  orange: { light: 'hsl(28 80% 50%)', dark: 'hsl(28 87% 62%)' },
  yellow: { light: 'hsl(45 94% 41%)', dark: 'hsl(45 87% 62%)' },
  lime: { light: 'hsl(142 54% 40%)', dark: 'hsl(140 40% 55%)' },
  blue: { light: 'hsl(213 74% 53%)', dark: 'hsl(213 83% 66%)' },
  purple: { light: 'hsl(256 76% 63%)', dark: 'hsl(260 81% 72%)' },
  magenta: { light: 'hsl(322 62% 54%)', dark: 'hsl(320 69% 67%)' },
};

/** The wash under the glyph: web's 14% in light, 20% in dark. */
export const GLYPH_WASH_ALPHA = { light: 0.14, dark: 0.2 } as const;

/** The solid glyph colour. A custom `#rrggbb` passes through; an unknown value is grey (stale cached data). */
export function workspaceGlyphColor(color: string, dark: boolean): string {
  if (isProjectGlyphPaletteColor(color)) return SOLID[color][dark ? 'dark' : 'light'];
  if (isProjectGlyphColor(color)) return color;
  return SOLID.grey[dark ? 'dark' : 'light'];
}

/**
 * The tile's wash: the solid colour at `alpha`. A preset is `hsl(...)` (read by
 * `withAlpha`); a custom `#rrggbb` takes an 8-digit hex with the alpha byte.
 */
export function workspaceGlyphWash(solid: string, alpha: number, withAlpha: (hsl: string, a: number) => string): string {
  if (/^#[0-9a-fA-F]{6}$/.test(solid)) {
    const byte = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
      .toString(16)
      .padStart(2, '0');
    return `${solid}${byte}`;
  }
  return withAlpha(solid, alpha);
}
