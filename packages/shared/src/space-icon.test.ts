import { describe, expect, test } from 'bun:test';
import { isProjectGlyphColor, isProjectGlyphName } from './project-glyphs';
import { SPACE_ICON_FALLBACK_GLYPHS, SPACE_ICON_STEM_GLYPHS, suggestSpaceIcon } from './space-icon';

describe('suggestSpaceIcon', () => {
  test('every glyph it can return is in the catalogue', () => {
    for (const [glyph] of SPACE_ICON_STEM_GLYPHS) expect(isProjectGlyphName(glyph)).toBe(true);
    for (const glyph of SPACE_ICON_FALLBACK_GLYPHS) expect(isProjectGlyphName(glyph)).toBe(true);
  });

  test('a stem appears under one glyph only', () => {
    const seen = new Map<string, string>();
    for (const [glyph, stems] of SPACE_ICON_STEM_GLYPHS) {
      for (const stem of stems) {
        expect(seen.get(stem) ?? glyph).toBe(glyph);
        seen.set(stem, glyph);
      }
    }
  });

  test.each([
    ['Marketing', 'Megaphone'],
    ['Q3 sales pipeline', 'Handshake'],
    ['Backend', 'Code'],
    ['Design system', 'Palette'],
    ['Finance & budgets', 'CurrencyDollar'],
    ['Customer support', 'Headset'],
    ['AI agents', 'Robot'],
    ['Hiring', 'Users'],
    ['Research', 'MagnifyingGlass'],
    ['ProductRoadmap', 'Cube'],
  ] as const)('%s -> %s', (name, glyph) => {
    expect(suggestSpaceIcon(name).glyph.name).toBe(glyph);
  });

  test('a short stem matches only the whole word', () => {
    // `ai` must not match `aid`; `ui` must not match `build`.
    expect(suggestSpaceIcon('Aid').glyph.name).not.toBe('Robot');
    expect(suggestSpaceIcon('Build').glyph.name).not.toBe('Palette');
  });

  test('the same name gives the same icon, in any case or padding', () => {
    expect(suggestSpaceIcon('  Marketing ')).toEqual(suggestSpaceIcon('marketing'));
  });

  test('an unmatched name gets a catalogue glyph and a colour that is not grey', () => {
    const icon = suggestSpaceIcon('Zzyzx');
    expect(isProjectGlyphName(icon.glyph.name)).toBe(true);
    expect(isProjectGlyphColor(icon.glyph.color)).toBe(true);
    expect(icon.glyph.color).not.toBe('grey');
  });
});
