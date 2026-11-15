import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { InlineCodeText, plainTextFromMarkdown, shortSummary, splitInlineCode } from './inline-code-text';

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

describe('plainTextFromMarkdown', () => {
  test('drops code-span backticks and keeps the code', () => {
    expect(plainTextFromMarkdown('curates `.kortix/memory/` — the `memory-reflector` trigger')).toBe(
      'curates .kortix/memory/ — the memory-reflector trigger',
    );
  });

  test('keeps link and image text, drops the URL', () => {
    expect(plainTextFromMarkdown('See [the guide](https://example.test/a) and ![a logo](x.png).')).toBe(
      'See the guide and a logo.',
    );
  });

  test('drops emphasis markers', () => {
    expect(plainTextFromMarkdown('**Bold**, *italic*, _also_ and ~~gone~~')).toBe('Bold, italic, also and gone');
  });

  test('keeps underscores and asterisks that are not emphasis', () => {
    expect(plainTextFromMarkdown('set memory_reflector to 2 * 3')).toBe('set memory_reflector to 2 * 3');
  });

  test('does not strip markers inside a code span', () => {
    expect(plainTextFromMarkdown('run `**not bold**`')).toBe('run **not bold**');
  });

  test('collapses line breaks to one line', () => {
    expect(plainTextFromMarkdown('first line\n\nsecond   line ')).toBe('first line second line');
  });
});

describe('shortSummary', () => {
  test('keeps the first sentence only', () => {
    expect(shortSummary('Route `code` work. Then a long second sentence.')).toBe('Route code work.');
  });

  test('caps a long first sentence with an ellipsis', () => {
    const out = shortSummary('a'.repeat(400));
    expect(out).toHaveLength(160);
    expect(out.endsWith('…')).toBe(true);
  });
});
