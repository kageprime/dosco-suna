/**
 * Gradient wallpapers: the data half. One WebGL fragment shader
 * (`primitives/gradient-wallpaper-gl.ts`) draws every colored wallpaper and
 * the user's custom one. A wallpaper is a `GradientConfig`: a pattern (where
 * the color sits), a finish (ordered dither or film grain) and a palette.
 *
 * This file holds no DOM or WebGL code, so the presets and the custom-config
 * normalizer are unit-testable and safe to import on the server.
 */

/** Where the color sits on the page. */
export const GRADIENT_PATTERNS = [
  'bloom',
  'beam',
  'sheet',
  'bands',
  'horizon',
  'arc',
  'mesh',
  'clouds',
] as const;
export type GradientPattern = (typeof GRADIENT_PATTERNS)[number];

/** `dither` = ordered dots on a pixel grid; `grain` = smooth with film grain. */
export const GRADIENT_FINISHES = ['dither', 'grain'] as const;
export type GradientFinish = (typeof GRADIENT_FINISHES)[number];

/**
 * Ready-made palettes for the Custom wallpaper's Palette picker, warm to cool
 * and then neutral. Each runs from the faint edge of the shape to its core,
 * like a preset's `colors`.
 */
export const CUSTOM_PALETTES: readonly (readonly string[])[] = [
  ['#6b1d07', '#b8400f', '#f0661c', '#ffb37a'],
  ['#3d0c4f', '#9d174d', '#f43f5e', '#fdba74'],
  ['#854d0e', '#ca8a04', '#facc15', '#fef08a'],
  ['#7f1d1d', '#dc2626', '#fb7185', '#fecdd3'],
  ['#9a3412', '#fb923c', '#fdba74', '#ffedd5'],
  ['#14532d', '#15803d', '#4ade80', '#bbf7d0'],
  ['#3f6212', '#65a30d', '#a3e635', '#ecfccb'],
  ['#134e4a', '#0d9488', '#5eead4', '#ccfbf1'],
  ['#0b5c56', '#12b886', '#2fb8cc', '#9be8d8'],
  ['#0c4a6e', '#0369a1', '#38bdf8', '#bae6fd'],
  ['#1d3fb8', '#2a52c9', '#4f7dff', '#a9c4ff'],
  ['#312e81', '#4f46e5', '#818cf8', '#c7d2fe'],
  ['#352a85', '#6652e0', '#a78bfa', '#ead7ff'],
  ['#701a75', '#c026d3', '#e879f9', '#f5d0fe'],
  ['#881337', '#e11d48', '#fb7185', '#ffe4e6'],
  ['#22b8cf', '#3b5bdb', '#7950f2', '#e64980'],
  ['#1b1f4b', '#c8324e', '#ff8a7a', '#b9b9c2'],
  ['#27272a', '#52525b', '#a1a1aa', '#e4e4e7'],
];

/** The preset dots of a Custom swatch's colour picker: one per hue family. */
export const CUSTOM_COLOR_PRESETS = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#14b8a6',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
] as const;

export const GRADIENT_MIN_COLORS = 2;
export const GRADIENT_MAX_COLORS = 5;

export interface GradientConfig {
  pattern: GradientPattern;
  finish: GradientFinish;
  /**
   * 2–5 hex colors, ordered from the faint edge of the shape to its core.
   * The page background shows through wherever the shape is absent, so a
   * palette never names the background.
   */
  colors: string[];
  /** Colors for light themes. Falls back to `colors`. */
  lightColors?: string[];
  /** 0–1: how much of the shape is cleared behind the centered content. */
  calm: number;
  /** `bloom` and `sheet`: the corner the color grows from, in 0–1 page space. */
  anchor?: [number, number];
  /** 0.2–1, applied as CSS opacity on the canvas: costs the shader nothing.
   *  Unset, `DEFAULT_WALLPAPER_OPACITY`. */
  opacity?: number;
}

export const OPACITY_LIMITS = [0.2, 1] as const;
/** Every gradient wallpaper draws at 50% until the person changes it. */
export const DEFAULT_WALLPAPER_OPACITY = 0.5;

/** A stored opacity, clamped, or undefined when it is not a number. */
function validOpacity(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(OPACITY_LIMITS[1], Math.max(OPACITY_LIMITS[0], value));
}

