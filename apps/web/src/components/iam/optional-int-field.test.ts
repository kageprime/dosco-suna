import { describe, expect, test } from 'bun:test';

import { parseOptionalIntField, toField } from './optional-int-field';

/**
 * The settings panel's two lifetime forms (session minutes, key-rules days)
 * share this parser; the table pins the three rules and the cap edge both
 * forms assert. The messages here are plain strings — the forms build theirs
 * from their own catalog keys and pass them in, so the parser stays free of
 * the translator.
 *
 * Carries every case of the two former per-form parser tests
 * (session-controls-card.test.ts, key-rules-card.test.ts) verbatim.
 */
describe('parseOptionalIntField', () => {
  const messages = {
    notInteger: 'Use a whole number, or leave it empty.',
    overMax: '730 is the most Kortix allows.',
  };
  const parse = (raw: string, max = 730) => parseOptionalIntField(raw, max, messages);

  test('blank means no limit, not an error', () => {
    expect(parse('')).toEqual({ ok: true, value: null });
    expect(parse('   ')).toEqual({ ok: true, value: null });
  });

  test('a whole number comes through as a number', () => {
    expect(parse('60')).toEqual({ ok: true, value: 60 });
    expect(parse(' 480 ')).toEqual({ ok: true, value: 480 });
  });

  test('accepts the cap exactly', () => {
    expect(parse('10080', 10080)).toEqual({ ok: true, value: 10080 });
    expect(parse('730')).toEqual({ ok: true, value: 730 });
  });

  test('rejects anything that is not a whole positive number, with the form\u2019s sentence', () => {
    for (const raw of ['0', '-5', '1.5', 'sixty', '9e2x', 'NaN', 'ninety']) {
      const result = parse(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('Use a whole number, or leave it empty.');
      }
    }
  });

  test('rejects a value past the cap, naming it', () => {
    const result = parse('10081', 10080);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('730 is the most Kortix allows.');
    }
  });
});

describe('toField', () => {
  test('null and undefined render as an empty field', () => {
    expect(toField(null)).toBe('');
    expect(toField(undefined)).toBe('');
  });

  test('zero and a value render as the number', () => {
    expect(toField(0)).toBe('0');
    expect(toField(10080)).toBe('10080');
  });
});
