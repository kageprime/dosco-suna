import { describe, expect, test } from 'bun:test';
import { displayAgentName } from './agent-display-name';

describe('displayAgentName', () => {
  test('maps the built-in kortix agent to Xera', () => {
    expect(displayAgentName('kortix')).toBe('Xera');
  });

  test('capitalizes any other agent name unchanged', () => {
    expect(displayAgentName('build')).toBe('Build');
    expect(displayAgentName('code-reviewer')).toBe('Code-Reviewer');
  });
});
