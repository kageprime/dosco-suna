import { describe, expect, test } from 'bun:test';
import { agentDisplayName } from './agent-mark';

describe('agentDisplayName', () => {
  test('humanizes a slug: separators become spaces, the first letter is capitalized', () => {
    expect(agentDisplayName('session-reviewer')).toBe('Session reviewer');
  });

  test('the centralized platform agent displays as Dot', () => {
    expect(agentDisplayName('mykortix')).toBe('Dot');
    expect(agentDisplayName('dot')).toBe('Dot');
  });

  test('default workspace agent displays as Dot', () => {
    expect(agentDisplayName('xera')).toBe('Dot');
    expect(agentDisplayName('worker')).toBe('Dot');
    expect(agentDisplayName('kortix')).toBe('Dot');
  });

  test('a truthy non-string slug from model tool input degrades to a label, never throws (KRTX-4511)', () => {
    expect(agentDisplayName(42 as unknown as string)).toBe('42');
    expect(agentDisplayName({ name: 'explorer' } as unknown as string)).toBe(
      String({ name: 'explorer' }),
    );
  });
});