/**
 * The Custom wallpaper: 2–5 colours, a finish and a shape. The colour popover
 * edits the colours and the finish; Shuffle rolls all three. Persisted in
 * preferences.
 */
export interface CustomWallpaperConfig {
  colors: string[];
  finish: GradientFinish;
  pattern: GradientPattern;
  opacity: number;
}

export const DEFAULT_CUSTOM_WALLPAPER: CustomWallpaperConfig = {
  colors: ['#1d3fb8', '#4f7dff', '#a9c4ff'],
  finish: 'dither',
  pattern: 'bloom',
  opacity: DEFAULT_WALLPAPER_OPACITY,
};

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

const isFinish = (value: unknown): value is GradientFinish =>
  GRADIENT_FINISHES.includes(value as GradientFinish);

/** The valid colours of a stored palette, or undefined when fewer than 2. */
function validColors(value: unknown): string[] | undefined {
  const colors = (Array.isArray(value) ? value : [])
    .filter((color): color is string => typeof color === 'string' && HEX_COLOR.test(color))
    .slice(0, GRADIENT_MAX_COLORS);
  return colors.length >= GRADIENT_MIN_COLORS ? colors : undefined;
}

/**
 * Persisted preferences are untyped JSON that may predate a field or hold a
 * hand-edited value. Returns a config the shader can always draw. Fields an
 * older build stored (shape, finish, placement) are dropped.
 */
