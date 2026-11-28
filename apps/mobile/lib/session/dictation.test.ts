import { describe, expect, test } from 'bun:test';

import {
  DICTATION_BAR_COUNT,
  dictationDraft,
  dictationFailure,
  levelFromMetering,
  pushLevel,
} from './dictation';

describe('dictationDraft', () => {
  test('an empty draft takes the transcript as is', () => {
    expect(dictationDraft('', 'hello')).toBe('hello');
  });

  test('a space separates the transcript from typed text', () => {
    expect(dictationDraft('Fix', 'the login bug')).toBe('Fix the login bug');
  });

  test('no extra space after existing whitespace or a newline', () => {
    expect(dictationDraft('Fix ', 'it')).toBe('Fix it');
    expect(dictationDraft('Line one\n', 'two')).toBe('Line one\ntwo');
  });

  test('no transcript leaves the draft untouched', () => {
    expect(dictationDraft('Fix', '')).toBe('Fix');
    expect(dictationDraft('Fix', '   ')).toBe('Fix');
  });
});

describe('levelFromMetering', () => {
  test('silence and room noise are 0', () => {
    expect(levelFromMetering(-160)).toBe(0);
    expect(levelFromMetering(-60)).toBe(0);
  });

  test('a loud voice is full height', () => {
    expect(levelFromMetering(-10)).toBe(1);
    expect(levelFromMetering(0)).toBe(1);
  });

  test('normal speech moves the bars visibly, quieter is lower', () => {
    expect(levelFromMetering(-30)).toBeGreaterThan(0.5);
    expect(levelFromMetering(-45)).toBeGreaterThan(0);
    expect(levelFromMetering(-45)).toBeLessThan(levelFromMetering(-30));
  });

  test('a missing or invalid reading is 0', () => {
    expect(levelFromMetering(undefined)).toBe(0);
    expect(levelFromMetering(null)).toBe(0);
    expect(levelFromMetering(Number.NaN)).toBe(0);
  });
});

describe('pushLevel', () => {
  test('keeps the newest DICTATION_BAR_COUNT samples, newest last', () => {
    let h: number[] = [];
    for (let i = 0; i < DICTATION_BAR_COUNT + 5; i++) h = pushLevel(h, i);
    expect(h.length).toBe(DICTATION_BAR_COUNT);
    expect(h[h.length - 1]).toBe(DICTATION_BAR_COUNT + 4);
    expect(h[0]).toBe(5);
  });
});

describe('dictationFailure', () => {
  test('a cancelled upload is silent', () => {
    expect(dictationFailure({ name: 'AbortError' })).toBeNull();
  });

  test('an empty wallet says so, offers Billing and no Retry', () => {
    const f = dictationFailure({ status: 402, code: 'insufficient_credits' });
    expect(f?.message).toBe('Out of credits. Top up to keep dictating.');
    expect(f?.billing).toBe(true);
    expect(f?.retry).toBe(false);
  });

  test('a spending limit is not a top-up', () => {
    const f = dictationFailure({ status: 402, code: 'budget_exceeded' });
    expect(f?.billing).toBeUndefined();
    expect(f?.retry).toBe(false);
  });

  test('busy and rate-limited clips can be retried', () => {
    expect(dictationFailure({ status: 429, code: 'rate_limit_exceeded' })).toEqual({
      message: 'Dictation is busy. Try again in a moment.',
      retry: true,
    });
    expect(dictationFailure({ status: 503, code: 'dictation_busy' })?.retry).toBe(true);
  });

  test('a server without dictation and a rejected clip are not retried', () => {
    expect(dictationFailure({ status: 503, code: 'dictation_unavailable' })?.retry).toBe(false);
    expect(dictationFailure({ status: 415, code: 'unsupported_audio' })?.retry).toBe(false);
    expect(dictationFailure({ status: 413, code: 'audio_too_large' })?.retry).toBe(false);
  });

  test('a network failure or server error keeps the clip for Retry', () => {
    expect(dictationFailure(new TypeError('Network request failed'))?.retry).toBe(true);
    expect(dictationFailure({ status: 503, code: 'dictation_failed' })?.retry).toBe(true);
    expect(dictationFailure({ status: 500 })?.retry).toBe(true);
  });
});
