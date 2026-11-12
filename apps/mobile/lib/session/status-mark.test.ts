import { describe, expect, test } from 'bun:test';

import { statusMarkGlyph } from './status-mark';

// Web parity: packages/ui/src/session/list/session-status-mark.tsx.
describe('statusMarkGlyph', () => {
  test('the agent acts: green', () => {
    expect(statusMarkGlyph('running')).toEqual({ glyph: 'working', tone: 'green' });
    expect(statusMarkGlyph('done')).toEqual({ glyph: 'ready', tone: 'green' });
  });

  test('you act: blue, a question for an answer and a diff for a review', () => {
    expect(statusMarkGlyph('needs-you', 'answer')).toEqual({ glyph: 'question', tone: 'blue' });
    expect(statusMarkGlyph('needs-you', 'review')).toEqual({ glyph: 'review', tone: 'blue' });
    expect(statusMarkGlyph('needs-you')).toEqual({ glyph: 'review', tone: 'blue' });
  });

  test('broken: a red ring with a core', () => {
    expect(statusMarkGlyph('failed')).toEqual({ glyph: 'ring-core', tone: 'red' });
  });

  test('nobody acts: grey; starting draws the stopped ring', () => {
    expect(statusMarkGlyph('stopped')).toEqual({ glyph: 'ring', tone: 'muted' });
    expect(statusMarkGlyph('starting')).toEqual({ glyph: 'ring', tone: 'muted' });
    expect(statusMarkGlyph('legacy')).toEqual({ glyph: 'legacy', tone: 'muted' });
  });
});
