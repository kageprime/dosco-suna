import { describe, expect, test } from 'bun:test';
import { planReviewVerdict } from './review-verdict';
import { reviewSwipeVerdicts } from './review-swipe';

describe('reviewSwipeVerdicts', () => {
  test('a change merges right and goes back to its agent with the note left', () => {
    const { right, left } = reviewSwipeVerdicts('change');
    expect(planReviewVerdict('cr:synthetic', right!)).toEqual({ call: 'merge', changeRequestId: 'synthetic' });
    expect(planReviewVerdict('cr:synthetic', left!, 'Make the title shorter')).toEqual({
      call: 'request_changes',
      changeRequestId: 'synthetic',
      feedback: 'Make the title shorter',
    });
  });

  test('an output goes back to its agent with the note left', () => {
    expect(reviewSwipeVerdicts('output').left).toBe('changes');
  });

  test('a connector call approves right and denies left', () => {
    const { right, left } = reviewSwipeVerdicts('approval');
    expect(planReviewVerdict('call:synthetic', right!)).toEqual({
      call: 'resolve_approval',
      executionId: 'synthetic',
      decision: 'approve',
    });
    expect(planReviewVerdict('call:synthetic', left!)).toEqual({
      call: 'resolve_approval',
      executionId: 'synthetic',
      decision: 'deny',
    });
  });

  test('a decision takes no swipe', () => {
    expect(reviewSwipeVerdicts('decision')).toEqual({ right: null, left: null });
  });
});
