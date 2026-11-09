/**
 * The snippet highlighter, held to the one promise that outranks its colours:
 * the spans it produces must still spell the exact snippet.
 *
 * A wrapper author copies these blocks into an editor and runs them. Colouring
 * that drops a brace, eats a space or reorders a line would turn a teaching
 * surface into a broken call. Each host app's panel test runs this contract
 * over the corpus that app can actually produce; this suite pins the
 * highlighter's own invariants over hand-written and malformed sources.
 */

import { describe, expect, test } from 'bun:test';
import { type SnippetLanguage, highlight } from '../src/syntax-highlight';

const LANGUAGES: SnippetLanguage[] = ['ts', 'json', 'http'];

function joined(code: string, language: SnippetLanguage): string {
  return highlight(code, language)
    .map((token) => token.text)
    .join('');
}

describe('input it does not understand degrades to plain text', () => {
  const MALFORMED = [
    '',
    ' ',
    '\n',
    '\n\n\n',
    "const a = 'unterminated",
    'const a = "unterminated\nconst b = 2;',
    'const a = `unterminated template',
    '/* unterminated block comment',
    '}}}}',
    '{"a": ',
    '{"a": "b",,,}',
    '{"unterminated key: 1}',
    '"\\',
    ':::',
    '\\',
    'GET',
    'GET ',
    ' /v1/usage',
    'not a request line at all',
    'POST /v1/x\nNoColonHeader\n\n{"a":1}',
    'POST /v1/x\n\n',
    'POST /v1/x\n\nnot json {',
    'héllo — “curly” ‘quotes’ 🙂',
    ' ',
  ];

  test('nothing throws, and the text always comes back whole', () => {
    for (const source of MALFORMED) {
      for (const language of LANGUAGES) {
        expect(() => highlight(source, language)).not.toThrow();
        expect(joined(source, language)).toBe(source);
      }
    }
  });

  test('an empty block produces no spans at all', () => {
    for (const language of LANGUAGES) {
      expect(highlight('', language)).toEqual([]);
    }
  });

  test('an unterminated quote mis-colours one line, not the rest of the block', () => {
    const source = "const a = 'oops;\nconst b = 2;";
    const tokens = highlight(source, 'ts');
    expect(tokens.map((token) => token.text).join('')).toBe(source);
    // `const` on the SECOND line is still a keyword, so the runaway string
    // stopped at the newline.
    expect(tokens.filter((token) => token.kind === 'keyword').length).toBe(2);
  });
});

describe('it stays linear', () => {
  test('a very long single line is scanned once', () => {
    // 400k characters of the shapes each scanner branches on. A backtracking
    // pattern would not finish; a single forward pass is milliseconds.
    const source = `${'const x = "abc" + 12345; // note\n'.repeat(10_000)}${'{'.repeat(50_000)}`;
    const started = Date.now();
    const tokens = highlight(source, 'ts');
    expect(tokens.map((token) => token.text).join('')).toBe(source);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test('a long unterminated string does not blow up either', () => {
    const source = `{"a": "${'x'.repeat(200_000)}`;
    const started = Date.now();
    expect(joined(source, 'json')).toBe(source);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('the three languages are told apart', () => {
  test('TypeScript colours keywords, strings and comments', () => {
    const source = [
      "import { generateSessionId } from '@kortix/sdk';",
      '',
      '// The session id is generated, never typed.',
      'const sessionId = generateSessionId();',
    ].join('\n');
    const tokens = highlight(source, 'ts');
    const kindOf = (text: string) => tokens.find((token) => token.text === text)?.kind;
    expect(kindOf('import')).toBe('keyword');
    expect(kindOf('from')).toBe('keyword');
    expect(kindOf('const')).toBe('keyword');
    expect(kindOf("'@kortix/sdk'")).toBe('string');
    expect(tokens.some((token) => token.kind === 'comment' && token.text.startsWith('//'))).toBe(
      true,
    );
  });

  test('a TypeScript object literal separates its keys from its values', () => {
    const tokens = highlight("kortix.send('hi', { agent: 'support' });", 'ts');
    expect(tokens.find((token) => token.text === 'agent')?.kind).toBe('property');
    expect(tokens.find((token) => token.text === "'support'")?.kind).toBe('string');
  });

  test('JSON separates keys, string values, numbers and literals', () => {
    const source = JSON.stringify(
      { agent_name: 'support', inherit_unbound: true, retries: 3, note: null },
      null,
      2,
    );
    const tokens = highlight(source, 'json');
    const kindOf = (text: string) => tokens.find((token) => token.text === text)?.kind;
    expect(kindOf('"agent_name"')).toBe('property');
    expect(kindOf('"support"')).toBe('string');
    expect(kindOf('true')).toBe('keyword');
    expect(kindOf('3')).toBe('number');
    expect(kindOf('null')).toBe('keyword');
    // A key and a value that read the same must NOT colour the same.
    const same = highlight('{"a": "a"}', 'json').filter((token) => token.text === '"a"');
    expect(same.map((token) => token.kind)).toEqual(['property', 'string']);
  });
});
