import { describe, expect, test } from 'bun:test';

import { threadAsJson, threadAsMarkdown, threadAsText, threadEntries } from './thread-export';

const messages = [
  { info: { role: 'user', time: { created: Date.UTC(2026, 10, 25, 23, 55) } }, parts: [{ type: 'text', text: 'Make a synthetic agent.' }] },
  {
    info: { role: 'assistant', time: { created: Date.UTC(2026, 10, 25, 23, 56) } },
    parts: [
      { type: 'reasoning', text: 'hidden' },
      { type: 'text', text: 'system notice', synthetic: true },
      { type: 'tool', tool: 'bash' },
      { type: 'text', text: 'I propose a **designer** agent.' },
    ],
  },
  { info: { role: 'assistant' }, parts: [{ type: 'tool', tool: 'read' }] },
];
const names = { person: 'Synthetic Person', agent: 'My Kortix' };

describe('thread export', () => {
  test('keeps each message with words: its author, time and text; tools, reasoning and notices stay out', () => {
    expect(threadEntries(messages, names)).toEqual([
      { role: 'person', author: 'Synthetic Person', created_at: '2026-11-25T23:55:00.000Z', text: 'Make a synthetic agent.' },
      { role: 'agent', author: 'My Kortix', created_at: '2026-11-25T23:56:00.000Z', text: 'I propose a **designer** agent.' },
    ]);
  });

  test('text, Markdown and JSON', () => {
    const entries = threadEntries(messages, names);
    expect(threadAsText(entries)).toBe('Synthetic Person: Make a synthetic agent.\n\nMy Kortix: I propose a **designer** agent.');
    expect(threadAsMarkdown(entries, 'New agent').startsWith('# New agent\n\n**Synthetic Person** · 2026-11-25T23:55:00.000Z\n\nMake a synthetic agent.')).toBe(true);
    expect(JSON.parse(threadAsJson(entries, { sessionId: 'ses_synthetic', title: 'New agent' }))).toEqual({
      session_id: 'ses_synthetic',
      title: 'New agent',
      messages: entries,
    });
  });
});
