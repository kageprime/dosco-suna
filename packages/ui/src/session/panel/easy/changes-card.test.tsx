import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { ChangesSection } from './changes-card';

const file = (path: string, additions = 3, deletions = 1, status?: 'added' | 'modified' | 'deleted') => ({
  file: path,
  additions,
  deletions,
  status,
});
const noop = () => {};

describe('ChangesSection', () => {
  test('one row per changed file: name, folder, and line delta', () => {
    const html = renderToStaticMarkup(
      <ChangesSection files={[file('notes/alpha.md', 12, 0), file('README.md', 1, 2)]} onOpenDetail={noop} onOpenAll={noop} />,
    );
    expect(html).toContain('alpha.md');
    expect(html).toContain('>notes<');
    expect(html).toContain('README.md');
    expect(html).toContain('+12');
    expect(html).toContain('−2');
    // A side that did not move is not printed: alpha.md only added lines.
    expect(html).not.toContain('−0');
    // Two files fit: no hand-off row to the full comparison.
    expect(html).not.toContain('Review changes');
  });

  test('past five files the last row hands off to the full comparison with the hidden count', () => {
    const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => file(`notes/${n}.md`));
    const html = renderToStaticMarkup(<ChangesSection files={files} onOpenDetail={noop} onOpenAll={noop} />);
    expect(html).toContain('e.md');
    expect(html).not.toContain('f.md');
    // The hand-off row names the action, then the hidden count.
    const handOff = html.indexOf('Review changes');
    expect(handOff).toBeGreaterThan(-1);
    // The hidden-file count is a CountBadge after the label, not a "+2" line delta.
    expect(html.indexOf('>2</span>', handOff)).toBeGreaterThan(handOff);
    expect(html.slice(handOff)).not.toContain('+2');
  });

  test('a removed file says so: the destructive status dot, labeled', () => {
    const html = renderToStaticMarkup(
      <ChangesSection files={[file('notes/golf.md', 0, 4, 'deleted'), file('notes/hotel.md', 3, 0, 'added')]} onOpenDetail={noop} onOpenAll={noop} />,
    );
    const golf = html.slice(html.indexOf('data-status="deleted"'));
    expect(golf).toContain('aria-label="Removed"');
    expect(html).toContain('data-status="added"');
    expect(html).toContain('aria-label="Added"');
  });
});
