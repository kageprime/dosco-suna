/**
 * status-mark — which glyph and colour a session's display status draws
 * (`SessionStatusMark`). The table is web's
 * (`packages/ui/src/session/list/session-status-mark.tsx`): colour says who
 * acts — green the agent, blue you, red broken, grey nobody.
 *
 * Pure data: unit-tested under `bun test` (`status-mark.test.ts`).
 */

import type { SessionDisplayStatus } from '@/lib/session/session-list';
import type { NeedsYouWaitingOn } from '@/lib/session/needs-you';

export type StatusMarkGlyph = 'working' | 'ready' | 'question' | 'review' | 'ring' | 'ring-core' | 'legacy';
export type StatusMarkTone = 'green' | 'blue' | 'red' | 'muted';

export function statusMarkGlyph(
  status: SessionDisplayStatus,
  waitingOn: NeedsYouWaitingOn = 'review',
): { glyph: StatusMarkGlyph; tone: StatusMarkTone } {
  switch (status) {
    case 'running':
      return { glyph: 'working', tone: 'green' };
    case 'done':
      return { glyph: 'ready', tone: 'green' };
    case 'needs-you':
      return { glyph: waitingOn === 'answer' ? 'question' : 'review', tone: 'blue' };
    case 'failed':
      return { glyph: 'ring-core', tone: 'red' };
    case 'legacy':
      return { glyph: 'legacy', tone: 'muted' };
    case 'starting':
    case 'stopped':
    default:
      return { glyph: 'ring', tone: 'muted' };
  }
}
