import { describe, expect, test } from 'bun:test';
import { drivePath } from './drive.ts';

describe('kortix drive paths', () => {
  test('a path in Files is absolute', () => {
    expect(drivePath('Agents/sales/x.md', '/Users/ana')).toBe('/Agents/sales/x.md');
    expect(drivePath('/Users/ana/x.md', '/Users/ana')).toBe('/Users/ana/x.md');
  });

  test('~ is the caller’s own folder (My files), with or without a rest', () => {
    expect(drivePath('~', '/Users/ana')).toBe('/Users/ana');
    expect(drivePath('~/From sessions/Lisbon facts/lisbon-facts.md', '/Users/ana')).toBe(
      '/Users/ana/From sessions/Lisbon facts/lisbon-facts.md',
    );
  });

  test('~ without an own folder is an error that says so, never a path at the top of Files', () => {
    expect(() => drivePath('~/x.md', null)).toThrow('You have no folder of your own in Files');
  });

  test('a name that only starts with ~ is a plain name', () => {
    expect(drivePath('~notes.md', '/Users/ana')).toBe('/~notes.md');
  });
});
