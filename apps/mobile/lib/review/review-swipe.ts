/**
 * Which verdict each swipe gives on a review item, in the Review page's card
 * deck (web: `packages/ui/src/workspace/review/review-swipe.ts`). Right is
 * the item's yes, left its no. On a change or an output, no is "send it
 * back": the person writes what should change and the agent gets it. A decision needs a chosen option, so it takes
 * no swipe: its card opens the detail sheet.
 *
 * Pure data: unit-tested under `bun test`.
 */
import type { ReviewItemKind, ReviewVerdict } from '@kortix/sdk';

export interface ReviewSwipeVerdicts {
  right: ReviewVerdict | null;
  left: ReviewVerdict | null;
}

const SWIPE_VERDICTS: Record<ReviewItemKind, ReviewSwipeVerdicts> = {
  change: { right: 'approve', left: 'changes' },
  approval: { right: 'approve', left: 'reject' },
  output: { right: 'approve', left: 'changes' },
  batch: { right: 'approve', left: 'dismiss' },
  decision: { right: null, left: null },
};

export function reviewSwipeVerdicts(kind: ReviewItemKind): ReviewSwipeVerdicts {
  return SWIPE_VERDICTS[kind];
}
