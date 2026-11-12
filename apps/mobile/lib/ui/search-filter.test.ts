import { describe, expect, test } from 'bun:test';

import { filterByQuery, matchesQuery, noResultsLabel, normalizeQuery } from './search-filter';

describe('search-filter', () => {
  test('normalizeQuery trims and lower-cases', () => {
    expect(normalizeQuery('  Api_KEY ')).toBe('api_key');
    expect(normalizeQuery('   ')).toBe('');
  });

  test('matchesQuery is a case-insensitive substring match over any field', () => {
    expect(matchesQuery('key', ['OPENAI_API_KEY'])).toBe(true);
    expect(matchesQuery('DASH', ['dashboard', null])).toBe(true);
    expect(matchesQuery('dash', [undefined, 'my-dashboard'])).toBe(true);
    expect(matchesQuery('zzz', ['dashboard', 'dash'])).toBe(false);
    expect(matchesQuery('', [])).toBe(true);
  });

  test('filterByQuery returns the same array for an empty query', () => {
    const items = [{ name: 'A' }, { name: 'B' }];
    expect(filterByQuery(items, '  ', (i) => [i.name])).toBe(items);
    expect(filterByQuery(items, 'b', (i) => [i.name])).toEqual([{ name: 'B' }]);
  });

  test('noResultsLabel quotes the trimmed query', () => {
    expect(noResultsLabel(' sales ')).toBe('No results for "sales"');
  });
});
