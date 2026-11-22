import { describe, expect, test } from 'bun:test';

import {
  CUSTOM_PALETTES,
  DEFAULT_CUSTOM_WALLPAPER,
  GRADIENT_MAX_COLORS,
  GRADIENT_MIN_COLORS,
  GRADIENT_PRESETS,
  customGradientConfig,
  gradientColors,
  nextCustomColor,
  normalizeCustomWallpaper,
  normalizePresetOverrides,
  presetWithOverride,
  randomCustomColors,
  randomCustomWallpaper,
} from './wallpaper-gradients';
import {
  DEFAULT_WALLPAPER_ID,
  WALLPAPERS,
  getSelectableWallpaper,
  getWallpaperById,
} from './wallpapers';

describe('wallpapers', () => {
  test('Dither is the default wallpaper', () => {
    expect(DEFAULT_WALLPAPER_ID).toBe('dither');
  });

  test('Dither leads the picker order', () => {
    expect(WALLPAPERS[0]?.id).toBe('dither');
  });

  test('the default id resolves to a real wallpaper', () => {
    const defaultWallpaper = WALLPAPERS.find((w) => w.id === DEFAULT_WALLPAPER_ID);
    expect(defaultWallpaper).toBeDefined();
    expect(getWallpaperById(DEFAULT_WALLPAPER_ID).id).toBe('dither');
  });

  test('every wallpaper id is unique', () => {
    const ids = WALLPAPERS.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('an unknown id falls back to the first (default) wallpaper', () => {
    expect(getWallpaperById('does-not-exist').id).toBe(WALLPAPERS[0]!.id);
  });

  test('the picker is Dither, ten gradients, Blank, then Custom', () => {
    const ids = WALLPAPERS.map((w) => w.id);
    expect(ids[0]).toBe('dither');
    expect(ids.slice(1, 11) as string[]).toEqual(Object.keys(GRADIENT_PRESETS));
    expect(ids.slice(11)).toEqual(['blank', 'custom']);
    expect(WALLPAPERS.filter((w) => w.type === 'gradient')).toHaveLength(10);
  });

  test('a retired id still renders by prop but is not a selectable preference', () => {
    expect(getWallpaperById('brandmark').id).toBe('brandmark');
    expect(getWallpaperById('neuro').id).toBe('neuro');
    expect(getSelectableWallpaper('brandmark').id).toBe('dither');
    expect(getSelectableWallpaper('neuro').id).toBe('dither');
    expect(getSelectableWallpaper('ember').id).toBe('ember');
  });
});

describe('gradient wallpapers', () => {
  const HEX = /^#[0-9a-f]{6}$/;

  test('every preset carries a drawable palette for both themes', () => {
    for (const config of Object.values(GRADIENT_PRESETS)) {
      for (const colors of [gradientColors(config, true), gradientColors(config, false)]) {
        expect(colors.length).toBeGreaterThanOrEqual(GRADIENT_MIN_COLORS);
        expect(colors.length).toBeLessThanOrEqual(GRADIENT_MAX_COLORS);
        for (const color of colors) expect(color).toMatch(HEX);
      }
      expect(config.calm).toBeGreaterThanOrEqual(0);
      expect(config.calm).toBeLessThanOrEqual(1);
    }
  });


  test('a missing custom wallpaper normalizes to the default', () => {
    expect(normalizeCustomWallpaper(undefined)).toEqual(DEFAULT_CUSTOM_WALLPAPER);
    expect(normalizeCustomWallpaper(null)).toEqual(DEFAULT_CUSTOM_WALLPAPER);
  });

  test('a custom wallpaper keeps its valid colours and finish and drops everything else', () => {
    // An older build also stored placement: it is dropped.
    const stored = { pattern: 'arc', finish: 'grain', rotate: 90, colors: ['#112233', 'red', 7, '#AABBCC'] };
    expect(normalizeCustomWallpaper(stored)).toEqual({
      colors: ['#112233', '#AABBCC'],
      finish: 'grain',
      pattern: 'arc',
      opacity: 0.5,
    });
    expect(normalizeCustomWallpaper({ opacity: 0.05 }).opacity).toBe(0.2);
    expect(normalizeCustomWallpaper({ opacity: 3 }).opacity).toBe(1);
    expect(normalizeCustomWallpaper({ colors: ['#112233', '#445566'], finish: 'chalk' }).finish).toBe('dither');
  });

  test('fewer than two valid colors resets the palette; more than five is cut', () => {
    expect(normalizeCustomWallpaper({ colors: ['#112233'] }).colors).toEqual(
      DEFAULT_CUSTOM_WALLPAPER.colors,
    );
    const seven = ['#000001', '#000002', '#000003', '#000004', '#000005', '#000006', '#000007'];
    expect(normalizeCustomWallpaper({ colors: seven }).colors).toEqual(seven.slice(0, 5));
  });

  test('Custom draws its colours in its own shape and finish', () => {
    const config = customGradientConfig({
      colors: ['#112233', '#445566'],
      finish: 'grain',
      pattern: 'bloom',
      opacity: 0.6,
    });
    expect(config.opacity).toBe(0.6);
    expect(config).toMatchObject({ pattern: 'bloom', finish: 'grain', anchor: [1, 1] });
    expect(config.calm).toBe(GRADIENT_PRESETS.ember.calm);
    expect(config.colors).toEqual(['#112233', '#445566']);
  });

  test('+ adds a random color from the palette\'s own temperature', () => {
    const hueOf = (hex: string) => {
      const v = Number.parseInt(hex.slice(1), 16);
      const [r, g, b] = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
      const max = Math.max(r, g, b);
      const d = max - Math.min(r, g, b);
      if (d === 0) return 0;
      const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return h * 60;
    };
    const gap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
    let seed = 11;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const cool = ['#1d3fb8', '#4f7dff'];
    const warm = ['#c2410c', '#f97316'];
    for (let i = 0; i < 100; i++) {
      const c = nextCustomColor(cool, random);
      expect(gap(hueOf(c), 226)).toBeLessThanOrEqual(45);
      expect(cool).not.toContain(c);
      const w = nextCustomColor(warm, random);
      expect(gap(hueOf(w), 22)).toBeLessThanOrEqual(45);
    }
    // Two presses give two different colors.
    expect(nextCustomColor(cool, random)).not.toBe(nextCustomColor(cool, random));
  });

  test('the Palette picker offers 10–20 distinct palettes Custom can draw', () => {
    expect(CUSTOM_PALETTES.length).toBeGreaterThanOrEqual(10);
    expect(CUSTOM_PALETTES.length).toBeLessThanOrEqual(20);
    expect(new Set(CUSTOM_PALETTES.map((p) => p.join())).size).toBe(CUSTOM_PALETTES.length);
    for (const palette of CUSTOM_PALETTES) {
      const config = { ...DEFAULT_CUSTOM_WALLPAPER, colors: [...palette] };
      expect(normalizeCustomWallpaper(config).colors).toEqual([...palette]);
    }
  });

  test('Shuffle makes a 3–4 colour palette the normalizer keeps as is', () => {
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const colors = randomCustomColors(random);
      expect([3, 4]).toContain(colors.length);
      expect(normalizeCustomWallpaper({ colors }).colors).toEqual(colors);
      seen.add(colors.join());
    }
    expect(seen.size).toBe(200);
  });

  test('a preset override changes colours and finish and keeps the shape', () => {
    const colors = ['#112233', '#445566', '#778899'];
    const tide = presetWithOverride(GRADIENT_PRESETS.tide, { colors, finish: 'grain' });
    expect(tide).toMatchObject({ pattern: 'sheet', finish: 'grain', anchor: [1, 1] });
    expect(gradientColors(tide, true)).toEqual(colors);
    expect(gradientColors(tide, false)).toEqual(colors);
    // Finish only: the shipped colours stay.
    const grained = presetWithOverride(GRADIENT_PRESETS.ember, { finish: 'grain' });
    expect(grained.finish).toBe('grain');
    expect(grained.colors).toEqual(GRADIENT_PRESETS.ember.colors);
    // No override: the preset as shipped, the same object.
    expect(presetWithOverride(GRADIENT_PRESETS.tide, undefined)).toBe(GRADIENT_PRESETS.tide);
  });

  test('stored preset overrides drop unknown ids, invalid palettes and unknown finishes', () => {
    expect(
      normalizePresetOverrides({
        ember: { colors: ['#112233', '#445566'] },
        tide: { colors: ['#112233'] },
        nebula: { colors: ['#112233', '#445566'] },
        moss: { colors: ['#112233', 'green', '#445566'], finish: 'grain' },
        iris: { finish: 'chalk' },
        dusk: { opacity: 0.01 },
        prism: ['#112233', '#445566'],
      }),
    ).toEqual({
      ember: { colors: ['#112233', '#445566'] },
      moss: { colors: ['#112233', '#445566'], finish: 'grain' },
      dusk: { opacity: 0.2 },
    });
    expect(presetWithOverride(GRADIENT_PRESETS.dusk, { opacity: 0.5 }).opacity).toBe(0.5);
    expect(normalizePresetOverrides(undefined)).toEqual({});
  });

  test('Shuffle rolls a new shape, a finish and colours, never the same shape twice', () => {
    let seed = 3;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    let current = DEFAULT_CUSTOM_WALLPAPER;
    const shapes = new Set<string>();
    const finishes = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const next = randomCustomWallpaper(current, random);
      expect(next.pattern).not.toBe(current.pattern);
      expect(normalizeCustomWallpaper(next)).toEqual(next);
      shapes.add(next.pattern);
      finishes.add(next.finish);
      current = next;
    }
    expect(shapes.size).toBe(8);
    expect(finishes.size).toBe(2);
  });

  test('gradient wallpapers start at 50% opacity', () => {
    expect(DEFAULT_CUSTOM_WALLPAPER.opacity).toBe(0.5);
    expect(normalizeCustomWallpaper(undefined).opacity).toBe(0.5);
    for (const preset of Object.values(GRADIENT_PRESETS)) expect(preset.opacity).toBeUndefined();
  });
});

