import { describe, expect, test } from 'bun:test';

import { agentDisplayName } from './my-kortix-agent';

describe('agentDisplayName', () => {
  test('a title is shown as written, trimmed', () => {
    expect(agentDisplayName('github-pr-reviewer', 'GitHub PR Reviewer')).toBe('GitHub PR Reviewer');
    expect(agentDisplayName('github-pr-reviewer', '  GitHub PR Reviewer  ')).toBe('GitHub PR Reviewer');
  });

  test('no title, a null or a blank title: the slug in sentence case, as before', () => {
    expect(agentDisplayName('github-pr-reviewer')).toBe('Github pr reviewer');
    expect(agentDisplayName('github-pr-reviewer', null)).toBe('Github pr reviewer');
    expect(agentDisplayName('session_reviewer', '   ')).toBe('Session reviewer');
  });

  test('My Kortix keeps its name whatever the title says', () => {
    expect(agentDisplayName('mykortix', 'Something else')).toBe('My Kortix');
  });
});
