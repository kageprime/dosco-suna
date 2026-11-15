import { describe, expect, test } from 'bun:test';
import { driveEntryDisplayName, driveRelativeDisplayCrumbs, spaceSlug } from './space-slug';

describe('spaceSlug', () => {
  test('lowercases and joins words with one dash', () => {
    expect(spaceSlug('  Design   Reviews ')).toBe('design-reviews');
  });

  test('drops characters outside a-z, 0-9 and dash', () => {
    expect(spaceSlug('Q4 launch! (EU)')).toBe('q4-launch-eu');
  });

  test('collapses dash runs and trims dashes at both ends', () => {
    expect(spaceSlug('--a -- b--')).toBe('a-b');
  });

  test('is empty for a name with no letter or digit', () => {
    expect(spaceSlug('!!! ???')).toBe('');
  });

  test('cuts at 40 characters and trims a trailing dash left by the cut', () => {
    const slug = spaceSlug(`${'a'.repeat(39)} b`);
    expect(slug).toBe('a'.repeat(39));
    expect(spaceSlug('x'.repeat(60))).toHaveLength(40);
  });
});

describe('driveEntryDisplayName', () => {
  test('renders mykortix agent and memory folders as Xera', () => {
    expect(driveEntryDisplayName('/Users/Jesse Nathaniel/Agents/mykortix', 'mykortix')).toBe('Xera');
    expect(driveEntryDisplayName('Users/Jesse Nathaniel/Memory/mykortix')).toBe('Xera');
    expect(driveEntryDisplayName('/Users/ana/Agents/meta')).toBe('Xera');
    expect(driveEntryDisplayName('/Users/ana/Memory/dot')).toBe('Xera');
  });

  test('leaves other agent, memory, and subfolder names unchanged', () => {
    expect(driveEntryDisplayName('/Users/ana/Agents/worker', 'worker')).toBe('worker');
    expect(driveEntryDisplayName('/Users/ana/Memory/company', 'company')).toBe('company');
    expect(driveEntryDisplayName('/Users/ana/Agents/mykortix/notes.md', 'notes.md')).toBe('notes.md');
    expect(driveEntryDisplayName('/Company/mykortix', 'mykortix')).toBe('mykortix');
  });

  test('formats nested breadcrumb trails under a personal root as Xera', () => {
    expect(
      driveRelativeDisplayCrumbs('My files', '/Users/ana/Agents/mykortix/drafts', '/Users/ana'),
    ).toEqual(['My files', 'Agents', 'Xera', 'drafts']);
    expect(driveRelativeDisplayCrumbs('All files', '/Users/ana/Memory/mykortix')).toEqual([
      'All files',
      'Users',
      'ana',
      'Memory',
      'Xera',
    ]);
  });
});
