import { describe, expect, test } from 'bun:test';

import { slugifySlug } from '@kortix/manifest-schema';
import { agentDisplayName } from '@kortix/shared';

import { createAgentPrompt, createAgentTitle } from './create-agent-modal';

describe('My Kortix agent creation defaults', () => {
  for (const start of ['describe', 'blank', 'duplicate'] as const) {
    test(`${start} declares a hidden subagent even when copying a primary`, () => {
      const prompt = createAgentPrompt({
        start,
        name: 'helper-copy',
        description: '  Summarize synthetic reports.  ',
        from: { name: 'primary-worker', path: 'agents/primary-worker.md' },
      });
      expect(prompt).toContain('`mode: subagent`');
      expect(prompt).toContain('`hidden: true`');
      expect(prompt).toContain('until I promote it');
      expect(prompt).toContain('Then open a change request');
      if (start === 'duplicate') {
        expect(prompt).toContain('copy of the "primary-worker" agent');
        expect(prompt).toContain('`agents/primary-worker.md`');
        expect(prompt).toContain('description "Summarize synthetic reports."');
      }
    });
  }
});

// Settings audit 2026-11-14, finding 08: the typed name is kept as `title`.
describe('a new agent keeps the name a person typed', () => {
  const typed = 'GitHub PR Reviewer';
  const slug = slugifySlug(typed, '');

  test('the key is the slug; the preview reads the typed name', () => {
    expect(slug).toBe('github-pr-reviewer');
    const title = createAgentTitle(typed, slug);
    expect(title).toBe('GitHub PR Reviewer');
    expect(agentDisplayName(slug, title)).toBe('GitHub PR Reviewer');
  });

  test('the prompt asks for the title and keeps the key', () => {
    for (const start of ['describe', 'blank'] as const) {
      const prompt = createAgentPrompt({ start, name: slug, title: createAgentTitle(typed, slug), description: '' });
      expect(prompt).toContain('named "github-pr-reviewer"');
      expect(prompt).toContain('`title: "GitHub PR Reviewer"`');
    }
    const copy = createAgentPrompt({ start: 'duplicate', name: slug, title: 'GitHub PR Reviewer', description: '', from: { name: 'a', path: 'kortix.yaml' } });
    expect(copy).toContain('`title: "GitHub PR Reviewer"`');
  });

  test('a name that already reads as its key adds no title', () => {
    expect(createAgentTitle('Market scan', 'market-scan')).toBeNull();
    expect(createAgentTitle('  ', '')).toBeNull();
    expect(createAgentPrompt({ start: 'blank', name: 'market-scan', title: null, description: '' })).not.toContain('title:');
  });

  test('a quote in the name is written as a valid YAML string', () => {
    const prompt = createAgentPrompt({ start: 'blank', name: 'say-hi', title: 'Say "hi"', description: '' });
    expect(prompt).toContain('`title: "Say \\"hi\\""`');
  });
});