export function normalizeCustomWallpaper(value: unknown): CustomWallpaperConfig {
  const input = (value ?? {}) as Partial<CustomWallpaperConfig>;
  return {
    colors: validColors(input.colors) ?? DEFAULT_CUSTOM_WALLPAPER.colors,
    finish: isFinish(input.finish) ? input.finish : DEFAULT_CUSTOM_WALLPAPER.finish,
    pattern: GRADIENT_PATTERNS.includes(input.pattern as GradientPattern)
      ? (input.pattern as GradientPattern)
      : DEFAULT_CUSTOM_WALLPAPER.pattern,
    opacity: validOpacity(input.opacity) ?? DEFAULT_CUSTOM_WALLPAPER.opacity,
  };
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const a = saturation * Math.min(lightness, 1 - lightness);
  const channel = (n: number) => {
    const k = (n + hue / 30) % 12;
    const value = lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(value * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

function hexToHsl(hex: string): [number, number, number] {
  const v = Number.parseInt(hex.slice(1), 16);
  const r = ((v >> 16) & 255) / 255;
  const g = ((v >> 8) & 255) / 255;
  const b = (v & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return [0, 0, lightness];
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  const hue =
    max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return [hue * 60, saturation, lightness];
}

/** Degrees between two hues, 0–180. */
const hueGap = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/**
 * The color the Custom wallpaper's + button adds: random, but from the
 * palette's own temperature. It finds the palette's mean hue, weighted by
 * saturation so a near-grey swatch does not pull it, then picks a hue within
 * 30° of it and 45° of the first saturated color, a strong saturation and a mid lightness. Of 6 candidates it keeps
 * the one least like the colors already there. A palette of greys gets a
 * random hue. `random` is injectable for tests.
 */
export function nextCustomColor(colors: string[], random: () => number = Math.random): string {
  const hsl = colors.map(hexToHsl);
  let x = 0;
  let y = 0;
  for (const [hue, saturation] of hsl) {
    x += Math.cos((hue * Math.PI) / 180) * saturation;
    y += Math.sin((hue * Math.PI) / 180) * saturation;
  }
  const grey = Math.hypot(x, y) < 0.15;
  const mean = grey ? random() * 360 : ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  // The first saturated color anchors the temperature: each added color
  // moves the mean, and without an anchor a palette drifts from orange to
  // green in a few presses.
  const anchor = hsl.find(([, saturation]) => saturation > 0.25)?.[0] ?? mean;

  let best = '';
  let bestDistance = -1;
  for (let attempt = 0; attempt < 6; attempt++) {
    let hue = (mean + (random() * 2 - 1) * 30 + 360) % 360;
    if (hueGap(hue, anchor) > 45) hue = (anchor + (random() * 2 - 1) * 30 + 360) % 360;
    const lightness = 0.38 + random() * 0.32;
    const candidate = hslToHex(hue, 0.65 + random() * 0.25, lightness);
    // Hue counts per 40°, lightness per 0.2: the nearest existing color.
    const distance = Math.min(
      ...hsl.map(([h, , l]) => hueGap(h, hue) / 40 + Math.abs(l - lightness) / 0.2),
    );
    if (distance > bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Shuffle: a random Custom palette. A deep base colour, a brighter neighbour
 * 25–60° along the hue wheel, then `nextCustomColor` up to 3 or 4 colours,
 * so every result stays in one temperature. `random` is injectable for tests.
 */
export function randomCustomColors(random: () => number = Math.random): string[] {
  const hue = random() * 360;
  let colors = [hslToHex(hue, 0.75, 0.38), hslToHex((hue + 25 + random() * 35) % 360, 0.85, 0.56)];
  const count = 3 + Math.floor(random() * 2);
  while (colors.length < count) colors = [...colors, nextCustomColor(colors, random)];
  return colors;
}

/**
 * Shuffle: a whole new Custom wallpaper. A shape other than `previous`'s, a
 * random finish and a `randomCustomColors` palette.
 */
export function randomCustomWallpaper(
  previous?: CustomWallpaperConfig,
  random: () => number = Math.random,
): CustomWallpaperConfig {
  const shapes = GRADIENT_PATTERNS.filter((pattern) => pattern !== previous?.pattern);
  return {
    pattern: shapes[Math.floor(random() * shapes.length)]!,
    finish: GRADIENT_FINISHES[Math.floor(random() * GRADIENT_FINISHES.length)]!,
    colors: randomCustomColors(random),
    // Shuffle keeps how strong the person wants the wallpaper.
    opacity: previous?.opacity ?? DEFAULT_CUSTOM_WALLPAPER.opacity,
  };
}

/** How much of each shape is cleared behind the centred content: the same
 *  value as the preset that uses the shape. */
const CALM: Record<GradientPattern, number> = {
  bloom: 0.35,
  beam: 0.5,
  sheet: 0.4,
  bands: 0.8,
  horizon: 0.3,
  arc: 0.3,
  mesh: 0.75,
  clouds: 0.7,
};

export function customGradientConfig(custom: CustomWallpaperConfig): GradientConfig {
  return {
    pattern: custom.pattern,
    finish: custom.finish,
    colors: custom.colors,
    calm: CALM[custom.pattern],
    anchor: [1, 1],
    opacity: custom.opacity,
  };
}

export type GradientWallpaperId =
  | 'ember'
  | 'prism'
  | 'tide'
  | 'aurora'
  | 'dusk'
  | 'eclipse'
  | 'lagoon'
  | 'cumulus'
  | 'moss'
  | 'iris';

export const GRADIENT_PRESETS: Record<GradientWallpaperId, GradientConfig> = {
  // An orange bloom dithered out of the bottom-right corner.
  ember: {
    pattern: 'bloom',
    finish: 'dither',
    colors: ['#6b1d07', '#b8400f', '#f0661c', '#ffb37a'],
    lightColors: ['#ffc9a3', '#ff9d5c', '#f4701f', '#d9500b'],
    calm: 0.35,
    anchor: [1, 1],
  },
  // A spectral beam crossing the page: blue haze above, a hot edge below.
  prism: {
    pattern: 'beam',
    finish: 'dither',
    colors: ['#16307a', '#2f7fd6', '#e6dfc4', '#f08a3c', '#d7263d'],
    lightColors: ['#9db8f2', '#4f93e0', '#f2d9a0', '#f08a3c', '#d7263d'],
    calm: 0.5,
  },
  // A deep-blue sheet rising from the bottom-right corner.
  tide: {
    pattern: 'sheet',
    finish: 'dither',
    colors: ['#0d2350', '#1f4f9e', '#4f8fd8', '#9cc3f0'],
    lightColors: ['#c3d8f5', '#7fb0ea', '#3f7fd0', '#1f4f9e'],
    calm: 0.4,
    anchor: [1, 1],
  },
  // Flowing vertical color bands with film grain.
  aurora: {
    pattern: 'bands',
    finish: 'grain',
    // Dark: no orange. Half-covered orange over a near-black page turns brown.
    colors: ['#22b8cf', '#3b5bdb', '#7950f2', '#e64980', '#22b8cf'],
    lightColors: ['#e8502a', '#2f9e6b', '#35bfd0', '#3b5bdb', '#9b5de5'],
    calm: 0.8,
  },
  // A red horizon between grey haze and a navy ground.
  dusk: {
    pattern: 'horizon',
    finish: 'grain',
    colors: ['#1b1f4b', '#c8324e', '#ff8a7a', '#b9b9c2'],
    lightColors: ['#6b70b8', '#d6455f', '#ff9d8f', '#d9d9e0'],
    calm: 0.3,
  },
  // The lit rim of a sphere rising from the bottom edge.
  eclipse: {
    pattern: 'arc',
    finish: 'grain',
    colors: ['#5b2333', '#c94f35', '#f08a52', '#ffd9a8'],
    lightColors: ['#f7d6c6', '#f2a37c', '#ee7f4f', '#f9b877'],
    calm: 0.3,
  },
  // Teal and green light pooled in the corners.
  lagoon: {
    pattern: 'mesh',
    finish: 'grain',
    colors: ['#0b5c56', '#12b886', '#2fb8cc', '#9be8d8'],
    calm: 0.75,
  },
  // Dithered clouds on the lower half of the page.
  cumulus: {
    pattern: 'clouds',
    finish: 'dither',
    // Dark: no near-white core. It glares on a dark page.
    colors: ['#1d3fb8', '#2a52c9', '#4f7dff', '#a9c4ff'],
    lightColors: ['#d3e0ff', '#a9c4ff', '#6f95ff', '#4f7dff'],
    calm: 0.7,
  },
  // Green ribbons, dithered.
  moss: {
    pattern: 'bands',
    finish: 'dither',
    colors: ['#1f3d0c', '#4c7a12', '#86c232', '#4c7a12'],
    lightColors: ['#d9efb0', '#a9d85c', '#74b816', '#a9d85c'],
    calm: 0.85,
  },
  // A violet bloom from the top-right corner, smooth.
  iris: {
    pattern: 'bloom',
    finish: 'grain',
    colors: ['#352a85', '#6652e0', '#a78bfa', '#ead7ff'],
    lightColors: ['#e3d4ff', '#b79cfb', '#7d68ea', '#4c3cb8'],
    calm: 0.35,
    anchor: [1, 0],
  },
};

/** What the person changed on a preset: its colours, finish or opacity. */
export interface PresetOverride {
  colors?: string[];
  finish?: GradientFinish;
  opacity?: number;
}

/** Overrides by preset id. Persisted. */
export type PresetOverrides = Partial<Record<GradientWallpaperId, PresetOverride>>;

/**
 * Persisted overrides, cleaned: unknown ids, invalid palettes and unknown
 * finishes are dropped, opacity is clamped, so a preset always draws.
 */
export function normalizePresetOverrides(value: unknown): PresetOverrides {
  if (!value || typeof value !== 'object') return {};
  const out: PresetOverrides = {};
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!(id in GRADIENT_PRESETS) || !raw || typeof raw !== 'object') continue;
    const input = raw as Partial<PresetOverride>;
    const override: PresetOverride = {};
    const colors = validColors(input.colors);
    if (colors) override.colors = colors;
    if (isFinish(input.finish)) override.finish = input.finish;
    const opacity = validOpacity(input.opacity);
    if (opacity !== undefined) override.opacity = opacity;
    if (Object.keys(override).length > 0) out[id as GradientWallpaperId] = override;
  }
  return out;
}

/** A preset with the person's override applied, or as shipped. Picked
 *  colours draw in both themes. */
export function presetWithOverride(config: GradientConfig, override?: PresetOverride): GradientConfig {
  if (!override) return config;
  return {
    ...config,
    ...(override.colors ? { colors: override.colors, lightColors: override.colors } : {}),
    ...(override.finish ? { finish: override.finish } : {}),
    ...(override.opacity !== undefined ? { opacity: override.opacity } : {}),
  };
}

/** The palette a config draws with in the given theme. */
export function gradientColors(config: GradientConfig, isDark: boolean): string[] {
  return isDark ? config.colors : (config.lightColors ?? config.colors);
}
