import { describe, expect, test } from 'bun:test';
import { pruneRequiredConnectors } from '@kortix/ui/customize/sections/view/connectors-personal';

describe('pruneRequiredConnectors', () => {
  test('keeps entries that are still granted', () => {
    expect(pruneRequiredConnectors(['gmail'], ['gmail', 'slack'])).toEqual(['gmail']);
  });

  test('drops an entry whose grant was just removed', () => {
    expect(pruneRequiredConnectors(['gmail', 'slack'], ['gmail'])).toEqual(['gmail']);
  });

  test("an 'all' grant keeps everything", () => {
    expect(pruneRequiredConnectors(['gmail', 'slack'], 'all')).toEqual(['gmail', 'slack']);
  });

  test('clearing the grant clears the required set', () => {
    expect(pruneRequiredConnectors(['gmail'], 'none')).toBeUndefined();
    expect(pruneRequiredConnectors(['gmail'], [])).toBeUndefined();
    expect(pruneRequiredConnectors(['gmail'], undefined)).toBeUndefined();
  });

  test('returns undefined (not []) so the key is omitted from the YAML', () => {
    expect(pruneRequiredConnectors(['slack'], ['gmail'])).toBeUndefined();
    expect(pruneRequiredConnectors([], ['gmail'])).toBeUndefined();
    expect(pruneRequiredConnectors(undefined, ['gmail'])).toBeUndefined();
  });
});
