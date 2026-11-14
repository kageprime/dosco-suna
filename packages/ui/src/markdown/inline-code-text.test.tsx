import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { InlineCodeText, splitInlineCode } from './inline-code-text';

describe('splitInlineCode', () => {
  test('splits text and code spans', () => {
    expect(splitInlineCode('a `b` c')).toEqual([
      { kind: 'text', value: 'a ' },
      { kind: 'code', value: 'b' },
      { kind: 'text', value: ' c' },
    ]);
  });

  test('keeps an unmatched backtick as text', () => {
    expect(splitInlineCode('curates`.kortix/memory/')).toEqual([{ kind: 'text', value: 'curates`.kortix/memory/' }]);
  });

  test('reads a double-backtick span', () => {
    expect(splitInlineCode('run `` a`b `` now')).toEqual([
      { kind: 'text', value: 'run ' },
      { kind: 'code', value: 'a`b' },
      { kind: 'text', value: ' now' },
    ]);
  });

  test('mismatched backtick runs stay text', () => {
    expect(splitInlineCode('Use ``foo` now')).toEqual([{ kind: 'text', value: 'Use ``foo` now' }]);
  });

  test('plain text is one segment', () => {
    expect(splitInlineCode('no code here')).toEqual([{ kind: 'text', value: 'no code here' }]);
  });
});

describe('InlineCodeText', () => {
  test('renders code spans without backticks', () => {
    const html = renderToStaticMarkup(<InlineCodeText text="A file named exactly `dsa-b-goal.txt` exists" />);
    expect(html).not.toContain('`');
    expect(html).toMatch(/<code[^>]*>dsa-b-goal\.txt<\/code>/);
  });
});
