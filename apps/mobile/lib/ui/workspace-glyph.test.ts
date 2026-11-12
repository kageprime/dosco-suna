import { describe, expect, test } from 'bun:test';

import { workspaceGlyphColor, workspaceGlyphWash } from './workspace-glyph';

describe('workspaceGlyphColor', () => {
  test('a preset takes its theme value, as web', () => {
    expect(workspaceGlyphColor('blue', false)).toBe('hsl(213 74% 53%)');
    expect(workspaceGlyphColor('blue', true)).toBe('hsl(213 83% 66%)');
  });

  test("a custom #rrggbb is the workspace's own colour in both themes", () => {
    expect(workspaceGlyphColor('#12ab34', false)).toBe('#12ab34');
    expect(workspaceGlyphColor('#12ab34', true)).toBe('#12ab34');
  });

  test('an unknown value (stale cache) is grey', () => {
    expect(workspaceGlyphColor('chartreuse', false)).toBe('hsl(220 6% 45%)');
  });
});

describe('workspaceGlyphWash', () => {
  const withAlpha = (hsl: string, a: number) => `${hsl}@${a}`;
  test('a preset goes through withAlpha', () => {
    expect(workspaceGlyphWash('hsl(213 74% 53%)', 0.14, withAlpha)).toBe('hsl(213 74% 53%)@0.14');
  });
  test('a custom hex takes the alpha byte (never through withAlpha, which reads only hsl)', () => {
    expect(workspaceGlyphWash('#12ab34', 0.2, withAlpha)).toBe('#12ab3433');
  });
});
