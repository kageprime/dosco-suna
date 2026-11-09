import { describe, expect, test } from 'bun:test';
import { errorMessage } from './error-message';

describe('errorMessage', () => {
  test('an Error yields its message', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  test('a string yields itself', () => {
    expect(errorMessage('plain failure')).toBe('plain failure');
  });

  test('null yields "null"', () => {
    expect(errorMessage(null)).toBe('null');
  });

  test('an object with a message that is not an Error yields its string form', () => {
    expect(errorMessage({ message: 'shaped like an error' })).toBe('[object Object]');
  });
});
