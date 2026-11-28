import { describe, expect, test } from 'bun:test';
import {
  dictationInsert,
  formatElapsed,
  levelFromRms,
  microphoneProblem,
  pickRecordingType,
  pushLevel,
} from './dictation-state';

describe('pickRecordingType', () => {
  test('prefers WebM/Opus, falls back to MP4 on Safari, and to the browser default', () => {
    expect(pickRecordingType((t) => t.startsWith('audio/webm'))).toBe('audio/webm;codecs=opus');
    expect(pickRecordingType((t) => t === 'audio/mp4')).toBe('audio/mp4');
    expect(pickRecordingType(() => false)).toBe('');
    expect(pickRecordingType(() => { throw new Error('old browser'); })).toBe('');
  });
});

describe('levelFromRms', () => {
  test('maps silence to 0, speech into the meter, and clips loud input at 1', () => {
    expect(levelFromRms(0)).toBe(0);
    expect(levelFromRms(0.0005)).toBe(0); // about -66 dBFS
    expect(levelFromRms(0.03)).toBeGreaterThan(0.2); // normal speech
    expect(levelFromRms(0.03)).toBeLessThan(0.6);
    expect(levelFromRms(1)).toBe(1);
    expect(levelFromRms(Number.NaN)).toBe(0);
  });
});

test('pushLevel keeps the newest bars only', () => {
  expect(pushLevel([0.1, 0.2], 0.3, 2)).toEqual([0.2, 0.3]);
  expect(pushLevel([], 0.5, 3)).toEqual([0.5]);
});

test('formatElapsed writes m:ss', () => {
  expect(formatElapsed(0)).toBe('0:00');
  expect(formatElapsed(7_900)).toBe('0:07');
  expect(formatElapsed(65_000)).toBe('1:05');
  expect(formatElapsed(600_000)).toBe('10:00');
});

describe('dictationInsert', () => {
  test('adds a space after a word, none after whitespace or at the start', () => {
    expect(dictationInsert('d', 'open the session')).toBe(' open the session');
    expect(dictationInsert(' ', 'open the session')).toBe('open the session');
    expect(dictationInsert('', '  open the session ')).toBe('open the session');
  });
  test('joins leading punctuation and drops an empty transcript', () => {
    expect(dictationInsert('d', ', then deploy')).toBe(', then deploy');
    expect(dictationInsert('d', '   ')).toBe('');
  });
});

test('microphoneProblem names the refusal from getUserMedia', () => {
  expect(microphoneProblem({ name: 'NotAllowedError' })).toBe('denied');
  expect(microphoneProblem({ name: 'NotFoundError' })).toBe('missing');
  expect(microphoneProblem({ name: 'NotReadableError' })).toBe('busy');
  expect(microphoneProblem(new Error('x'))).toBe('unsupported');
});
