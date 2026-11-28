/**
 * Which verdict each swipe gives on a review item, in the card deck of the
 * Review page. Right is the item's yes, left its no. A decision needs a
 * chosen option, so it takes no swipe: its card opens the detail.
 *
 * - change, output: right approves (a change merges), left sends it back:
 *   the person writes what should change and the agent gets it (`changes`).
 *   Closing a change stays in its detail.
 * - approval: right approves, left denies.
 * - batch: right approves, left dismisses.
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
