import { describe, expect, test } from 'bun:test';
import { displayAgentName } from './agent-display-name';

describe('displayAgentName', () => {
  test('maps the built-in kortix agent to Dosco', () => {
    expect(displayAgentName('kortix')).toBe('Dosco');
  });

  test('capitalizes any other agent name unchanged', () => {
    expect(displayAgentName('build')).toBe('Build');
    expect(displayAgentName('code-reviewer')).toBe('Code-Reviewer');
  });
});
