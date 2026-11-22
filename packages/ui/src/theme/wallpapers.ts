import { GRADIENT_PRESETS, type GradientConfig, type GradientWallpaperId } from './wallpaper-gradients';

export type WallpaperType = 'svg' | 'shader' | 'gradient' | 'custom' | 'image' | 'none';

/** Ids that still render (marketing pages, the still-image exporter) but are
 *  no longer offered in the picker. */
type LegacyWallpaperId = 'brandmark' | 'nebula' | 'silk' | 'grain' | 'neuro';

/** The ids the picker offers. */
export type PickerWallpaperId = Exclude<Wallpaper['id'], LegacyWallpaperId>;
export type PickerWallpaper = Wallpaper & { id: PickerWallpaperId };

export interface Wallpaper {
  id: 'dither' | 'blank' | 'custom' | GradientWallpaperId | LegacyWallpaperId;
  name: string;
  type: WallpaperType;
  /** For 'gradient' wallpapers — what the gradient shader draws. */
  gradient?: GradientConfig;
  /** For 'svg' wallpapers — path to the SVG file */
  svgUrl?: string;
  /** For 'image' wallpapers — path to the light-mode image */
  lightUrl?: string;
  /** For 'image' wallpapers — path to the dark-mode image */
  darkUrl?: string;
  /** Small thumbnail for the picker */
  thumbnailUrl?: string;
  /**
   * Pre-rendered picker thumbnails per theme. Shader wallpapers use these
   * in the settings grid so only the wallpaper actually applied to the
   * page runs a live canvas.
   */
  thumbs?: { dark: string; light: string };
}

export const DEFAULT_WALLPAPER_ID = 'dither';

function shaderThumbs(id: Wallpaper['id']): Wallpaper['thumbs'] {
  return {
    dark: `/wallpapers/${id}-dark.jpg`,
    light: `/wallpapers/${id}-light.jpg`,
  };
}

const GRADIENT_NAMES: Record<GradientWallpaperId, string> = {
  ember: 'Ember',
  prism: 'Prism',
  tide: 'Tide',
  aurora: 'Aurora',
  dusk: 'Dusk',
  eclipse: 'Eclipse',
  lagoon: 'Lagoon',
  cumulus: 'Cumulus',
  moss: 'Moss',
  iris: 'Iris',
};

/** The picker, in order: the default, the ten gradients, Blank, Custom. */
export const WALLPAPERS: PickerWallpaper[] = [
  {
    id: 'dither',
    name: 'Dither',
    type: 'shader',
    thumbs: shaderThumbs('dither'),
  },
  ...(Object.keys(GRADIENT_PRESETS) as GradientWallpaperId[]).map(
    (id): PickerWallpaper => ({
      id,
      name: GRADIENT_NAMES[id],
      type: 'gradient',
      gradient: GRADIENT_PRESETS[id],
    }),
  ),
  {
    id: 'blank',
    name: 'Blank',
    type: 'none',
  },
  // Last, so its controls open directly under its card.
  {
    id: 'custom',
    name: 'Custom',
    type: 'custom',
  },
];

/**
 * Retired from the picker on 2026-11-21. They stay resolvable by id because
 * the marketing heroes render `brandmark` and the still-image exporter
 * (`apps/web/scripts/generate-wallpapers.mjs`) renders the rest.
 */
const LEGACY_WALLPAPERS: Wallpaper[] = [
  {
    id: 'brandmark',
    name: 'Brandmark',
    type: 'svg',
    svgUrl: '/kortix-brandmark-bg.svg',
    thumbnailUrl: '/kortix-brandmark-bg.svg',
  },
  { id: 'nebula', name: 'Pixel Beams', type: 'shader', thumbs: shaderThumbs('nebula') },
  { id: 'silk', name: 'Silk', type: 'shader', thumbs: shaderThumbs('silk') },
  { id: 'grain', name: 'Grain', type: 'shader', thumbs: shaderThumbs('grain') },
  { id: 'neuro', name: 'Neuro', type: 'shader', thumbs: shaderThumbs('neuro') },
];

/** Resolves any id that can render, picker or legacy. Unknown ids resolve to
 *  the default. */
export function getWallpaperById(id: string): Wallpaper {
  return (
    WALLPAPERS.find((w) => w.id === id) ??
    LEGACY_WALLPAPERS.find((w) => w.id === id) ??
    WALLPAPERS[0]!
  );
}

/**
 * Resolves a persisted preference. A retired id falls back to the default, so
 * a user who had one selected lands on a wallpaper the picker can show.
 */
export function getSelectableWallpaper(id: string): PickerWallpaper {
  return WALLPAPERS.find((w) => w.id === id) ?? WALLPAPERS[0]!;
}
