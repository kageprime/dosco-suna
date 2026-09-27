import { describe, expect, test } from 'bun:test';

import { easyWorkState } from './project-home-easy';

describe('easyWorkState', () => {
  test('waiting wins over running (needs-you is the human call to action)', () => {
    expect(easyWorkState({ status: 'running', needs_you: true })).toBe('waiting');
    expect(easyWorkState({ status: 'running', awaiting_input: true })).toBe('waiting');
    expect(easyWorkState({ status: 'done', pending_approval: true })).toBe('waiting');
  });

  test('running without a human flag is working', () => {
    expect(easyWorkState({ status: 'running' })).toBe('working');
  });

  test('unknown or empty shapes read as done, never crash', () => {
    expect(easyWorkState({ status: 'complete' })).toBe('done');
    expect(easyWorkState({ status: 'mystery-future-state' })).toBe('done');
    expect(easyWorkState({})).toBe('done');
    expect(easyWorkState({ status: null })).toBe('done');
  });
});
