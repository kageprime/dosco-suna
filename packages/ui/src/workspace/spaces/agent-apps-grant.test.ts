import { describe, expect, test } from 'bun:test';

import { toggleGrant } from './agent-apps-grant';

const slugs = ['gmail', 'github', 'slack'];

describe('toggleGrant', () => {
  test('turning one off under all lists every other connector', () => {
    expect(toggleGrant('all', slugs, 'github', false)).toEqual(['gmail', 'slack']);
  });

  test('turning one on adds it once', () => {
    expect(toggleGrant(['gmail'], slugs, 'slack', true)).toEqual(['gmail', 'slack']);
    expect(toggleGrant(['gmail'], slugs, 'gmail', true)).toEqual(['gmail']);
  });

  test('a list of every connector stays a list, so a later connector is not granted', () => {
    expect(toggleGrant(['gmail', 'github'], slugs, 'slack', true)).toEqual(['gmail', 'github', 'slack']);
  });

  test('turning the last one off leaves none', () => {
    expect(toggleGrant(['gmail'], slugs, 'gmail', false)).toEqual([]);
  });
});
